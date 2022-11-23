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

import * as audioCapture from "./audio-capture";
import * as audioPlayback from "./audio-playback";
import * as util from "./util";

/**
 * Bidirectional audio capture and playback in a single node.
 */
export abstract class AudioBidir {
    /**
     * Create a new capture node associated with this bidirectional node.
     */
    abstract createCapture(mss: MediaStreamAudioSourceNode):
        Promise<audioCapture.AudioCapture>;

    /**
     * Create a new playback node associated with this bidirectional node.
     */
    abstract createPlayback(): Promise<audioPlayback.AudioPlayback>;

    /**
     * Get the underlying audio node.
     */
    abstract node(): AudioNode;

    /**
     * Stop, disconnect, and dismantle this AudioBidir.
     */
    abstract close(): void;
}


/**
 * Bidirectional audio node using a ScriptProcessor.
 */
export class AudioBidirSP extends AudioBidir {
    constructor(
        /**
         * AudioContext on which to create the node.
         * @private
         */
        public _ac: AudioContext
    ) {
        super();

        // Set up our buffers
        this._capture = null;
        this._playback = [];

        // Create the script processor
        const sp = this._sp = _ac.createScriptProcessor(1024, 1, 1);

        // Set up its event
        sp.onaudioprocess = ev => {
            if (this._capture) {
                this._capture.emitEvent(
                    "data", [ev.inputBuffer.getChannelData(0)]);
            }

            const pbs = this._playback.length;
            if (!pbs)
                return;

            // Get our output buffers
            const out: Float32Array[] = [];
            for (let i = 0; i < ev.outputBuffer.numberOfChannels; i++) {
                out.push(ev.outputBuffer.getChannelData(i));
            }
            const outLen = out[0].length;

            // Mix the output
            for (const pb of this._playback) {
                // Normalize the buffer
                if (pb._bufferedSamples < outLen)
                    continue;
                while (pb._bufferedSamples > outLen * 4) {
                    pb._bufferedSamples -= pb._buffer[0][0].length;
                    pb._buffer.shift();
                }

                // Go through buffers
                let len = 0, remain = outLen;
                while (remain && pb._buffer.length) {
                    const inp = pb._buffer[0];

                    if (inp[0].length <= remain) {
                        // Use the entire input buffer
                        for (let i = 0; i < out.length; i++) {
                            const oi = out[i];
                            const ii = inp[i%inp.length];
                            for (let s = 0; s < ii.length; s++)
                                oi[len + s] += ii[s];
                        }
                        pb._bufferedSamples -= inp[0].length;
                        pb._buffer.shift();
                        len += inp[0].length;
                        remain -= inp[0].length;

                    } else {
                        // Use part of the input buffer
                        for (let i = 0; i < out.length; i++) {
                            const oi = out[i];
                            const ii = inp[i%inp.length];
                            for (let s = 0; s < remain; s++)
                                oi[len + s] += ii[s];
                        }
                        for (let i = 0; i < inp.length; i++)
                            inp[i] = inp[i].subarray(remain)
                        pb._bufferedSamples -= remain;
                        len += remain;
                        remain = 0;

                    }
                }

                // Check for clipping
                let max = 1;
                for (let i = 0; i < out.length; i++) {
                    const cmax = Math.max.apply(Math,
                        Array.prototype.map.apply(
                            out, Math.abs
                        )
                    );
                    max = Math.max(max, cmax);
                }
                if (max > 1) {
                    for (let i = 0; i < out.length; i++) {
                        const ch = out[i];
                        for (let s = 0; s < ch.length; s++)
                            ch[s] /= max;
                    }
                }
            }
        };

        // Hook it up
        sp.connect(_ac.destination);
    }

    override createCapture(
        mss: MediaStreamAudioSourceNode
    ): Promise<audioCapture.AudioCapture> {
        if (this._capture)
            this._capture.close();
        return Promise.resolve(
            this._capture = new AudioBidirSPCapture(this, mss)
        );
    }

    override createPlayback(): Promise<audioPlayback.AudioPlayback> {
        const ret = new AudioBidirSPPlayback(this);
        this._playback.push(ret);
        return Promise.resolve(ret);
    }

    override node() { return this._sp; }

    override close() {
        this._sp.disconnect(this._ac.destination);
        if (this._capture)
            this._capture.close();
        for (const pb of this._playback.slice(0))
            pb.close();
    }

    /**
     * The underlying ScriptProcessor.
     * @private
     */
    _sp: ScriptProcessorNode;

    /**
     * The associated capture node, if any.
     * @private
     */
    _capture: AudioBidirSPCapture;

    /**
     * The associated playback nodes.
     * @private
     */
    _playback: AudioBidirSPPlayback[];
}

/**
 * Capture node using a shared script processor.
 */
class AudioBidirSPCapture extends audioCapture.AudioCapture {
    constructor(
        /**
         * The owner of this node.
         */
        public parent: AudioBidirSP,

        /**
         * The associated MediaStreamAudioSourceNode.
         */
        public mss: MediaStreamAudioSourceNode
    ) {
        super();
        mss.connect(parent._sp);
    }

    override getSampleRate(): number {
        return this.parent._ac.sampleRate;
    }

    override close(): void {
        if (this.parent._capture === this) {
            this.parent._capture = null;
            this.mss.disconnect(this.parent._sp);
        }
    }
}

/**
 * Playback node using a shared script processor.
 */
class AudioBidirSPPlayback extends audioPlayback.AudioPlayback {
    constructor(
        /**
         * The owner of this node.
         */
        public parent: AudioBidirSP
    ) {
        super();
        this._closed = false;
        this._bufferedSamples = 0;
        this._buffer = [];
    }

    override play(data: Float32Array[]): void {
        if (!this._closed) {
            this._bufferedSamples += data[0].length;
            this._buffer.push(data);
        }
    }

    override channels(): number {
        return 1;
    }

    override sharedNode(): AudioNode {
        return this.parent.node();
    }

    override close(): void {
        const p = this.parent;
        for (let i = 0; i < p._playback.length; i++) {
            if (this === p._playback[i]) {
                p._playback.splice(i, 1);
                break;
            }
        }
        this._closed = true;
        this._bufferedSamples = 0;
        this._buffer = [];
    }

    /**
     * Set when this has been closed.
     */
    private _closed: boolean;

    /**
     * Size (in samples) of buffers to play.
     * @private
     */
    _bufferedSamples: number;

    /**
     * Buffered data.
     * @private
     */
    _buffer: Float32Array[][];
}

/**
 * Create an appropriate audio capture from an AudioContext and a MediaStream.
 * @param ac  The AudioContext for the nodes.
 * @param ms  The MediaStream from which to create a capture.
 */
export async function createAudioCapture(
    ac: AudioContext, ms: MediaStream
): Promise<audioCapture.AudioCapture> {
    if (util.isSafari()) {
        /* Safari's audio subsystem is not to be trusted. It's why we have
         * bidirection capture/playback. */
        const acp: AudioContext & {rteAb?: AudioBidir} = ac;
        let ab = acp.rteAb;
        if (!ab)
            ab = acp.rteAb = new AudioBidirSP(ac);
        const mss = ac.createMediaStreamSource(ms);
        return ab.createCapture(mss);
    }

    return audioCapture.createAudioCaptureNoBidir(ac, ms);
}

/**
 * Create an appropriate audio playback from an AudioContext.
 */
export async function createAudioPlayback(
    ac: AudioContext
): Promise<audioPlayback.AudioPlayback> {
    if (util.isSafari) {
        // Use the bidir that was (hopefully) created with the capture
        const acp: AudioContext & {rteAb?: AudioBidir} = ac;
        let ab = acp.rteAb;
        if (!ab)
            ab = acp.rteAb = new AudioBidirSP(ac);
        return ab.createPlayback();
    }

    return audioPlayback.createAudioPlaybackNoBidir(ac);
}
