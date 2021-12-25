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

import * as capAwp from "./cap-awp-js";
import * as capAwpWaiter from "./cap-awp-waiter-js";
import * as events from "./events";

import type * as wcp from "libavjs-webcodecs-polyfill";

/**
 * VAD state.
 */
export type VADState =
    "no" | "maybe" | "yes";

/**
 * General interface for any audio capture subsystem, user-implementable.
 */
export abstract class AudioCapture extends events.EventEmitter {
    constructor() {
        super();
        this._AudioData = null;
    }

    /**
     * Get the current VAD state. Must also send a "vad" event when this
     * changes.
     */
    getVADState(): VADState { return "yes"; }

    /**
     * Set the AudioData type.
     */
    setAudioData(to: typeof wcp.AudioData) { this._AudioData = to; }

    /**
     * Stop this audio capture and remove any underlying data.
     */
    abstract close(): void;

    /**
     * "Tee" this capture into the number of receivers specified.
     */
    tee(ct: number): AudioCapture[] {
        if (!this._AudioData) {
            // This needs to be set first
            throw new Error("AudioData must be set before tee");
        }

        let closeCt = 0;

        const onclose = () => {
            if (++closeCt === ct)
                this.close();
        };

        const ret = Array(ct).fill(null).map(() =>
            new AudioCaptureTee(this));

        const onsetaudiodata = (to: typeof wcp.AudioData) => {
            this.setAudioData(to);
            for (const tee of ret)
                tee._AudioData = this._AudioData;
        };

        for (const tee of ret) {
            tee._AudioData = this._AudioData;
            tee.onclose = onclose;
            tee.onsetaudiodata = onsetaudiodata;
        }

        this.on("vad", () => {
            for (const tee of ret)
                tee.emitEvent("vad", null);
        });

        this.on("data", data => {
            for (let i = 0; i < ct - 1; i++) {
                const tee = ret[i];
                tee.emitEvent("data", data.clone());
            }
            const tee = ret[ct - 1];
            tee.emitEvent("data", data);
        });

        return ret;
    }

    /**
     * AudioData type to be used by captured audio, set by the user.
     */
    protected _AudioData: typeof wcp.AudioData;
}

/**
 * Tee'd audio capture.
 */
export class AudioCaptureTee extends AudioCapture {
    constructor(public readonly parent: AudioCapture) {
        super();
    }

    override getVADState() { return this.parent.getVADState(); }

    override setAudioData(to: typeof wcp.AudioData) {
        if (this.onsetaudiodata)
            this.onsetaudiodata(to);
    }

    close() {
        if (this.onclose)
            this.onclose();
    }

    onclose?: () => void;
    onsetaudiodata?: (to: typeof wcp.AudioData) => void;
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
        this._ts = 0;
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

    /**
     * Message handler for messages from the worklet.
     */
    private _onmessage(ev: MessageEvent) {
        const msg = ev.data;
        if (msg.length) {
            // It's raw data
            if (!this._AudioData)
                return;

            // Put it into a single buffer
            const len = msg.length * msg[0].length;
            const buf = new Float32Array(len);
            let idx = 0;
            for (const part of (<Float32Array[]> msg)) {
                buf.set(part, idx);
                idx += part.length;
            }

            // Convert to an AudioData
            const ad = new this._AudioData({
                format: <any> "f32-planar",
                sampleRate: this._ac.sampleRate,
                numberOfFrames: msg[0].length,
                numberOfChannels: msg.length,
                timestamp: this._ts,
                data: buf
            });
            this._ts += Math.round(msg[0].length / this._ac.sampleRate * 1000000);

            // And send it
            this.emitEvent("data", ad);

        } else if (msg.c === "buffers") {
            // It's our shared buffers
            this._incoming = msg.outgoing;
            this._incomingRW = msg.outgoingRW;

            // Wait for data
            const waiter = this._waiter = new Worker(capAwpWaiter.js);
            waiter.onmessage = ev => {
                this._onwaiter(ev);
            };

        }
    }

    /**
     * Sent when shared buffers get new data.
     */
    private _onwaiter(ev: MessageEvent) {
        if (!this._AudioData)
            return;

        // Put it into a single buffer
        const [lo, hi]: [number, number] = ev.data;
        let buf: Float32Array;
        let frames = hi - lo;
        const channels = this._incoming.length;
        if (frames >= 0) {
            const len = channels * frames;
            buf = new Float32Array(len);
            let idx = 0;
            for (const channel of this._incoming) {
                buf.set(channel.subarray(lo, hi), idx);
                idx += frames;
            }

        } else {
            // Wraparound
            const bufLen = this._incoming[0].length;
            frames += bufLen;
            const len = channels * frames;
            buf = new Float32Array(len);
            let idx = 0;
            for (const channel of this._incoming) {
                // Lo part
                buf.set(channel.subarray(lo), idx);
                idx += bufLen - lo;
                // Hi part
                buf.set(channel.subarray(0, hi), idx);
                idx += hi;
            }

        }

        // Convert to an AudioData
        const ad = new this._AudioData({
            format: <any> "f32-planar",
            sampleRate: this._ac.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: channels,
            timestamp: this._ts,
            data: buf
        });
        this._ts += Math.round(frames / this._ac.sampleRate * 1000000);

        // And send it
        this.emitEvent("data", ad);

        const data = this._incoming.map(channel =>
            channel.slice(lo, hi)
        );
    }

    /**
     * Close all our workers and disconnect everything.
     */
    close() {
        if (this._worklet) {
            const worklet = this._worklet;
            this._input.disconnect(worklet);
            worklet.disconnect(this._ac.destination);
            worklet.port.postMessage({c: "done"});
        }

        if (this._waiter)
            this._waiter.terminate();
    }

    /**
     * We manage our own timestamp.
     */
    private _ts: number;

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
        let ts = 0;

        // Create the ScriptProcessor
        const sp = this._sp =
            _ac.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = ev => {
            if (!this._AudioData)
                return;

            const data = ev.inputBuffer.getChannelData(0);
            const ad = new this._AudioData({
                format: <any> "f32-planar",
                sampleRate: sampleRate,
                numberOfFrames: data.length,
                numberOfChannels: 1,
                timestamp: ts,
                data
            });
            ts += Math.round(data.length / sampleRate * 1000000);
            this.emitEvent("data", ad);
        };

        // Connect it up
        _input.connect(sp);
        sp.connect(_ac.destination);
    }

    /**
     * Close and destroy this script processor.
     */
    close() {
        const sp = this._sp;
        this._input.disconnect(sp);
        sp.disconnect(this._ac.destination);
    }

    /**
     * The actual script processor.
     */
    private _sp: ScriptProcessorNode;
}

/**
 * Create an appropriate audio capture from an AudioContext and a MediaStream.
 */
export async function createAudioCapture(
    ac: AudioContext, ms: MediaStream
): Promise<AudioCapture> {
    const mss = ac.createMediaStreamSource(ms);
    if (typeof AudioWorkletNode !== "undefined") {
        const ret = new AudioCaptureAWP(ac, mss);
        await ret.init();
        return ret;

    } else {
        return new AudioCaptureSP(ac, mss);

    }
}
