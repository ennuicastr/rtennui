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

import * as abstractRoom from "./abstract-room";
import * as audioPlayback from "./audio-playback";
import * as net from "./net";
import {protocol as prot} from "./protocol";
import * as util from "./util";
import * as videoPlayback from "./video-playback";

import type * as libavT from "libav.js";
declare let LibAV: libavT.LibAVWrapper;
import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

/**
 * A single libav instance used to resample.
 */
let resampler: libavT.LibAV = null;

export async function load() {
    resampler = await LibAV.LibAV();
}

/**
 * A single peer.
 */
export class Peer {
    constructor(
        /**
         * The room this peer is in.
         */
        public room: abstractRoom.AbstractRoom,

        /**
         * The ID of this peer.
         */
        public id: number
    ) {
        this.streamId = -1;
        this.playing = false;
        this.stream = null;
        this.data = null;
        this.offset = 0;
        this.tracks = null;
        this.rtc = null;
        this.rtcMakingOffer = false;
        this.rtcIgnoreOffer = false;
        this.reliable = this.unreliable = null;
    }

    /**
     * Disconnect/close/shut down this user.
     */
    async close() {
        await this.closeStream();
        if (this.rtc) {
            this.rtc.close();
            this.rtc = null;
        }
    }

    /**
     * Establish peer-to-peer connections.
     */
    async p2p() {
        // Create the RTCPeerConnection
        let peer: RTCPeerConnection = this.rtc;
        if (!peer) {
            peer = this.rtc = new RTCPeerConnection({
                iceServers: util.iceServers
            });

            // Perfect negotiation pattern
            peer.onnegotiationneeded = async () => {
                try {
                    this.rtcMakingOffer = true;
                    await peer.setLocalDescription();
                    const p = prot.parts.rtc;
                    const data = util.encodeText(
                        JSON.stringify({
                            description: peer.localDescription
                        })
                    );
                    const msg = net.createPacket(
                        p.length + data.length,
                        this.id, prot.ids.rtc,
                        [[p.data, data]]
                    );
                    this.room._sendServer(msg);

                } catch (ex) {
                    console.error(ex);

                }

                this.rtcMakingOffer = false;
            };

            peer.onicecandidate = ev => {
                const p = prot.parts.rtc;
                const data = util.encodeText(
                    JSON.stringify({
                        candidate: ev.candidate
                    })
                );
                const msg = net.createPacket(
                    p.length + data.length,
                    this.id, prot.ids.rtc,
                    [[p.data, data]]
                );
                this.room._sendServer(msg);
            };

            // Incoming data channels
            peer.ondatachannel = ev => {
                const chan = ev.channel;
                chan.binaryType = "arraybuffer";
                if (chan.label === "reliable")
                    chan.onmessage = ev => this.onMessage(ev, true);
                else
                    chan.onmessage = ev => this.onMessage(ev, false);
            };
        }

        // Outgoing data channels
        if (!this.reliable) {
            const chan = peer.createDataChannel("reliable");
            chan.binaryType = "arraybuffer";

            chan.addEventListener("open", () => {
                this.reliable = chan;
                this.p2p();
            }, {once: true});

            chan.addEventListener("close", () => {
                if (this.reliable === chan) {
                    this.reliable = null;

                    const p = prot.parts.peer;
                    const msg = net.createPacket(
                        p.length, this.id, prot.ids.peer,
                        [[p.status, 1, 0]]
                    );
                    this.room._sendServer(msg);
                }
            }, {once: true});

            // Only do one at a time
            return;
        }

        if (!this.unreliable) {
            const chan = peer.createDataChannel("unreliable", {
                ordered: false,
                maxRetransmits: 0
            });
            chan.binaryType = "arraybuffer";

            chan.addEventListener("open", () => {
                this.unreliable = chan;
                this.p2p();
            }, {once: true});

            chan.addEventListener("close", () => {
                if (this.unreliable === chan) {
                    this.unreliable = null;

                    const p = prot.parts.peer;
                    const msg = net.createPacket(
                        p.length, this.id, prot.ids.peer,
                        [[p.status, 1, 0]]
                    );
                    this.room._sendServer(msg);
                }
            }, {once: true});

            return;
        }

        // Everything's open, inform the server
        {
            const p = prot.parts.peer;
            const msg = net.createPacket(
                p.length, this.id, prot.ids.peer,
                [[p.status, 1, 1]]
            );
            this.room._sendServer(msg);
        }
    }

    /**
     * Handler for incoming RTC negotiation messages from this user.
     */
    async rtcRecv(pkt: DataView) {
        const selfId = this.room._getOwnId();
        const polite = selfId > this.id;

        // Get out the data
        const p = prot.parts.rtc;
        let msg: any = null;
        try {
            const msgU8 = (new Uint8Array(pkt.buffer)).subarray(p.data);
            const msgS = util.decodeText(msgU8);
            msg = JSON.parse(msgS);
        } catch (ex) {}
        if (!msg)
            return;

        // Perfect negotiation pattern
        const peer: RTCPeerConnection = this.rtc;
        try {
            if (msg.description) {
                const offerCollision =
                    (msg.description.type === "offer") &&
                    (this.rtcMakingOffer ||
                     peer.signalingState !== "stable");
                const ignoreOffer = this.rtcIgnoreOffer =
                    !polite && offerCollision;
                if (ignoreOffer)
                    return;

                await peer.setRemoteDescription(msg.description);
                if (msg.description.type === "offer") {
                    await peer.setLocalDescription();

                    const p = prot.parts.rtc;
                    const data = util.encodeText(
                        JSON.stringify({
                            description: peer.localDescription
                        })
                    );
                    const msg = net.createPacket(
                        p.length + data.length,
                        this.id, prot.ids.rtc,
                        [[p.data, data]]
                    );
                    this.room._sendServer(msg);
                }

            } else if (msg.candidate) {
                try {
                    await peer.addIceCandidate(msg.candidate);
                } catch (ex) {
                    if (!this.rtcIgnoreOffer)
                        throw ex;
                }

            }

        } catch (ex) {
            console.error(ex);

        }
    }

    /**
     * Handler for incoming messages from this peer.
     */
    onMessage(ev: MessageEvent<ArrayBuffer>, reliable: boolean) {
        const msg = new DataView(ev.data);
        if (msg.byteLength < 4)
            return;

        // Only data is allowed on the direct connection
        const cmd = msg.getUint16(2, true);
        if (cmd !== prot.ids.data)
            return;

        this.recv(msg);
    }

    /**
     * Initialize this peer's incoming data with a new stream.
     */
    async newStream(ac: AudioContext, id: number, info: any) {
        const self = this;

        await this.closeStream();
        this.streamId = id;
        this.playing = false;
        this.stream = info;
        this.data = [];
        this.offset = 0;

        const tracks = this.tracks = info.map(() => new Track);

        this.room.emitEvent("stream-started", {
            peer: this.id
        });

        // Initialize the metadata
        for (let i = 0; i < tracks.length; i++) {
            const trackInfo = info[i];
            const track = tracks[i];

            if (trackInfo.codec[0] === "v") {
                // Video track
                track.video = true;

                // Figure out the codec
                let codec: any;
                if (trackInfo.codec === "vh263.2") {
                    codec = {libavjs:{
                        codec: "h263p"
                    }};
                } else {
                    codec = trackInfo.codec.slice(1);
                }

                // Find an environment
                const config: wcp.VideoDecoderConfig = {
                    codec
                };
                let env: wcp.VideoDecoderEnvironment = null;
                try {
                    env = track.env =
                        await LibAVWebCodecs.getVideoDecoder(config);
                } catch (ex) {}
                if (!env) continue;

                const player = track.player =
                    await videoPlayback.createVideoPlayback();

                this.room.emitEvent("track-started-video", {
                    peer: this.id,
                    id: i,
                    element: player.element()
                });

                // Set up the decoder
                const dec = track.decoder = new Decoder();
                dec.decoder = new env.VideoDecoder({
                    output: data => dec.output(data),
                    error: error => dec.error(error)
                });
                await dec.decoder.configure(config);

            } else if (trackInfo.codec[0] === "a") {
                // Audio track
                if (trackInfo.codec !== "aopus") {
                    // Unsupported
                    continue;
                }

                // Set up the player
                const player = track.player =
                    await audioPlayback.createAudioPlayback(ac);

                this.room.emitEvent("track-started-audio", {
                    peer: this.id,
                    id: i,
                    node: player.node()
                });

                // Set up the decoder
                const dec = track.decoder = new Decoder();
                dec.decoder = new LibAVWebCodecs.AudioDecoder({
                    output: data => dec.output(data),
                    error: error => dec.error(error)
                });
                await dec.decoder.configure({
                    codec: "opus",
                    sampleRate: 48000,
                    numberOfChannels: 1
                });

                // Set up the resampler
                const pChannels = player.channels();
                track.resampler = await resampler.ff_init_filter_graph(
                    "anull",
                    {
                        sample_fmt: resampler.AV_SAMPLE_FMT_FLTP,
                        sample_rate: 48000,
                        channel_layout: 4
                    },
                    {
                        sample_fmt: resampler.AV_SAMPLE_FMT_FLTP,
                        sample_rate: ac.sampleRate,
                        channel_layout:
                            (pChannels === 1)
                            ? 4
                            : ((1<<pChannels)-1)
                    }
                );
                track.framePtr = await resampler.av_frame_alloc();

            }

        }
    }

    /**
     * Close this peer's stream.
     */
    async closeStream() {
        if (this.streamId < 0)
            return;

        this.streamId = -1;

        for (let i = 0; i < this.tracks.length; i++) {
            const track = this.tracks[i];

            if (track.player) {
                const player = track.player;
                if (player instanceof videoPlayback.VideoPlayback) {
                    this.room.emitEvent("track-ended-video", {
                        peer: this.id,
                        id: i,
                        element: player.element()
                    });

                } else {
                    this.room.emitEvent("track-ended-audio", {
                        peer: this.id,
                        id: i,
                        node: player.node()
                    });

                }
            }

            if (track.decoder)
                await track.decoder.decoder.close();

            if (track.resampler)
                await resampler.avfilter_graph_free_js(track.resampler[0]);
            if (track.framePtr)
                await resampler.av_frame_free_js(track.framePtr);
        }
        this.tracks = null;

        this.room.emitEvent("stream-ended", {
            peer: this.id
        });
    }

    /**
     * Called when data for this peer is received.
     */
    recv(data: DataView) {
        try {
            const p = prot.parts.data;
            const info = data.getUint8(p.info);
            const streamId = info & 0x70;
            if (streamId !== this.streamId)
                return;
            const key = !!(info & 0x80);
            const trackIdx = info & 0x0F;

            const datau8 = new Uint8Array(data.buffer);
            const offset = {offset: p.data};
            const idx = util.decodeNetInt(datau8, offset);

            if (this.data.length === 0)
                this.offset = idx;

            const idxOffset = idx - this.offset;

            if (idxOffset < 0 || idxOffset >= 1024)
                return;

            while (this.data.length <= idxOffset)
                this.data.push(null);

            this.data[idxOffset] = new IncomingData(
                trackIdx, idx, key, datau8.slice(offset.offset));
            this.tracks[trackIdx].duration +=
                this.stream[trackIdx].frameDuration;

            this.decodeMany();

            if (!this.playing)
                this.play();

        } catch (ex) {}
    }

    /**
     * Decode as much as is reasonable of the input.
     */
    decodeMany() {
        for (const packet of this.data) {
            // If we don't have this packet, we can't decode past it
            if (!packet)
                break;

            // If we're already decoding this packet, don't decode it again
            if (packet.decoding)
                continue;

            this.decodeOne(packet);
        }
    }

    /**
     * Decode a single packet.
     */
    decodeOne(packet: IncomingData, opts: {
        force?: boolean
    } = {}) {
        const track = this.tracks[packet.trackIdx];

        // Get (but don't overload) the decoder
        const decoder = track.decoder;
        if (!decoder)
            return;
        if (decoder.decoder.decodeQueueSize > 1 && !opts.force)
            return;
        packet.decoding = true;

        // Send it for decoding
        let chunk: wcp.EncodedVideoChunk | wcp.EncodedAudioChunk;
        if (track.video) {
            if (decoder.keyChunkRequired && !packet.key) {
                // Not decodable
                packet.decoded = new decoder.env.VideoFrame(
                    new Uint8Array(640 * 360 * 4), {
                    format: <any> "RGBA",
                    codedWidth: 640,
                    codedHeight: 360,
                    timestamp: 0
                });
                packet.decodingRes();
                return;

            } else {
                decoder.keyChunkRequired = false;
                chunk = new decoder.env.EncodedVideoChunk({
                    data: packet.encoded,
                    type: <any> (packet.key ? "key" : "delta"),
                    timestamp: 0
                });

            }

        } else {
            chunk = new LibAVWebCodecs.EncodedAudioChunk({
                data: packet.encoded,
                type: <any> "key",
                timestamp: 0
            });

        }

        // Only decode if it's not overloaded
        if (decoder.decoder.decodeQueueSize > 1) {
            packet.decodingRes();
            return;
        }

        // Decode
        decoder.decoder.decode(chunk);

        // And receive it
        if (track.video) {
            decoder.get().then(frame => {
                packet.decoded = <wcp.VideoFrame> frame;
                packet.decodingRes();
            });

        } else {
            decoder.get().then(async halfDecoded => {
                // Convert it to a libav frame
                const copy: wcp.AudioDataCopyToOptions = {
                    format: <any> "f32-planar",
                    planeIndex: 0
                };
                const buf = new Float32Array(
                    new ArrayBuffer(halfDecoded.allocationSize(copy)));
                halfDecoded.copyTo(buf, copy);
                halfDecoded.close();

                const frame: libavT.Frame = {
                    data: [buf],
                    format: resampler.AV_SAMPLE_FMT_FLTP,
                    sample_rate: 48000,
                    channel_layout: 4,
                    pts: 0,
                    ptshi: 0
                };

                // Resample it
                const fframes =
                    await resampler.ff_filter_multi(
                        track.resampler[1],
                        track.resampler[2],
                        track.framePtr,
                        [frame]
                    );

                if (fframes.length !== 1)
                    console.error("[ERROR] Number of frames is not 1");

                packet.decoded = fframes[0].data;
                packet.decodingRes();
            });

        }
    }

    /**
     * Get the next packet of data.
     */
    shift() {
        while (this.data.length) {
            const next = this.data.shift();
            this.offset++;
            if (next) {
                const track = this.tracks[next.trackIdx];
                track.duration -= 
                    this.stream[next.trackIdx].frameDuration;
                return next;
            }
        }
        return null;
    }

    /**
     * Play or continue playing the stream. If not currently playing, this
     * method will do nothing unless there's enough input data.
     */
    async play() {
        // Should we be playing?
        if (Math.max.apply(Math, this.tracks.map(x => x.duration)) < 100000
            /* FIXME: Magic number */)
            return;
        this.playing = true;

        while (true) {
            // Do we have too much data?
            while (Math.max.apply(Math, this.tracks.map(x => x.duration)) >= 200000
                   /* FIXME: Magic number */) {
                this.shift();
            }

            // Get a chunk
            const chunk = this.shift();

            // Are we out of data?
            if (!chunk) {
                this.playing = false;
                return;
            }

            // Make sure it's decoding/ed
            if (!chunk.decoding)
                this.decodeOne(chunk, {force: true});

            this.data.shift();
            this.offset++;

            if (chunk.idealTimestamp < 0) {
                chunk.idealTimestamp = performance.now();
            } else {
                // Wait until we're actually supposed to be playing this chunk
                const wait = chunk.idealTimestamp - performance.now();
                if (wait > 0)
                    await new Promise(res => setTimeout(res, wait));
            }

            // Decode and present it in the background
            (async () => {
                // Make sure it's decoded
                await chunk.decodingPromise;
                if (!chunk.decoded)
                    return;

                // And play it
                const track = this.tracks[chunk.trackIdx];
                if (track.video) {
                    (<videoPlayback.VideoPlayback> track.player)
                        .display(<wcp.VideoFrame> chunk.decoded);
                    (<wcp.VideoFrame> chunk.decoded).close();

                } else {
                    (<audioPlayback.AudioPlayback> track.player)
                        .play(<Float32Array[]> chunk.decoded);

                }
            })();

            // Set the time on the next relevant packet
            for (const next of this.data) {
                if (next && next.trackIdx === chunk.trackIdx) {
                    next.idealTimestamp = chunk.idealTimestamp +
                        Math.round(this.stream[chunk.trackIdx].frameDuration / 1000);
                    break;
                }
            }
        }
    }

    /**
     * The stream we're currently receiving from this peer, if any.
     */
    streamId: number;

    /**
     * True if the current stream is actually playing right now.
     */
    playing: boolean;

    /**
     * The stream information.
     */
    stream: any[];

    /**
     * Incoming data.
     */
    data: IncomingData[];

    /**
     * Offset of the data (i.e., index of the first packet)
     */
    offset: number;

    /**
     * Each track's information.
     */
    tracks: Track[];

    /**
     * The RTC connection to this peer.
     */
    rtc: RTCPeerConnection;

    /**
     * Perfect negotiation: Are we making an offer?
     */
    rtcMakingOffer: boolean;

    /**
     * Perfect negotiation: Are we ignoring offers?
     */
    rtcIgnoreOffer: boolean;

    /**
     * The reliable connection to this peer.
     */
    reliable: RTCDataChannel;

    /**
     * The unreliable connection to this peer.
     */
    unreliable: RTCDataChannel;
}

/**
 * An individual track within a peer's stream.
 */
class Track {
    constructor() {
        this.video = false;
        this.duration = 0;
        this.decoder = null;
        this.resampler = null;
        this.framePtr = 0;
        this.player = null;
    }

    /**
     * Is this a video track?
     */
    video: boolean;

    /**
     * The duration of data that we have for this track.
     */
    duration: number;

    /**
     * Decoder for this track.
     */
    decoder: Decoder;

    /**
     * If needed, resampler for this track.
     */
    resampler: number[];

    /**
     * Frame pointer, needed if we're using a resampler.
     */
    framePtr: number;

    /**
     * Player for this track.
     */
    player: audioPlayback.AudioPlayback | videoPlayback.VideoPlayback;
}

/**
 * Incoming data, whether audio or video.
 */
class IncomingData {
    constructor(
        /**
         * The track number to which this packet belongs.
         */
        public trackIdx: number,

        /**
         * The index of this packet.
         */
        public index: number,

        /**
         * Is this a keyframe?
         */
        public key: boolean,

        /**
         * The raw data off the wire.
         */
        public encoded: BufferSource
    ) {
        this.decoded = null;
        this.idealTimestamp = -1;
        this.decoding = false;
        this.decodingPromise =
            new Promise<void>(res => this.decodingRes = res);
    }

    /**
     * The actual displayable data.
     */
    decoded: Float32Array[] | wcp.VideoFrame;

    /**
     * The ideal timestamp at which to display this.
     */
    idealTimestamp: number;

    /**
     * Set when this has been sent for decoding.
     */
    decoding: boolean;

    /**
     * A promise that resolves when the decoded data is available.
     */
    decodingPromise: Promise<void>;

    /**
     * And the function to call to resolve the above promise.
     */
    decodingRes: () => void;
}

/**
 * A decoder with surrounding information.
 */
class Decoder {
    constructor() {
        this.keyChunkRequired = true;
        this.env = null;
        this.decoder = null;
        this.waiters = [];
        this.buf = [];
    }

    /**
     * Output callback for the decoder.
     */
    output(data: wcp.AudioData | wcp.VideoFrame) {
        this.buf.push(data);
        if (this.waiters.length)
            this.waiters.shift()();
    }

    /**
     * Error callback for the decoder.
     */
    error(error: DOMException) {
        // ... FIXME ...
    }

    /**
     * Asynchronously get a decoded packet.
     */
    async get() {
        if (!this.waiters.length && this.buf.length)
            return this.buf.shift();
        await new Promise<void>(res => this.waiters.push(res));
        return this.buf.shift();
    }

    /**
     * Set at the beginning when we still need a key chunk to start decoding.
     */
    keyChunkRequired: boolean;

    env: wcp.VideoDecoderEnvironment;
    decoder: wcp.AudioDecoder | wcp.VideoDecoder;
    waiters: (() => void)[];
    buf: (wcp.AudioData | wcp.VideoFrame)[];
}
