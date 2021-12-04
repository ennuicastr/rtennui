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

import * as audioCapture from "./audio-capture";
import * as events from "./events";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

/**
 * An outgoing audio stream.
 */
export class OutgoingAudioStream extends events.EventEmitter {
    constructor(
        public capture: audioCapture.AudioCapture
    ) {
        super();
    }

    /**
     * Initialize this outgoing audio stream and start it generating audio.
     */
    async init() {
        /* NOTE: We never use native WebCodecs, because we need to be able to
         * set the frame size. */
        this.capture.AudioData = LibAVWebCodecs.AudioData;

        // Create our AudioEncoder
        const encoder = this._encoder =
            new LibAVWebCodecs.AudioEncoder({
                output: data => {
                    this.emitEvent("data", data);
                },
                error: error => {
                    this.emitEvent("error", error);
                }
            });

        // Configure it
        await encoder.configure({
            codec: {libavjs:{
                codec: "libopus",
                ctx: {
                    sample_fmt: 3 /* FLT */,
                    sample_rate: 48000,
                    frame_size: 960,
                    channel_layout: 4 /* mono */,
                    bit_rate: 64000,
                    bit_ratehi: 0
                }
            }},
            sampleRate: 48000,
            bitrate: 64000,
            numberOfChannels: 1
        });

        // Hook it up
        this.capture.on("data", data => this._oninput(data));
    }

    /**
     * Close this stream.
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
     * Input from the audio capture.
     */
    private _oninput(data: wcp.AudioData) {
        if (!this._encoder)
            return;
        this._encoder.encode(data);
        data.close();
    }

    // Underlying encoder
    private _encoder: wcp.AudioEncoder;
}
