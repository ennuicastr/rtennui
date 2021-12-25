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
 * Options for an outgoing audio stream.
 */
export interface OutgoingAudioStreamOptions {
    /**
     * Frame size in microseconds.
     */
    frameSize?: number;
}

/**
 * An outgoing audio stream.
 */
export class OutgoingAudioStream extends events.EventEmitter {
    constructor(
        public capture: audioCapture.AudioCapture
    ) {
        super();
        this._sentZeroFrames = 0;
        this._frameSize = 0;
    }

    /**
     * Initialize this outgoing audio stream and start it generating audio.
     */
    async init(opts: OutgoingAudioStreamOptions = {}) {
        // Get the frame size into something Opus can handle
        let frameSize = opts.frameSize || 20000;
        frameSize = Math.min(Math.ceil(frameSize / 2500) * 2500, 120000);
        this._frameSize = frameSize = ~~(frameSize * 48 / 1000);

        /* NOTE: We never use native WebCodecs, because we need to be able to
         * set the frame size. */
        this.capture.setAudioData(LibAVWebCodecs.AudioData);

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
                    frame_size: frameSize,
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
        if (this.capture.getVADState() === "no") {
            // Maybe send a zero frame
            if (this._sentZeroFrames < 3) {
                const zeroData = new LibAVWebCodecs.AudioData({
                    format: "f32-planar",
                    sampleRate: 48000,
                    numberOfFrames: 960,
                    numberOfChannels: 1,
                    timestamp: data.timestamp,
                    data: new Float32Array(this._frameSize)
                });
                this._encoder.encode(zeroData);
                this._sentZeroFrames++;
                zeroData.close();
            }

        } else {
            this._encoder.encode(data);
            this._sentZeroFrames = 0;

        }

        data.close();
    }

    // Underlying encoder
    private _encoder: wcp.AudioEncoder;

    // Number of zero frames we've sent if the VAD is off
    private _sentZeroFrames: number;

    // Frame size of the encoder in samples
    private _frameSize: number;
}
