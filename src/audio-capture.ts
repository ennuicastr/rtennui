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
import * as capAwpWaiter from "./cap-awp-waiter-js";
import * as events from "./events";
import * as util from "./util";

import type * as wcp from "libavjs-webcodecs-polyfill";

/**
 * VAD state.
 */
export type VADState =
    "no" | "maybe" | "yes";

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
     * Redirect data to this MessagePort. This *may* suppress all future "data"
     * messages, or may not.
     */
    pipe(to: MessagePort) {
        this.on("data", data => to.postMessage(data, data));
    }

    /**
     * "Tee" this capture into the number of receivers specified.
     * @param ct  Number of duplicates to make.
     */
    tee(ct: number): AudioCapture[] {
        let closeCt = 0;

        const onclose = () => {
            if (++closeCt === ct)
                this.close();
        };

        const ret = Array(ct).fill(null).map(() =>
            new AudioCaptureTee(this));

        for (const tee of ret)
            tee.onclose = onclose;

        this.on("vad", () => {
            for (const tee of ret)
                tee.emitEvent("vad", null);
        });

        this.on("data", data => {
            for (let i = 0; i < ct - 1; i++) {
                const tee = ret[i];
                tee.emitEvent("data", data.map(x => x.slice(0)));
            }
            const tee = ret[ct - 1];
            tee.emitEvent("data", data);
        });

        return ret;
    }

    /**
     * Current VAD state.
     */
    private _vadState: VADState;
}

/**
 * Tee'd audio capture.
 */
export class AudioCaptureTee extends AudioCapture {
    constructor(public readonly parent: AudioCapture) {
        super();
    }

    override getSampleRate() { return this.parent.getSampleRate(); }

    override getVADState() { return this.parent.getVADState(); }

    override close() {
        if (this.onclose)
            this.onclose();
    }

    onclose?: () => void;
}

/**
 * Audio capture using an audio worklet processor.
 */
export class AudioCaptureAWP extends AudioCapture {
    constructor(
        private _ac: AudioContext & {rteHaveCapWorklet?: boolean},
        private _input: AudioNode
    ) {
        super();
        this._worklet = null;
        this._incoming = null;
        this._incomingRW = null;
        this._waiter = null;
    }

    /**
     * You *must* initialize an AudioCaptureAWP before it's usable.
     */
    async init() {
        const ac = this._ac;

        if (!ac.rteHaveCapWorklet) {
            await ac.audioWorklet.addModule(capAwp.js);
            ac.rteHaveCapWorklet = true;
        }

        // Create the worklet
        const worklet = this._worklet =
            new AudioWorkletNode(ac, "rtennui-cap");

        // Wait for messages
        worklet.port.onmessage = ev => {
            this._onmessage(ev);
        };

        // Connect it up
        this._input.connect(worklet);
        worklet.connect(ac.destination);
    }

    override getSampleRate() { return this._ac.sampleRate; }

    /**
     * Message handler for messages from the worklet.
     */
    private _onmessage(ev: MessageEvent) {
        const msg = ev.data;
        if (msg.length) {
            // It's raw data
            this.emitEvent("data", msg);

        } else if (msg.c === "buffers") {
            // It's our shared buffers
            this._incoming = msg.outgoing;
            this._incomingRW = msg.outgoingRW;

            // Wait for data
            const waiter = this._waiter = new Worker(capAwpWaiter.js);
            waiter.onmessage = ev => {
                this._onwaiter(ev);
            };
            waiter.postMessage(msg.ougoingRW);

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

        if (this._waiter)
            this._waiter.terminate();
    }

    /**
     * The worklet itself.
     */
    private _worklet: AudioWorkletNode;

    /**
     * Incoming data.
     */
    private _incoming: Float32Array[];

    /**
     * Incoming data communication buffer (read position, write position).
     */
    private _incomingRW: Int32Array;

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

/**
 * Create an appropriate audio capture from an AudioContext and a MediaStream.
 * @param ac  The AudioContext for the nodes.
 * @param ms  The MediaStream from which to create a capture.
 */
export async function createAudioCapture(
    ac: AudioContext, ms: MediaStream
): Promise<AudioCapture> {
    const mss = ac.createMediaStreamSource(ms);
    if (typeof AudioWorkletNode !== "undefined" &&
        !util.isSafari()) {
        const ret = new AudioCaptureAWP(ac, mss);
        await ret.init();
        return ret;

    } else {
        return new AudioCaptureSP(ac, mss);

    }
}
