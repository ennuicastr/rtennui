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

import * as capWorkerWaiter from "./cap-worker-waiter-js";
import * as playAwp from "./play-awp-js";
import * as playSharedAwp from "./play-shared-awp-js";
import * as events from "./events";
import * as util from "./util";

import type * as wcp from "libavjs-webcodecs-polyfill";

/**
 * Types of audio playback supported.
 */
type AudioPlaybackType =
    "shared-awp" | "shared-sp" | "awp" | "sp";

/**
 * Options for creating an audio playback.
 */
export interface AudioPlaybackOptions {
    /**
     * Preferred type, if supported.
     */
    preferredType?: AudioPlaybackType;

    /**
     * Demanded type, whether supported or not.
     */
    demandedType?: AudioPlaybackType;
}

/**
 * General interface for any audio playback subsystem, user implementable.
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
     * Pipe audio from this message port. Same format as pipe() in
     * AudioCapture.
     */
    pipeFrom(port: MessagePort): void {
        port.onmessage = ev => {
            const msg = ev.data;

            if (msg.length) {
                // Raw data. Just play it.
                this.play(msg);

            } else if (msg.c === "buffers") {
                const incoming: Float32Array[] = msg.buffers;
                const incomingH: Int32Array = msg.head;

                // Wait for data
                // FIXME: Need to destroy this if the playback is stopped
                const waiter = new Worker(capWorkerWaiter.js);
                waiter.onmessage = ev => {
                    const [lo, hi]: [number, number] = ev.data;
                    // Make sure there's a memory fence in this thread
                    (<any> window).Atomics.load(incomingH, 0);
                    if (hi > lo) {
                        this.play(incoming.map(x => x.slice(lo, hi)));
                    } else {
                        this.play(incoming.map(x => x.slice(lo)));
                        this.play(incoming.map(x => x.slice(0, hi)));
                    }
                };
                waiter.postMessage(incomingH);

            }
        };
    }

    /**
     * Get the underlying number of channels.
     */
    abstract channels(): number;

    /**
     * Get the underlying AudioNode, *if* there is a unique audio node for this
     * playback.
     */
    unsharedNode(): AudioNode {
        return null;
    }

    /**
     * Get the underlying AudioNode, if it's shared.
     */
    sharedNode(): AudioNode {
        return null;
    }

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
        private _ac: AudioContext & {rtePlayWorkletPromise?: Promise<unknown>}
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

        if (!ac.rtePlayWorkletPromise)
            ac.rtePlayWorkletPromise = ac.audioWorklet.addModule(playAwp.js);
        await ac.rtePlayWorkletPromise;

        // Create the worklet...
        const worklet = this._worklet =
            new AudioWorkletNode(ac, "rtennui-play", {
                parameterData: {
                    sampleRate: ac.sampleRate
                }
            });

        // Connect it up
        const input = this._input = ac.createConstantSource();
        input.offset.value = 0;
        input.connect(worklet);
        input.start();
    }

    /**
     * Play this audio.
     * @param data  Audio to play.
     */
    play(data: Float32Array[]) {
        this._worklet.port.postMessage(data, data.map(x => x.buffer));
    }

    /**
     * We can connect a message port directly.
     */
    override pipeFrom(port: MessagePort) {
        this._worklet.port.postMessage({c: "in", p: port}, [port]);
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
    override unsharedNode() {
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
 * Audio playback using a shared audio worklet processor.
 */
export class AudioPlaybackSharedAWP extends AudioPlayback {
    constructor(
        private _ac: AudioContext & {
            rtePlaySharedWorkletPromise?: Promise<unknown>,
            rtePlaySharedWorklet?: AudioWorkletNode
        }
    ) {
        super();
        this._input = null;
        this._port = null;
    }

    /**
     * You *must* initialize an AudioPlaybackSharedAWP before it's usable.
     */
    async init() {
        const ac = this._ac;

        // Create the worklet
        if (!ac.rtePlaySharedWorkletPromise)
            ac.rtePlaySharedWorkletPromise = ac.audioWorklet.addModule(playSharedAwp.js);
        await ac.rtePlaySharedWorkletPromise;

        if (!ac.rtePlaySharedWorklet) {
            // Create the worklet...
            const worklet = ac.rtePlaySharedWorklet =
                new AudioWorkletNode(ac, "rtennui-play-shared", {
                    parameterData: {
                        sampleRate: ac.sampleRate
                    }
                });

            // Connect it up
            const input = this._input = ac.createConstantSource();
            input.offset.value = 0;
            input.connect(worklet);
            input.start();
        }

        // Then add this input to it
        const mc = new MessageChannel();
        this._port = mc.port1;
        ac.rtePlaySharedWorklet.port.postMessage({c: "in", p: mc.port2}, [mc.port2]);
    }

    /**
     * Play this audio.
     * @param data  Audio to play.
     */
    play(data: Float32Array[]) {
        if (this._port)
            this._port.postMessage(data, data.map(x => x.buffer));
    }

    /**
     * We can connect a message port directly.
     */
    override pipeFrom(port: MessagePort) {
        if (this._port)
            this._port.postMessage({c: "in", p: port}, [port]);
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
    override sharedNode() {
        return this._ac.rtePlaySharedWorklet;
    }

    /**
     * Disconnect (only this port)
     * FIXME: What if they did pipeFrom?
     */
    close() {
        if (this._port) {
            this._port.postMessage({c: "stop"});
            this._port = null;
        }
    }

    /**
     * Blank-generating input node.
     */
    private _input: AudioNode;

    /**
     * The port to communicate with the worklet.
     */
    private _port: MessagePort;
}

/**
 * Audio playback using a ScriptProcessor.
 */
export class AudioPlaybackSP extends AudioPlayback {
    constructor(
        private _ac: AudioContext
    ) {
        super();

        this._bufLen = 0;
        this._buf = [];
        this._playing = false;

        const sampleRate = _ac.sampleRate;
        const maxBuf = sampleRate >> 1;

        // Create the ScriptProcessor
        const sp = this._sp =
            _ac.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = ev => {
            // Get the output channels
            const outChans = ev.outputBuffer.numberOfChannels;
            const outData: Float32Array[] = [];
            for (let i = 0; i < outChans; i++)
                outData.push(ev.outputBuffer.getChannelData(i));

            // Decide whether to start playing
            if (!this._playing && this._bufLen >= outData[0].length * 2)
                this._playing = true;

            if (!this._playing)
                return;

            // If we have too much data, drop some
            while (this._bufLen >= maxBuf) {
                this._bufLen -= this._buf[0][0].length;
                this._buf.shift();
            }

            // Copy in data
            let rd = 0, remain = outData[0].length;
            while (remain > 0 && this._buf.length) {
                const inBuf = this._buf[0];
                if (inBuf[0].length <= remain) {
                    // Use this entire buffer
                    for (let i = 0; i < outData.length; i++)
                        outData[i].set(inBuf[i%inBuf.length], rd);
                    this._bufLen -= inBuf[0].length;
                    this._buf.shift();
                    rd += inBuf[0].length;
                    remain -= inBuf[0].length;

                } else { // inBuf too big
                    // Use part of this buffer
                    for (let i = 0; i < outData.length; i++) {
                        outData[i].set(
                            inBuf[i%inBuf.length].subarray(0, remain),
                            rd
                        );
                    }
                    for (let i = 0; i < inBuf.length; i++)
                        inBuf[i] = inBuf[i].subarray(remain);
                    this._bufLen -= remain;
                    rd += remain;
                    remain = 0;

                }
            }

            // Possibly we're done playing
            if (!this._buf.length)
                this._playing = false;
        };

        // Create a null input so it runs
        const nullInput = this._nullInput = _ac.createConstantSource();
        nullInput.offset.value = 0;

        // Connect it up
        nullInput.connect(sp);
        nullInput.start();
    }

    /**
     * Close and destroy this script processor.
     */
    close() {
        this._nullInput.stop();
        this._nullInput.disconnect(this._sp);
    }

    /**
     * Play this audio.
     */
    play(data: Float32Array[]) {
        this._bufLen += data[0].length;
        this._buf.push(data.map(x => x.slice(0)));
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
    override unsharedNode() {
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
    private _bufLen: number;

    /**
     * The buffer of audio data itself.
     */
    private _buf: Float32Array[][];

    /**
     * Set when we're playing to empty the buffer.
     */
    private _playing: boolean;
}

// Cache of supported options
let playCache: Record<string, boolean> = null;

/**
 * Create an appropriate audio playback from an AudioContext.
 */
export async function createAudioPlaybackNoBidir(
    ac: AudioContext, opts: AudioPlaybackOptions = {}
): Promise<AudioPlayback> {
    // Cache what we support
    if (!playCache) {
        // Figure out what we support
        playCache = Object.create(null);

        if (typeof AudioWorkletNode !== "undefined") {
            playCache["shared-awp"] = true;
            playCache.awp = true;
        }
        if (ac.createScriptProcessor)
            playCache.sp = true;
    }

    // Choose one
    let choice = opts.demandedType;
    if (!choice) {
        if (playCache[opts.preferredType])
            choice = opts.preferredType;
    }
    if (!choice) {
        if (playCache["shared-awp"] && !util.isSafari())
            choice = "shared-awp";
        else
            choice = "sp";
    }

    if (choice === "shared-awp") {
        const ret = new AudioPlaybackSharedAWP(ac);
        await ret.init();
        return ret;

    } else if (choice === "awp") {
        const ret = new AudioPlaybackAWP(ac);
        await ret.init();
        return ret;

    } else {
        return new AudioPlaybackSP(ac);

    }
}
