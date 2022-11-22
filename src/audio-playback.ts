// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2021, 2022 Yahweasel
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

import * as playAwp from "./play-awp-js";
import * as events from "./events";
import * as util from "./util";

import type * as wcp from "libavjs-webcodecs-polyfill";

/**
 * General interface for any audio playback subsystem.
 */
export abstract class AudioPlayback extends events.EventEmitter {
    constructor() {
        super();
    }

    /**
     * Play this audio.
     */
    abstract play(data: Float32Array[]): void;

    /**
     * Get the underlying number of channels.
     */
    abstract channels(): number;

    /**
     * Get the underlying AudioNode.
     */
    abstract node(): AudioNode;

    /**
     * Stop this audio playback and remove any underlying data.
     */
    abstract close(): void;
}

/**
 * Audio playback using an audio worklet processor.
 */
export class AudioPlaybackAWP extends AudioPlayback {
    constructor(
        private _ac: AudioContext & {rteHavePlayWorklet?: boolean}
    ) {
        super();
        this._input = null;
        this._worklet = null;
    }

    /**
     * You *must* initialize an AudioPlaybackAWP before it's usable.
     */
    async init() {
        const ac = this._ac;

        if (!ac.rteHavePlayWorklet) {
            await ac.audioWorklet.addModule(playAwp.js);
            ac.rteHavePlayWorklet = true;
        }

        // Create the worklet...
        const worklet = this._worklet =
            new AudioWorkletNode(ac, "rtennui-play", {
                parameterData: {
                    sampleRate: ac.sampleRate
                }
            });

        // Connect it up
        const input = this._input = ac.createConstantSource();
        input.connect(worklet);
    }

    /**
     * Play this audio.
     * @param data  Audio to play.
     */
    play(data: Float32Array[]) {
        this._worklet.port.postMessage(data, data.map(x => x.buffer));
    }

    /**
     * Get the underlying number of channels.
     */
    channels() {
        return 1;
    }

    /**
     * Get the underlying AudioNode.
     */
    node() {
        return this._worklet;
    }

    /**
     * Close all our workers and disconnect everything.
     */
    close() {
        if (this._worklet) {
            const worklet = this._worklet;
            this._input.disconnect(worklet);
            worklet.port.postMessage({c: "done"});
        }
    }

    /**
     * Blank-generating input node.
     */
    private _input: AudioNode;

    /**
     * The worklet itself.
     */
    private _worklet: AudioWorkletNode;
}

/**
 * Audio playback using a ScriptProcessor.
 */
export class AudioPlaybackSP extends AudioPlayback {
    constructor(
        private _ac: AudioContext
    ) {
        super();

        this._bufferedSamples = 0;
        this._buffer = [];

        const sampleRate = _ac.sampleRate;

        // Create the ScriptProcessor
        const sp = this._sp =
            _ac.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = ev => {
            // Get the output channels
            const outChans = ev.outputBuffer.numberOfChannels;
            const outData: Float32Array[] = [];
            for (let i = 0; i < outChans; i++)
                outData.push(ev.outputBuffer.getChannelData(i));

            // If we have less than one buffer, send nothing
            if (this._bufferedSamples < outData[0].length)
                return;

            // If we have too much data, drop some
            while (this._bufferedSamples > outData[0].length * 4) {
                this._bufferedSamples -= this._buffer[0][0].length;
                this._buffer.shift();
            }

            // Copy in data
            let len = 0, remain = outData[0].length;
            while (remain > 0 && this._buffer.length) {
                const inBuf = this._buffer[0];
                if (inBuf[0].length <= outData[0].length) {
                    // Use this entire buffer
                    for (let i = 0; i < outData.length; i++)
                        outData[i].set(inBuf[i%inBuf.length], len);
                    this._bufferedSamples -= inBuf[0].length;
                    this._buffer.shift();
                    len += inBuf[0].length;
                    remain -= inBuf[0].length;

                } else { // inBuf too big
                    // Use part of this buffer
                    for (let i = 0; i < outData.length; i++) {
                        outData[i].set(
                            inBuf[i%inBuf.length].subarray(0, remain),
                            len
                        );
                    }
                    for (let i = 0; i < inBuf.length; i++)
                        inBuf[i] = inBuf[i].subarray(remain);
                    this._bufferedSamples -= remain;
                    len += remain;
                    remain = 0;

                }
            }
        };

        // Create a null input so it runs
        const nullInput = this._nullInput = _ac.createConstantSource();

        // Connect it up
        nullInput.connect(sp);
        sp.connect(_ac.destination);
        nullInput.start();
    }

    /**
     * Close and destroy this script processor.
     */
    close() {
        this._nullInput.stop();
        this._nullInput.disconnect(this._sp);
        this._sp.disconnect(this._ac.destination);
    }

    /**
     * Play this audio.
     */
    play(data: Float32Array[]) {
        this._bufferedSamples += data[0].length;
        this._buffer.push(data.map(x => x.slice(0)));
    }

    /**
     * Get the underlying number of channels.
     */
    channels() {
        return 1;
    }

    /**
     * Get the underlying AudioNode.
     */
    node() {
        return this._sp;
    }

    /**
     * A null input used to make the script processor run.
     */
    private _nullInput: ConstantSourceNode;

    /**
     * The actual script processor.
     */
    private _sp: ScriptProcessorNode;

    /**
     * The amount of audio data we have buffered.
     */
    private _bufferedSamples: number;

    /**
     * The buffer of audio data itself.
     */
    private _buffer: Float32Array[][];
}

/**
 * Create an appropriate audio playback from an AudioContext.
 */
export async function createAudioPlayback(
    ac: AudioContext
): Promise<AudioPlayback> {
    if (typeof AudioWorkletNode !== "undefined" &&
        !util.isSafari()) {
        const ret = new AudioPlaybackAWP(ac);
        await ret.init();
        return ret;

    } else {
        return new AudioPlaybackSP(ac);

    }
}
