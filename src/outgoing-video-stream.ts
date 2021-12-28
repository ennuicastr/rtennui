/*
 * Copyright (c) 2021 Yahweasel
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

import * as videoCapture from "./video-capture";
import * as events from "./events";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

/**
 * An outgoing video stream.
 *
 * Events:
 * * data(VideoFrame): Emitted when a video frame is ready.
 * * error(DOMException): Emitted when an error occurs.
 *
 * @private
 */
export class OutgoingVideoStream extends events.EventEmitter {
    constructor(
        public capture: videoCapture.VideoCapture
    ) {
        super();
        this.format = null;
        this._ct = 0;
        this._ifreq = 0;
    }

    /**
     * Initialize this outgoing video stream and start it generating video.
     * @private
     * @param format  Video format.
     */
    async init(format: string) {
        // Our video encoder configuration
        let w = this.capture.getWidth();
        let h = this.capture.getHeight();
        const fr = this.capture.getFramerate();
        this._ifreq = ~~(fr * 2);
        this.format = format;

        // Convert to WebCodecs
        let codec: any;
        if (format === "vh263.2") {
            codec = {libavjs:{
                codec: "h263p",
                ctx: {
                    pix_fmt: 0,
                    width: w,
                    height: h,
                    framerate_num: ~~fr,
                    framerate_den: 1,
                    bit_rate: h * 2500,
                    bit_ratehi: 0
                }
            }};
        } else {
            codec = format.slice(1);
        }

        const config: wcp.VideoEncoderConfig = {
            codec,
            width: w,
            height: h,
            framerate: fr,
            bitrate: h * 2500,
            latencyMode: "realtime"
        };

        // Create our VideoEncoder
        const env = this._env =
            await LibAVWebCodecs.getVideoEncoder(config);
        this.capture.VideoFrame = env.VideoFrame;

        // If we're using the polyfill, don't go above 360p
        if (env.VideoEncoder === LibAVWebCodecs.VideoEncoder) {
            if (h > 360) {
                w = Math.round((w / h) * 360 / 8) * 8;
                h = 360;
                config.width = w;
                config.height = h;
                config.bitrate = h * 2500;
                if (codec.libavjs) {
                    codec.libavjs.ctx.width = w;
                    codec.libavjs.ctx.height = h;
                    codec.libavjs.bit_rate = h * 2500;
                }
            }
        }

        const encoder = this._encoder =
            new env.VideoEncoder({
                output: data => {
                    this.emitEvent("data", data);
                },
                error: error => {
                    this.emitEvent("error", error);
                }
            });

        // Configure it
        await encoder.configure(config);

        // Hook it up
        this.capture.on("data", data => this._oninput(data));
    }

    /**
     * Close this stream.
     * @private
     */
    async close() {
        this.capture.close();

        if (!this._encoder)
            return;

        await this._encoder.flush();
        this._encoder.close();
        this._encoder = null;
    }

    /**
     * Input from the video capture.
     */
    private _oninput(data: wcp.VideoFrame) {
        if (!this._encoder || this._encoder.encodeQueueSize > 1)
            return;
        let key = false;
        if (++this._ct >= this._ifreq) {
            this._ct = 0;
            key = true;
        }
        this._encoder.encode(data, {keyFrame: key});
        data.close();
    }

    /**
     * Format used.
     * @private
     */
    format: string;

    /**
     * Number of frames encoded since the last keyframe.
     */
    private _ct: number;

    /**
     * Number of frames per keyframe.
     */
    private _ifreq: number;

    /**
     * Underlying encoder environment.
     */
    private _env: wcp.VideoEncoderEnvironment;

    /**
     * Underlying encoder.
     */
    private _encoder: wcp.VideoEncoder;
}
