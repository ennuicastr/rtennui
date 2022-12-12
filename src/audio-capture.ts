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

import * as capAwp from "./cap-awp-js";
import * as capWorker from "./cap-worker-js";
import * as capWorkerWaiter from "./cap-worker-waiter-js";
import * as events from "./events";
import * as util from "./util";

import type * as wcp from "libavjs-webcodecs-polyfill";

/**
 * VAD state.
 */
export type VADState =
    "no" | "maybe" | "yes";

/**
 * Options for creating an audio capture.
 */
export interface AudioCaptureOptions {
    /**
     * Preferred type of audio capture.
     */
    preferredType?: "shared-sp" | "awp" | "sp";

    /**
     * *Demanded* type of audio capture. The preferred type will only be used
     * if it's supported; the demanded type will be used even if it's not.
     */
    demandedType?: "shared-sp" | "awp" | "sp";
}

/**
 * General interface for any audio capture subsystem, user-implementable.
 *
 * Events:
 * * data(Float32Array[]): Audio data event. Each element of the array is a
 *   single channel of audio data.
 * * vad(null): Audio VAD change event. Fired every time the VAD status changes.
 */
export abstract class AudioCapture extends events.EventEmitter {
    constructor() {
        super();
        this._vadState = "yes";
    }

    /**
     * Get the sample rate of this capture. Must never change.
     */
    abstract getSampleRate(): number;

    /**
     * Get the current VAD state.
     */
    getVADState(): VADState { return this._vadState; }

    /**
     * Set the current VAD state. Subclasses may want to block this and do the
     * VAD themselves.
     */
    setVADState(to: VADState) {
        if (this._vadState === to)
            return;
        this._vadState = to;
        this.emitEvent("vad", null);
    }

    /**
     * Stop this audio capture and remove any underlying data.
     */
    abstract close(): void;

    /**
     * Pipe data to this message port, using shared memory if requested (and
     * possible). Message will be either a Float32Array[] (array of channels),
     * or, if using shared memory, a single message of the form
     * {
     *   c: "buffers",
     *   buffers: Float32Array[],
     *   head: Int32Array
     * }
     * In the "buffers" case, the buffers are a shared memory buffer, and head
     * is a write head into each buffer. The writer will update the head with
     * each write, using the buffers as ring buffers. The receiver must be fast
     * enough to read the buffers before the ring wraps around.
     */
    pipe(to: MessagePort, shared = false) {
        this.on("data", data => to.postMessage(data));
    }

    /**
     * Current VAD state.
     */
    private _vadState: VADState;
}

/**
 * Audio capture using an audio worklet processor.
 */
export class AudioCaptureAWP extends AudioCapture {
    constructor(
        private _ac: AudioContext & {rteCapWorklet?: Promise<unknown>},
        private _input: AudioNode
    ) {
        super();
        this._worklet = null;
        this._incoming = null;
        this._incomingH = null;
        this._waiter = null;
    }

    /**
     * You *must* initialize an AudioCaptureAWP before it's usable.
     */
    async init() {
        const ac = this._ac;

        if (!ac.rteCapWorklet)
            ac.rteCapWorklet = ac.audioWorklet.addModule(capAwp.js);
        await ac.rteCapWorklet;

        // Create the worklet
        const worklet = this._worklet =
            new AudioWorkletNode(ac, "rtennui-cap", {
                /* 2 inputs on Firefox because when input is muted, it doesn't
                 * run the processor at all, but we'd rather have 0s. */
                numberOfInputs: util.isFirefox() ? 2 : 1
            });

        // And the worker
        const worker = this._worker =
            new Worker(capWorker.js);

        // And a communication channel for them
        let mc = new MessageChannel();
        worklet.port.postMessage({c: "out", p: mc.port1}, [mc.port1]);
        worker.postMessage({c: "in", p: mc.port2}, [mc.port2]);

        // And a communication channel for ourself
        mc = new MessageChannel();
        worker.postMessage({c: "out", p: mc.port1, shared: true}, [mc.port1]);

        // Wait for messages
        mc.port2.onmessage = ev => {
            this._onmessage(ev);
        };

        // Connect the worklet up
        this._input.connect(worklet);
        worklet.connect(ac.destination);

        // On Firefox, also give it null input
        if (util.isFirefox()) {
            const n = ac.createConstantSource();
            n.offset.value = 0;
            n.connect(worklet, 0, 1);
            n.start();
        }
    }

    override getSampleRate() { return this._ac.sampleRate; }

    /**
     * Message handler for messages from the worker.
     */
    private _onmessage(ev: MessageEvent) {
        const msg = ev.data;
        if (msg.length) {
            // It's raw data
            this.emitEvent("data", msg);

        } else if (msg.c === "buffers") {
            // It's our shared buffers
            this._incoming = msg.buffers;
            this._incomingH = msg.head;

            // Wait for data
            const waiter = this._waiter = new Worker(capWorkerWaiter.js);
            waiter.onmessage = ev => {
                (<any> window).Atomics.load(this._incomingH, 0);
                this._onwaiter(ev);
            };
            waiter.postMessage(msg.head);

        }
    }

    /**
     * Sent when shared buffers get new data.
     */
    private _onwaiter(ev: MessageEvent) {
        // Copy it into buffers
        const [lo, hi]: [number, number] = ev.data;
        let buf: Float32Array[] = [];
        let len = hi - lo;
        const channels = this._incoming.length;
        if (len >= 0) {
            for (const channel of this._incoming)
                buf.push(channel.slice(lo, hi));

        } else {
            // Wraparound
            const bufLen = this._incoming[0].length;
            len += bufLen;
            for (const channel of this._incoming) {
                const part = new Float32Array(len);
                // Lo part
                part.set(channel.subarray(lo));
                // Hi part
                part.set(channel.subarray(0, hi), bufLen - lo);
                buf.push(part);
            }

        }

        // And send it
        this.emitEvent("data", buf);
    }

    /**
     * Close all our workers and disconnect everything.
     */
    close() {
        if (this._worklet) {
            const worklet = this._worklet;
            try {
                this._input.disconnect(worklet);
            } catch (ex) {}
            try {
                worklet.disconnect(this._ac.destination);
            } catch (ex) {}
            worklet.port.postMessage({c: "done"});
        }

        if (this._worker)
            this._worker.terminate();

        if (this._waiter)
            this._waiter.terminate();
    }

    /**
     * AWPs pipe by having the worker multiplex.
     */
    override pipe(to: MessagePort, shared = false) {
        this._worker.postMessage({
            c: "out",
            p: to,
            shared
        }, [to]);
    }

    /**
     * The worklet itself.
     */
    private _worklet: AudioWorkletNode;

    /**
     * The worklet redirects via a worker.
     */
    private _worker: Worker;

    /**
     * Incoming data.
     */
    private _incoming: Float32Array[];

    /**
     * Incoming data communication buffer (read position, write position).
     */
    private _incomingH: Int32Array;

    /**
     * Worker thread waiting for new incoming data.
     */
    private _waiter: Worker;
}

/**
 * Audio capture using a ScriptProcessor.
 */
export class AudioCaptureSP extends AudioCapture {
    constructor(
        private _ac: AudioContext,
        private _input: AudioNode
    ) {
        super();

        const sampleRate = _ac.sampleRate;

        // Create the ScriptProcessor
        const sp = this._sp =
            _ac.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = ev => {
            this.emitEvent("data", [ev.inputBuffer.getChannelData(0)]);
        };

        // Connect it up
        _input.connect(sp);
        sp.connect(_ac.destination);
    }

    override getSampleRate() { return this._ac.sampleRate; }

    /**
     * Close and destroy this script processor.
     */
    close() {
        const sp = this._sp;
        try {
            this._input.disconnect(sp);
        } catch (ex) {}
        try {
            sp.disconnect(this._ac.destination);
        } catch (ex) {}
    }

    /**
     * The actual script processor.
     */
    private _sp: ScriptProcessorNode;
}

// Cache of supported options (at this stage)
let capCache: Record<string, boolean> = null;

/**
 * Create an appropriate audio capture from an AudioContext and an input.
 * @param ac  The AudioContext for the nodes.
 * @param ms  The MediaStream or AudioNode from which to create a capture.
 */
export async function createAudioCaptureNoBidir(
    ac: AudioContext, ms: MediaStream | AudioNode,
    opts: AudioCaptureOptions = {}
): Promise<AudioCapture> {
    let node = <AudioNode> ms;
    if ((<MediaStream> ms).getAudioTracks) {
        // Looks like a media stream
        node = ac.createMediaStreamSource(<MediaStream> ms);
    }

    if (!capCache) {
        // Figure out what we support
        capCache = Object.create(null);

        if (typeof AudioWorkletNode !== "undefined")
            capCache.awp = true;
        if (ac.createScriptProcessor)
            capCache.sp = true;
    }

    // Choose an option
    let choice = opts.demandedType;
    if (!choice) {
        if (capCache[opts.preferredType])
            choice = opts.preferredType;
    }
    if (!choice) {
        if (capCache.awp && !util.isSafari())
            choice = "awp";
        else
            choice = "sp";
    }

    if (choice === "awp") {
        const ret = new AudioCaptureAWP(ac, node);
        await ret.init();
        return ret;

    } else {
        return new AudioCaptureSP(ac, node);

    }
}
