// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2018-2022 Yahweasel
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

/* These declarations are from https://github.com/joanrieu at
 * https://github.com/microsoft/TypeScript/issues/28308#issuecomment-650802278 */
interface AudioWorkletProcessor {
    readonly port: MessagePort;
    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean;
}

declare const AudioWorkletProcessor: {
    prototype: AudioWorkletProcessor;
    new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

declare function registerProcessor(
    name: string,
    processorCtor: (new (
        options?: AudioWorkletNodeOptions
    ) => AudioWorkletProcessor) & {
        parameterDescriptors?: any[];
    }
);

// Processor to play data
class PlaybackProcessor extends AudioWorkletProcessor {
    connected: boolean;
    playing: boolean;
    timeout: number;
    done: boolean;

    buf: Float32Array[][];
    bufLen: number;

    constructor(options?: AudioWorkletNodeOptions) {
        super(options);

        const sampleRate = options.parameterData.sampleRate;

        // Skip data if our buffer goes over 20ms
        const idealBuf = Math.round(sampleRate / 100);
        const maxBuf = Math.round(sampleRate / 50);

        this.connected = false;
        this.playing = false;
        this.timeout = 0;
        this.done = false;
        this.buf = [];
        this.bufLen = 0;

        this.port.onmessage = ev => {
            const msg = ev.data;
            if (msg.length) {
                if (this.connected) {
                    // Check for overrun
                    if (this.bufLen > maxBuf) {
                        while (this.bufLen > idealBuf) {
                            // Skip some data
                            const rem = this.bufLen - idealBuf;
                            const part = this.buf[0];
                            const partLen = part[0].length;
                            if (partLen > rem) {
                                // Just remove part
                                for (let i = 0; i < part.length; i++)
                                    part[i] = part[i].subarray(rem);
                                this.bufLen -= rem;
                            } else {
                                // Remove this whole part
                                this.buf.shift();
                                this.bufLen -= partLen;
                            }
                        }
                    }

                    // Now accept this part
                    this.buf.push(msg);
                    this.bufLen += msg[0].length;
                    if (!this.playing && this.buf.length === 1) {
                        this.playing = true;
                        this.timeout = idealBuf;
                    }
                }

            } else if (msg.c === "done") {
                this.done = true;

            }
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
        if (this.done)
            return false;
        this.connected = true;
        if (!this.playing)
            return true;

        const out = outputs[0];

        // Wait for data to buffer
        if (this.timeout > 0) {
            this.timeout -= out[0].length;
            return true;
        }

        // Perhaps end playback
        if (this.buf.length === 0) {
            this.playing = false;
            return true;
        }

        // Play some data
        const len = out[0].length;
        let idx = 0, rem = len;
        while (idx < len && this.buf.length) {
            const part = this.buf[0];
            if (part[0].length > rem) {
                // Just use part of it
                for (let i = 0; i < out.length; i++)
                    out[i].set(part[i%part.length].subarray(0, rem), idx);
                for (let i = 0; i < part.length; i++)
                    part[i] = part[i].subarray(rem);
                idx = len;
                rem = 0;
                this.bufLen -= len;

            } else {
                // Use the rest of it
                const partLen = part[0].length;
                for (let i = 0; i < out.length; i++)
                    out[i].set(part[i%part.length], idx);
                idx += partLen;
                rem -= partLen;
                this.buf.shift();
                this.bufLen -= partLen;

            }
        }

        return true;
    }
}

registerProcessor("rtennui-play", PlaybackProcessor);
