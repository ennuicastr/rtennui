// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2021-2023 Yahweasel
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

declare let VideoEncoder: any, VideoFrame: any, MediaStreamTrackProcessor: any;

// Our codec->system support matrix
const codecSupport: Record<string, string> = Object.create(null);
let codecSupportArr: string[] | null = null;

/**
 * General interface for any video capture subsystem, user-implementable. Video
 * capture captures *encoded* video chunks, so is also responsible for
 * encoding.
 *
 * Events:
 * * data(EncodedVideoChunk): A video frame is available and encoded.
 */
export abstract class VideoCapture extends events.EventEmitter {
    constructor() {
        super();
    }

    /**
     * Degrade or enhance this capture. Returns whether the
     * degredation/enhancement was actually possible.
     * @param enhancement  Degree of degrading or enhancement. Not especially
     *                     precise, but choose a value less than 1 to degrade,
     *                     greater than 1 to enhance.
     */
    abstract grade(enhancement: number): boolean;

    /**
     * Stop this video capture and remove any underlying data.
     */
    abstract close(): void;

    /**
     * "Tee" this capture into the number of receivers specified.
     * @param ct  Number of duplicates to make.
     */
    tee(ct: number): VideoCapture[] {
        let closeCt = 0;

        const onclose = () => {
            if (++closeCt === ct)
                this.close();
        };

        const started = {started: false};
        const ret = Array(ct).fill(null).map(() => new VideoCaptureTee(this));

        for (const tee of ret)
            tee.onclose = onclose;

        this.on("data", data => {
            for (const tee of ret)
                tee.emitEvent("data", data);
        });

        return ret;
    }

    /**
     * Get the width of video frames from this capture.
     */
    abstract getWidth(): number;

    /**
     * Get the height of video frames from this capture.
     */
    abstract getHeight(): number;

    /**
     * Get the framerate of this capture.
     */
    abstract getFramerate(): number;
}

/**
 * Tee'd video capture.
 */
export class VideoCaptureTee extends VideoCapture {
    constructor(private _base: VideoCapture) {
        super();
    }

    override grade(enhancement: number): boolean {
        return this._base.grade(enhancement);
    }

    override close() {
        if (this.onclose)
            this.onclose();
    }

    override getWidth() {
        return this._base.getWidth();
    }

    override getHeight() {
        return this._base.getHeight();
    }

    override getFramerate() {
        return this._base.getFramerate();
    }

    onclose?: () => void;
}

/**
 * Video capture using WebCodecs. This is *incomplete*, and needs a VideoFrame
 * source to actually capture video. The VideoFrame sources are in subclasses.
 */
class VideoCaptureWebCodecs extends VideoCapture {
    constructor(
        /**
         * The input MediaStream.
         */
        private _ms: MediaStream,

        /**
         * The configuration to use.
         */
        private _config: wcp.VideoEncoderConfig
    ) {
        super();

        // Get the framerate
        const settings = _ms.getVideoTracks()[0].getSettings();
        this._framerate = settings.frameRate;

        // Get the initial width and height
        let width = _config.width;
        let height = _config.height;

        if (!width || !height) {
            // Set the width and height from the input
            width = settings.width;
            height = settings.height;
        }

        if (_config.codec === "vp8lo") {
            /* "vp8lo" really just means "VP8, but be gentle for software
             * decoders" */
            _config.codec = "vp8";
            width = this._width =
                Math.round(this._width / this._height * 360 / 8) * 8;
            height = this._height = 360;
        }

        this._width = _config.width = width;
        this._height = _config.height = height;

        // A single promise for synchronizing things
        this._p = Promise.all([]);
    }

    async initEncoder() {
        const config = this._config;

        // Set the scalability mode
        for (const mode of ["L1T3", "L1T2", "L1T1", void 0]) {
            config.scalabilityMode = mode;
            try {
                const support = await VideoEncoder.isConfigSupported(config);
                if (support.supported)
                    break;
            } catch (ex) { /* just try the next mode */ }
        }

        this._videoEncoder = new VideoEncoder({
            output: x => this.onChunk(x),
            error: x => this.onError(x)
        });
        await this._videoEncoder.configure(config);
        this._forceKeyframe = this._framerate * 2;
    }

    override grade(enhancement: number): boolean {
        const newConfig = Object.assign({}, this._config);
        const width = this.getWidth();
        const height = this.getHeight();

        // Adjust the height
        newConfig.height *= enhancement;
        if (newConfig.height < height && newConfig.height < 360)
            newConfig.height = 360;
        else if (newConfig.height > height)
            newConfig.height = height;
        newConfig.height = Math.round(newConfig.height / 8) * 8;
        if (newConfig.height === this._config.height)
            return false;

        // Adjust the width and bitrate to match
        newConfig.width = Math.round((newConfig.height / height) * width / 8) * 8;
        newConfig.bitrate = newConfig.height * 2500;

        // End the old video encoder
        try {
            this._videoEncoder.close();
        } catch (ex) {}

        // And start the new one
        this._config = newConfig;
        this._p = this._p.then(() => this.initEncoder()).catch(console.error);
        return true;
    }

    /**
     * To be called by a subclass when frames are available.
     */
    onFrame(frame: wcp.VideoFrame) {
        if (!this._videoEncoder || this._videoEncoder.state !== "configured")
            return;

        let kf = false;
        this._forceKeyframe--;
        if (this._forceKeyframe <= 0) {
            kf = true;
            this._forceKeyframe = this._framerate * 2;
        }
        this._videoEncoder.encode(frame, {keyFrame: kf});
        frame.close();
    }

    override close(): void {
        this._videoEncoder.close();
    }

    override getWidth(): number {
        return this._width;
    }

    override getHeight(): number {
        return this._height;
    }

    override getFramerate(): number {
        return this._framerate;
    }

    /**
     * Called when there's output data.
     */
    onChunk(chunk: wcp.EncodedVideoChunk) {
        this.emitEvent("data", chunk);
    }

    /**
     * Called when there's an error.
     */
    onError(ex: any) {
        console.error(ex);
    }

    // When to next force a keyframe
    private _forceKeyframe: number;

    // Nominal video width
    private _width: number;

    // Nominal video height
    private _height: number;

    // Video framerate
    private _framerate: number;

    // Video encoder
    private _videoEncoder: wcp.VideoEncoder;

    // Shared promise
    private _p: Promise<unknown>;
}

/**
 * Video capture using WebCodecs and MediaStreamTrackProcessor.
 */
class VideoCaptureWCMSTP extends VideoCaptureWebCodecs {
    constructor(ms: MediaStream, config: wcp.VideoEncoderConfig) {
        super(ms, config);

        this._mstp = new MediaStreamTrackProcessor({
            track: ms.getVideoTracks()[0]
        });

        this._reader = this._mstp.readable.getReader();
    }

    async init() {
        await this.initEncoder();

        // Shuttle frames in the background
        (async () => {
            while (true) {
                const {done, value} = await this._reader.read();
                if (done)
                    break; // FIXME
                this.onFrame(value);
            }
        })();
    }

    override close(): void {
        this._reader.cancel();
        super.close();
    }

    private _mstp: any;

    private _reader: ReadableStreamDefaultReader<wcp.VideoFrame>;
}

/**
 * Video capture using WebCodecs and a Video element.
 */
class VideoCaptureWCVidEl extends VideoCaptureWebCodecs {
    constructor(ms: MediaStream, config: wcp.VideoEncoderConfig) {
        super(ms, config);

        // The actual video stream in the source
        const settings = ms.getVideoTracks()[0].getSettings();

        // Create the <video> that will play the source
        const video = this._video = document.createElement("video");
        video.width = settings.width;
        video.height = settings.height;
        video.style.display = "none";
        video.defaultMuted = video.muted = true;
        video.srcObject = ms;
        document.body.appendChild(video);
    }

    async init() {
        await this.initEncoder();

        // Play the video
        const video = this._video;
        video.play().catch(console.error);

        // Timestamp management
        let ts = 0;
        const fr = this.getFramerate();
        const tsStep = Math.round(1000000 / fr);

        // Start our capture
        this._interval = setInterval(() => {
            let frame: wcp.VideoFrame = null;
            try {
                frame = new VideoFrame(video, {
                    timestamp: ts
                });
            } catch (ex) {}
            if (!frame)
                return;
            ts += tsStep;
            this.onFrame(frame);
        }, ~~(1000 / fr));
    }

    override close(): void {
        clearInterval(this._interval);
        try {
            this._video.pause();
        } catch (ex) {}
        try {
            this._video.parentNode.removeChild(this._video);
        } catch (ex) {}
        super.close();
    }

    private _video: HTMLVideoElement;
    private _interval: number;
}

/**
 * Video capture using MediaRecorder.
 */
class VideoCaptureMediaRecorder extends VideoCapture {
    constructor(
        /**
         * The media stream to capture.
         */
        private _ms: MediaStream,

        /**
         * The WebCodecs configuration to approximate.
         */
        private _config: wcp.VideoEncoderConfig
    ) {
        super();

        // Convert the codec string
        this._codec = "" + _config.codec;
        if (/^vp09/.test("" + _config.codec))
            this._codec = "vp9";
        else if (/^vp8/.test("" + _config.codec))
            this._codec = "vp8";

        // And bitrate
        this._bitrate = _config.bitrate || _config.height * 2500;

        // Framerate isn't yet known
        this._framerate = 0;

        // Global synchronization promise
        this._p = Promise.all([]);
    }

    async init(): Promise<void> {
        // Create the MediaRecorder
        this._mr = new MediaRecorder(this._ms, {
            mimeType: `video/webm; codecs=${this._codec}`,
            videoBitsPerSecond: this._bitrate
        });

        // Create the libav.js instance
        const libav = this._libav = await LibAV.LibAV();

        // Prepare the data transit
        await libav.mkreaderdev("in");

        let tmpData: Uint8Array[] = [];
        let dataPromise = <Promise<unknown>> Promise.all([]);
        this._mr.ondataavailable = ev => {
            dataPromise = dataPromise.then(async () => {
                const ab = await ev.data.arrayBuffer();
                tmpData.push(new Uint8Array(ab));
                libav.ff_reader_dev_send("in", new Uint8Array(ab));
            }).catch(console.error);
        };
        this._mr.onstop = ev => {
            dataPromise = dataPromise.then(() => {
                const blob = new File(tmpData, "tmp.webm", {type: "application/octet-stream"});
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                document.body.appendChild(a);

                libav.ff_reader_dev_send("in", null);
            });
        };

        this._mr.start(1);

        // Prepare the reader
        const [fmt_ctx, [stream]] =
            await libav.ff_init_demuxer_file("in");
        const pkt = await libav.av_packet_alloc();

        // Read three frames to get the framerate
        {
            // First frame: just discarded as possibly non-representative
            await libav.ff_read_multi(fmt_ctx, pkt, null, {
                limit: 1,
                unify: false
            });

            // Second frame: time ref one
            const [res1, packets1] =
                await libav.ff_read_multi(fmt_ctx, pkt, null, {
                    limit: 1,
                    unify: false
                });

            // Third frame: time ref two
            const [res2, packets2] =
                await libav.ff_read_multi(fmt_ctx, pkt, null, {
                    limit: 1,
                    unify: false
                });

            // Default is from the data
            this._framerate =
                this._ms.getVideoTracks()[0].getSettings().frameRate;
            if (packets1 && packets1[stream.index] &&
                packets2 && packets2[stream.index]) {
                // Calculate our framerate
                const packets =
                    packets1[stream.index].concat(packets2[stream.index]);
                const pts1 =
                    packets[0].pts * stream.time_base_num / stream.time_base_den;
                const pts2 =
                    packets[1].pts * stream.time_base_num / stream.time_base_den;
                const fr = 1 / (pts2 - pts1);
                if (fr && Number.isFinite(fr))
                    this._framerate = fr;
            }
        }

        // And read data in the background
        (async () => {
            let beforeFirstKeyframe = true;
            while (true) {
                const [res, packets] =
                    await libav.ff_read_multi(fmt_ctx, pkt, null, {
                        limit: 1,
                        unify: false
                    });

                if (res !== 0 && res !== -libav.EAGAIN) {
                    // Read error! FIXME
                    break;
                }

                if (packets[stream.index]) {
                    // Transit these packets
                    for (const packet of packets[stream.index]) {
                        const key = !!(packet.flags & 1);
                        if (beforeFirstKeyframe) {
                            if (key)
                                beforeFirstKeyframe = false;
                            else
                                continue;
                        }

                        /* Because MediaRecorder is free to use altref frames
                         * and other mandatory frames, we have to mark
                         * everything as a keyframe. If the decoder comes in
                         * late, it may fail to decode, so the decoder has to be
                         * robust against mismarked frames. Ideally, we would
                         * just have two bits for keyframe-ness, but really,
                         * ideally, we wouldn't be using MediaRecorder :) */
                        const evc = new LibAVWebCodecs.EncodedVideoChunk({
                            data: packet.data,
                            type: "key",
                            timestamp: 0
                        });
                        this.emitEvent("data", evc);
                    }
                }

                if (res === 0 || res === -libav.AVERROR_EOF)
                    break;
            }

            libav.terminate();
        })();
    }

    override grade(enhancement: number): boolean {
        // All we can change with MediaRecorder is the bitrate
        const newConfig = Object.assign({}, this._config);
        const height = newConfig.height;

        newConfig.bitrate *= enhancement;
        if (newConfig.bitrate < 360 * 2500) // lowest allowed bitrate
            newConfig.bitrate = 360 * 2500;
        else if (newConfig.bitrate > height * 2500)
            newConfig.bitrate = height * 2500;
        if (newConfig.bitrate === this._config.bitrate)
            return false;

        // OK, we changed the bitrate. Stop the old media recorder...
        try {
            this._mr.stop();
        } catch (ex) {}

        // And make a new one
        this._p = this._p.then(() => this.init()).catch(console.error);

        return true;
    }

    override close(): void {
        this._mr.stop();
        // libav will terminate itself
    }

    override getWidth(): number {
        return this._ms.getVideoTracks()[0].getSettings().width;
    }

    override getHeight(): number {
        return this._ms.getVideoTracks()[0].getSettings().height;
    }

    override getFramerate(): number {
        return this._framerate;
    }

    // Current codec as a MediaRecorder name
    private _codec: string;

    // Current bitrate
    private _bitrate: number;

    // The MediaRecorder instance
    private _mr: MediaRecorder;

    // The LibAV instance
    private _libav: libavT.LibAV;

    // The framerate, detected from the data
    private _framerate: number;

    // Synchronization promise
    private _p: Promise<unknown>;
}

/**
 * Get our codec support list (and also create it if needed).
 */
export async function codecSupportList(): Promise<string[]> {
    if (codecSupportArr)
        return codecSupportArr;

    const cs = codecSupport;
    const csl = codecSupportArr = [];

    if (typeof VideoEncoder !== "undefined") {
        let cap = "wcvidel";
        if (typeof MediaStreamTrackProcessor !== "undefined")
            cap = "wcmstp";

        // Check for what's supported by VideoEncoder
        for (const codecDesc of videoCodecs.codecs) {
            const codec = codecDesc.webCodecs;
            if (cs[codec])
                continue;
            try {
                const support = await VideoEncoder.isConfigSupported({
                    codec, width: 640, height: 480
                });
                if (support.supported) {
                    cs[codec] = cap;
                    csl.push(codec);
                    if (codec === "vp8") {
                        /* "vp8lo" is just vp8 but low-res, for software
                         * decoders */
                        cs.vp8lo = cap;
                        csl.push("vp8lo");
                    }
                }
            } catch (ex) {}
        }
    }

    if (typeof MediaRecorder !== "undefined") {
        // Check what's supported by MediaRecorder
        for (const codecDesc of videoCodecs.codecs) {
            const mrCodec = codecDesc.mediaRecorder;
            const wcCodec = codecDesc.webCodecs;
            if (!mrCodec)
                continue;
            if (cs[wcCodec])
                continue;
            try {
                if (MediaRecorder.isTypeSupported(`video/webm; codecs=${mrCodec}`)) {
                    cs[wcCodec] = "mr";
                    csl.push(wcCodec);
                }
            } catch (ex) {}
        }
    }

    return csl;
}

/**
 * Create an appropriate video capture from a MediaStream.
 */
export async function createVideoCapture(
    ms: MediaStream, config: wcp.VideoEncoderConfig
): Promise<VideoCapture> {
    switch (codecSupport["" + config.codec]) {
        case "wcmstp":
        {
            const ret = new VideoCaptureWCMSTP(ms, config);
            await ret.init();
            return ret;
        }

        case "wcvidel":
        {
            const ret = new VideoCaptureWCVidEl(ms, config);
            await ret.init();
            return ret;
        }

        case "mr":
        {
            const ret = new VideoCaptureMediaRecorder(ms, config);
            await ret.init();
            return ret;
        }

        default:
            throw new Error(`Unsupported codec ${config.codec}!`);
    }
}
