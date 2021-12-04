/*
 * Copyright (c) 2018-2021 Yahweasel
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

// Size of our shared buffer
const bufSz = 96000;

// Processor to capture data
class CaptureProcessor extends AudioWorkletProcessor {
    canShared: boolean;
    setup: boolean;
    done: boolean;

    /* OUTGOING: a number of shared buffers equal to the number of channels,
     * and a shared read/write head */
    outgoing: Float32Array[];
    outgoingRW: Int32Array;

    constructor(options?: AudioWorkletNodeOptions) {
        super(options);

        this.setup = false;
        this.done = false;

        // Can we use shared memory?
        this.canShared =
            typeof SharedArrayBuffer !== "undefined";

        this.port.onmessage = ev => {
            const msg = ev.data;
            if (msg.c === "done")
                this.done = true;
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
        if (this.done)
            return false;
        if (inputs.length === 0 || inputs[0].length === 0)
            return true;

        // SETUP
        if (!this.setup) {
            const chans = inputs[0].length;
            this.setup = true;

            if (this.canShared) {
                // Set up our shared memory buffer
                this.outgoing = [];
                for (let i = 0; i < chans; i++)
                    this.outgoing.push(new Float32Array(new SharedArrayBuffer(bufSz * 4)));
                this.outgoingRW = new Int32Array(new SharedArrayBuffer(8));

                // Tell the worker about our buffers
                console.log("[INFO] AWP: Using shared memory");
                this.port.postMessage({
                    c: "buffers",
                    outgoing: this.outgoing,
                    outgoingRW: this.outgoingRW
                });
            } else {
                console.log("[INFO] AWP: Not using shared memory");
            }
        }

        // Transmit our current data
        const inp = inputs[0];
        if (this.canShared) {
            // Write it into the buffer
            let writeHead = this.outgoingRW[1];
            const len = inp[0].length;
            if (writeHead + len > bufSz) {
                // We wrap around
                const brk = bufSz - writeHead;
                for (let i = 0; i < this.outgoing.length; i++) {
                    this.outgoing[i].set(inp[i%inp.length].subarray(0, brk), writeHead);
                    this.outgoing[i].set(inp[i%inp.length].subarray(brk), 0);
                }
            } else {
                // Simple case
                for (let i = 0; i < this.outgoing.length; i++)
                    this.outgoing[i].set(inp[i%inp.length], writeHead);
            }
            writeHead = (writeHead + len) % bufSz;
            Atomics.store(this.outgoingRW, 1, writeHead);

            // Notify the worker
            Atomics.notify(this.outgoingRW, 1);

        } else {
            // Just send the data. Minimize allocation by sending plain.
            this.port.postMessage(inputs[0]);

        }

        return true;
    }
}

registerProcessor("rtennui-cap", CaptureProcessor);
