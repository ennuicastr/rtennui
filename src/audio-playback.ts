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

import * as playAwp from "./play-awp-js";
import * as events from "./events";

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

        /*
        const sampleRate = _ac.sampleRate;

        // Create the ScriptProcessor
        const sp = this._sp =
            _ac.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = ev => {
            if (!this.AudioData)
                return;

            const data = ev.inputBuffer.getChannelData(0);
            const ad = new this.AudioData({
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
        */
    }

    /**
     * Close and destroy this script processor.
     */
    close() {
    }

    /**
     * Play this audio.
     */
    play(data: Float32Array[]) {
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
     * The actual script processor.
     */
    private _sp: ScriptProcessorNode;
}

/**
 * Create an appropriate audio playback from an AudioContext.
 */
export async function createAudioPlayback(
    ac: AudioContext
): Promise<AudioPlayback> {
    if (typeof AudioWorkletNode !== "undefined") {
        const ret = new AudioPlaybackAWP(ac);
        await ret.init();
        return ret;

    } else {
        return new AudioPlaybackSP(ac);

    }
}
