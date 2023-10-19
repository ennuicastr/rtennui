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
        public ms: MediaStream
    ) {
        super();
    }

    async init() {
        this._capture = await videoCapture.createVideoCapture(this.ms, "vp8");
        this._capture.on("data", data => this.emitEvent("data", data));
    }

    /**
     * Get the framerate of this stream.
     */
    getFramerate() {
        return this._capture.getFramerate();
    }

    /**
     * Close this outgoing stream.
     */
    async close() {
        await this._capture.close();
    }

    // FIXME: Currently always vp8
    format = "vvp8";

    _capture: videoCapture.VideoCapture;
}
