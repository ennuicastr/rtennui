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

import * as videoCapture from "./video-capture";
import * as events from "./events";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

/**
 * An outgoing video stream. Basically a thin wrapper around VideoCapture, with
 * automatic reloading.
 *
 * Events:
 * * data(EncodedVideoChunk): Emitted when a video chunk is ready.
 *
 * @private
 */
export class OutgoingVideoStream extends events.EventEmitter {
    constructor(
        public ms: MediaStream,
        private _codec: string
    ) {
        super();
        this._bitrate = this._width = this._height = 0;
        this._capture = null;
    }

    /**
     * An OutgoingVideoStream must be initialized to start producing frames.
     */
    async init() {
        const s = this.ms.getVideoTracks()[0].getSettings();
        const codec = this._codec;
        let width = Math.round(s.width!);
        let height = Math.round(s.height!);

        if (!width || !height) {
            /* Size not yet known. This happens in particular on Safari with
             * screen capture. The trick to get the actual size is to go
             * through an HTMLVideoElement. */
            const ve = document.createElement("video");
            ve.srcObject = this.ms;
            ve.defaultMuted = ve.muted = true;
            ve.style.display = "none";
            document.body.appendChild(ve);
            ve.play().catch(console.error);
            if (!ve.videoWidth) {
                await Promise.race([
                    new Promise(res => ve.onloadedmetadata),
                    new Promise(res => setTimeout(res, 1000))
                ]);
            }
            width = Math.round(ve.videoWidth) || 640;
            height = Math.round(ve.videoHeight) || 360;
            try {
                ve.pause();
            } catch (ex) {}
            try {
                ve.parentNode!.removeChild(ve);
            } catch (ex) {}
            ve.srcObject = null;
        }

        if (!width || !height) {
            width = 640;
            height = 360;
        }

        this._width = width;
        this._height = height;

        const bitrate = this._bitrate = height * 1000;
        this._capture = await videoCapture.createVideoCapture(this.ms, <any> {
            codec: codec.slice(1),
            width: width,
            height: height,
            bitrate: bitrate,
            bitrateMode: "constant",
            latencyMode: "realtime"
        });
        this._capture.on("data", data => this.emitEvent("data", data));
    }

    /**
     * (De)grade the quality.
     */
    grade(by: number) {
        return this._capture!.grade(by);
    }

    /**
     * Get the codec of this stream.
     */
    getCodec() {
        return this._codec;
    }

    /**
     * Get the current bitrate of this stream.
     */
    getBitrate() {
        return this._bitrate; // FIXME
    }

    /**
     * Get the framerate of this stream.
     */
    getFramerate() {
        return this._capture!.getFramerate();
    }

    /**
     * Get the nominal width of this stream.
     */
    getWidth() {
        return this._width;
    }

    /**
     * Get the nominal height of this stream.
     */
    getHeight() {
        return this._height;
    }

    /**
     * Force all frames to be sent reliably?
     */
    forceReliable(): boolean {
        return this._capture!.reliableOnly();
    }

    /**
     * Close this outgoing stream.
     */
    async close() {
        await this._capture!.close();
    }

    private _bitrate: number;

    private _width: number;
    private _height: number;

    private _capture: videoCapture.VideoCapture | null;
}
