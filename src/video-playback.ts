// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2021-2024 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

import * as events from "./events";
import * as videoCodecs from "./video-codecs";

import type * as libavT from "libav.js";
declare let LibAV: libavT.LibAVWrapper;
import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

declare let VideoDecoder: any;

// Our codec->system support matrix
const codecSupport: Record<string, string> = Object.create(null);
let codecSupportArr: string[] | null = null;

/**
 * General interface for any video playback subsystem.
 */
export abstract class VideoPlayback extends events.EventEmitter {
    constructor() {
        super();
    }

    /**
     * Does this video playback provide its own decoding?
     */
    selfDecoding(): boolean { return false; }

    /**
     * Display this frame. For internal use only.
     * @param frame  Frame to display. If this VideoPlayback is self-decoding
     *               (see selfDecoding), this *must* be an EncodedVideoChunk.
     *               If this VideoPlayback is not self-decoding, this *must* be
     *               a VideoFrame.
     */
    abstract display(
        frame: wcp.VideoFrame | wcp.EncodedVideoChunk
    ): Promise<void>;

    /**
     * Get the underlying HTML element.
     */
    abstract element(): HTMLElement;

    /**
     * Stop this video playback and remove any underlying data.
     */
    abstract close(): void;
}

/**
 * Playback by painting on a canvas.
 */
export class VideoPlaybackVideoDecoderCanvas extends VideoPlayback {
    constructor() {
        super();
        const canvasBox = this._canvasBox = document.createElement("div");
        const canvas = this._canvas = document.createElement("canvas");

        Object.assign(canvasBox.style, {
            overflow: "hidden",
            position: "relative"
        });
        canvas.style.position = "absolute";
        canvasBox.appendChild(canvas);

        // Find the best context
        const ctxib = this._ctxib = canvas.getContext("bitmaprenderer");
        if (ctxib)
            this._ctx2d = null;
        else
            this._ctx2d = canvas.getContext("2d");

        this._iw = this._ih = this._sl = this._st = this._sw = this._sh =
            this._ow = this._oh = 0;
    }

    override async display(frameX: wcp.VideoFrame | wcp.EncodedVideoChunk) {
        const frame = <wcp.VideoFrame> frameX;
        const canvasBox = this._canvasBox;
        const canvas = this._canvas;

        if (!canvas.parentNode || canvasBox.offsetWidth === 0 || canvasBox.offsetHeight === 0) {
            // Not visible, don't draw
            return;
        }

        // Perhaps adjust the size
        let changedSize = false;

        if (canvasBox.offsetWidth !== this._ow ||
            canvasBox.offsetHeight !== this._oh) {
            const w = this._ow = canvasBox.offsetWidth;
            canvas.width = ~~w;
            const h = this._oh = canvasBox.offsetHeight;
            canvas.height = ~~h;
            if (this._ctx2d)
                this._ctx2d.clearRect(0, 0, w, h);
            changedSize = true;
        }

        if (frame.displayWidth !== this._iw ||
            frame.displayHeight !== this._ih) {
            this._iw = frame.displayWidth;
            this._ih = frame.displayHeight;
            changedSize = true;
        }

        if (changedSize) {
            const iw = this._iw, ih = this._ih, ow = this._ow, oh = this._oh;
            const iar = this._iw / this._ih, oar = this._ow / this._oh;

            if (iar === oar) {
                // Same aspect ratio
                this._sl = this._st = 0;
                this._sw = ow;
                this._sh = oh;

            } else if (iar > oar) {
                // Input wider. Adjust the top position.
                const sh = this._sh = Math.round(ow / iw * ih);
                this._st = ~~((oh - sh) / 2);
                this._sl = 0;
                this._sw = ow;

            } else {
                // Input taller. Adjust the left position.
                const sw = this._sw = Math.round(oh / ih * iw);
                this._sl = ~~((ow - sw) / 2);
                this._st = 0;
                this._sh = oh;

            }

            if (this._ctxib) {
                // Top/left has to be done with padding
                const st = this._st, sl = this._sl;
                canvas.style.padding = `${st}px 0px 0px ${sl}px`;
                canvas.width = this._sw;
                canvas.height = this._sh;
            }
        }

        // Convert
        const image = await LibAVWebCodecs.createImageBitmap(frame, {
            resizeWidth: this._sw,
            resizeHeight: this._sh
        });

        // And draw
        if (this._ctxib)
            this._ctxib.transferFromImageBitmap(image);
        else
            this._ctx2d!.drawImage(image, this._sl, this._st);
        image.close();
    }

    override element() {
        return this._canvasBox;
    }

    override close() {
        // Nothing to close here
    }

    /**
     * A box to contain the canvas (the element actually given to the user).
     */
    private _canvasBox: HTMLElement;

    /**
     * The canvas used to display.
     */
    private _canvas: HTMLCanvasElement;

    /**
     * The ImageBitmap context for the canvas, if applicable.
     */
    private _ctxib: ImageBitmapRenderingContext | null;

    /**
     * The 2D context for the canvas.
     */
    private _ctx2d: CanvasRenderingContext2D | null;

    private _iw: number;
    private _ih: number;
    private _sl: number;
    private _st: number;
    private _sw: number;
    private _sh: number;
    private _ow: number;
    private _oh: number;
}

/**
 * Playback by a video element with a MediaSource from the raw input data.
 */
class VideoPlaybackMediaSource extends VideoPlayback {
    constructor(
        private _codec: string,
        private _width: number,
        private _height: number
    ) {
        super();

        // Create the MediaSource and its source buffer
        this._ms = new MediaSource();

        // Create our video element to play it
        this._el = document.createElement("video");

        this._sb = null;
        this._libav = null;
        this._closed = false;

        this._oc = this._pb = this._pts = this._pkt = 0;
    }

    /**
     * A VideoPlaybackMediaSource must be initialized.
     */
    async init() {
        // Start playing
        this._el.src = URL.createObjectURL(this._ms);

        // Create a SourceBuffer (when possible)
        if (this._ms.readyState !== "open") {
            await new Promise(
                res => this._ms.addEventListener("sourceopen", res));
        }
        this._sb = this._ms.addSourceBuffer(`video/webm; codecs=${this._codec}`);
        //this._sb.mode = "sequence";

        this._el.play();
        /*
        this._el.addEventListener("stalled", async ev => {
            if (!this._closed)
                return;
            this._el.pause();
            await new Promise(res => setTimeout(res, 1000));
            this._el.play();
        });
        */

        // Create our libav instance
        const libav = this._libav = await LibAV.LibAV();
        libav.onwrite = (fn, pos, buf) => this.onLibAVWrite(buf);
        await libav.mkstreamwriterdev("output");

        // Create a codecpar with just enough information to make our header
        const codecpar = await libav.avcodec_parameters_alloc();
        const desc = await libav.avcodec_descriptor_get_by_name(this._codec);
        await libav.AVCodecParameters_codec_type_s(
            codecpar, libav.AVMEDIA_TYPE_VIDEO);
        await libav.AVCodecParameters_codec_id_s(
            codecpar, await libav.AVCodecDescriptor_id(desc));
        await libav.AVCodecParameters_format_s(
            codecpar, libav.AV_PIX_FMT_YUV420P);
        await libav.AVCodecParameters_width_s(
            codecpar, this._width);
        await libav.AVCodecParameters_height_s(
            codecpar, this._height);

        // Then make the muxer
        let streams: any;
        [this._oc, , this._pb, streams] = await libav.ff_init_muxer({
            format_name: "webm",
            filename: "output",
            open: true,
            codecpars: true
        }, [[codecpar, 1, 1000]]);
        /*
        await libav.AVFormatContext_flags_s(
            this._oc, await libav.AVFormatContext_flags(this._oc) |
            libav.AVFMT_FLAG_NOBUFFER | libav.AVFMT_FLAG_FLUSH_PACKETS);
        */
        await libav.avformat_write_header(this._oc, 0);
        this._pts = 1;

        // And a packet for transit
        this._pkt = await libav.av_packet_alloc();
    }

    override selfDecoding(): boolean { return true; }

    override async display(frameX: wcp.VideoFrame | wcp.EncodedVideoChunk) {
        if (this._closed)
            return;

        const frame = <wcp.EncodedVideoChunk> frameX;

        // Get out the data
        const data = new Uint8Array(frame.byteLength);
        frame.copyTo(data.buffer);

        // Make a libav.js packet
        const pts = this._pts++;
        const packet: libavT.Packet = {
            data,
            pts,
            ptshi: 0,
            dts: pts,
            dtshi: 0,
            flags: (frame.type === "key") ? 1 : 0,
            stream_index: 0
        };

        // And write it
        const libav = this._libav!;
        await libav.ff_write_multi(this._oc, this._pkt, [packet], false);
        await libav.avio_flush(this._pb);
    }

    override element(): HTMLElement {
        return this._el;
    }

    override close(): void {
        if (this._closed)
            return;
        this._closed = true;
        this._libav!.terminate();
        this._ms.endOfStream();
    }

    // Called when libav outputs muxed data
    private onLibAVWrite(buf: Uint8Array | Int8Array) {
        this._sb!.appendBuffer(buf.buffer);
    }

    private _closed: boolean;

    private _ms: MediaSource;

    private _sb: SourceBuffer | null;

    private _el: HTMLVideoElement;

    private _libav: libavT.LibAV | null;

    private _oc: number;
    private _pb: number;
    private _pts: number;
    private _pkt: number;
}

/**
 * Get our codec support list (and also create it if needed).
 */
export async function codecSupportList(): Promise<string[]> {
    if (codecSupportArr)
        return codecSupportArr;

    const cs = codecSupport;
    const csl: string[] = codecSupportArr = [];

    if (typeof VideoDecoder !== "undefined") {
        // Check for what's supported *directly* by VideoDecoder
        for (const codecDesc of videoCodecs.codecs) {
            const codec = codecDesc.webCodecs;
            try {
                const support = await VideoDecoder.isConfigSupported({codec});
                if (support.supported) {
                    cs[codec] = "vd";
                    csl.push(codec);
                    if (codec === "vp8") {
                        /* "vp8lo" is just vp8 but low-res, for software
                         * decoders */
                        cs.vp8lo = "vd";
                        csl.push("vp8lo");
                    }
                }
            } catch (ex) {}
        }
    }

    // Check if libavjs-webcodecs-polyfill supports vp8 in software
    if (!cs.vp8) {
        try {
            const support = await LibAVWebCodecs.VideoDecoder.isConfigSupported({
                codec: "vp8"
            });
            if (support.supported) {
                cs.vp8lo = "vd";
                csl.push("vp8lo");
            }
        } catch (ex) {}
    }

    // We only check for VP8 with MediaSource
    if (!cs.vp8 && !cs.vp8lo &&
        typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported("video/webm; codecs=vp8")) {
        cs.vp8 = cs.vp8lo = "ms";
        csl.push("vp8");
        csl.push("vp8lo");
    }

    return csl;
}

/**
 * Create a supported VideoPlayback.
 * @param codec  Codec to display. Only used by self-decoding VideoPlaybacks,
 *               but the caller won't know whether a self-decoding
 *               VideoPlayback will be used, so this should always be set.
 * @param width  Width of the input video. Again only used by self-decoding
 *               VideoPlaybacks.
 * @param height  Height of the input video. Again only used by self-decoding
 *                VideoPlaybacks.
 */
export async function createVideoPlayback(
    codec: string, width: number, height: number
): Promise<VideoPlayback | null> {
    switch (codecSupport[codec]) {
        case "vd":
            return new VideoPlaybackVideoDecoderCanvas();

        case "ms":
        {
            const ret = new VideoPlaybackMediaSource(codec, width, height);
            await ret.init();
            return ret;
        }

        default:
            return null;
    }
}
