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
    abstract createCapture(mss: AudioNode):
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
        this._null = null;

        // Create the script processor
        const sp = this._sp = _ac.createScriptProcessor(4096, 1, 1);

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
                // Check whether it's playing
                if (!pb._playing && pb._bufLen >= outLen * 2)
                    pb._playing = true;
                if (!pb._playing)
                    continue;

                // Cut the buffer if it's too long
                while (pb._bufLen > outLen * 4) {
                    pb._bufLen -= pb._buf[0][0].length;
                    pb._buf.shift();
                }

                // Copy in data
                let len = 0, remain = outLen;
                while (remain && pb._buf.length) {
                    const inp = pb._buf[0];

                    if (inp[0].length <= remain) {
                        // Use the entire input buffer
                        for (let i = 0; i < out.length; i++) {
                            const oi = out[i];
                            const ii = inp[i%inp.length];
                            for (let s = 0; s < ii.length; s++)
                                oi[len + s] += ii[s];
                        }
                        pb._bufLen -= inp[0].length;
                        pb._buf.shift();
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
                        pb._bufLen -= remain;
                        len += remain;
                        remain = 0;

                    }
                }

                // Possibly stop this one playing
                if (!pb._buf.length)
                    pb._playing = false;
            }

            // Check for clipping
            let max = 1;
            for (let i = 0; i < out.length; i++) {
                const c = out[i];
                for (let s = 0; s < c.length; s++)
                    max = Math.max(max, Math.abs(c[s]));
            }
            if (max > 1) {
                for (let i = 0; i < out.length; i++) {
                    const c = out[i];
                    for (let s = 0; s < c.length; s++)
                        c[s] /= max;
                }
            }
        };

        // Hook it up
        const n = this._null = _ac.createConstantSource();
        n.connect(sp);
        sp.connect(_ac.destination);
        n.start();
    }

    override createCapture(
        mss: AudioNode
    ): Promise<audioCapture.AudioCapture> {
        if (this._capture)
            this._capture.close();
        if (this._null) {
            this._null.stop();
            this._null.disconnect(this._sp);
            this._null = null;
        }
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
        if (this._null) {
            this._null.stop();
            this._null.disconnect(this._sp);
            this._null = null;
        }
        for (const pb of this._playback.slice(0))
            pb.close();
    }

    /**
     * The underlying ScriptProcessor.
     * @private
     */
    _sp: ScriptProcessorNode;

    /**
     * A null source used before input has begun.
     * @private
     */
    _null: ConstantSourceNode;

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
         * The associated audio source.
         */
        public mss: AudioNode
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
        this._bufLen = 0;
        this._buf = [];
        this._playing = false;
    }

    override play(data: Float32Array[]): void {
        if (!this._closed) {
            this._bufLen += data[0].length;
            this._buf.push(data);
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
        this._bufLen = 0;
        this._buf = [];
    }

    /**
     * Set when this has been closed.
     */
    private _closed: boolean;

    /**
     * Size (in samples) of buffers to play.
     * @private
     */
    _bufLen: number;

    /**
     * Buffered data.
     * @private
     */
    _buf: Float32Array[][];

    /**
     * Set while this is playing.
     * @private
     */
    _playing: boolean;
}

/**
 * Create an appropriate audio capture from an AudioContext and a MediaStream.
 * @param ac  The AudioContext for the nodes.
 * @param ms  The MediaStream or AudioNode from which to create a capture.
 */
export async function createAudioCapture(
    ac: AudioContext, ms: MediaStream | AudioNode
): Promise<audioCapture.AudioCapture> {
    if (util.isSafari()) {
        /* Safari's audio subsystem is not to be trusted. It's why we have
         * bidirection capture/playback. */
        const acp: AudioContext & {rteAb?: AudioBidir} = ac;
        let ab = acp.rteAb;
        if (!ab)
            ab = acp.rteAb = new AudioBidirSP(ac);
        let node = <AudioNode> ms;
        if ((<MediaStream> ms).getAudioTracks) {
            // Looks like a MediaStream
            node = ac.createMediaStreamSource(<MediaStream> ms);
        }
        return ab.createCapture(node);
    }

    return audioCapture.createAudioCaptureNoBidir(ac, ms);
}

/**
 * Create an appropriate audio playback from an AudioContext.
 */
export async function createAudioPlayback(
    ac: AudioContext
): Promise<audioPlayback.AudioPlayback> {
    if (util.isSafari()) {
        // Use the bidir that was (hopefully) created with the capture
        const acp: AudioContext & {rteAb?: AudioBidir} = ac;
        let ab = acp.rteAb;
        if (!ab)
            ab = acp.rteAb = new AudioBidirSP(ac);
        return ab.createPlayback();
    }

    return audioPlayback.createAudioPlaybackNoBidir(ac);
}

/**
 * Test for whether a shared, bidirectional node will be used.
 */
export function audioCapturePlaybackShared() {
    return util.isSafari();
}
