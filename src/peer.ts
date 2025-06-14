// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2021-2025 Yahweasel
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

import * as weasound from "weasound";

import * as abstractRoom from "./abstract-room";
import * as net from "./net";
import * as pingingSocket from "./pinging-socket";
import {protocol as prot} from "./protocol";
import * as util from "./util";
import * as videoPlayback from "./video-playback";

import type * as libavT from "libav.js";
declare let LibAV: libavT.LibAVWrapper;
import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

/**
 * Time between pinging peer channels.
 */
const pingTime = 1000;

/**
 * The duration before forgetting a drop report.
 */
const dropForgetTimeout = 5000;

/**
 * A single libav instance used to resample.
 * @private
 */
let resampler: libavT.LibAV | null = null;

export async function load() {
    resampler = await LibAV.LibAV();
}

/**
 * A single peer.
 * @private
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
        this.promise = Promise.all([]);
        this.p2pPromise = Promise.all([]);
        this.p2pReconnectPending = false;
        this.closed = false;
        this.streamId = -1;
        this.playing = false;
        this.resume = null;
        this.stream = null;
        this.data = null;
        this.offset = 0;
        this.offsetByTrack = {};

        this.tracks = null;
        this.audioLatency = 0;
        this.rtc = null;
        this.rtcMakingOffer = false;
        this.rtcIgnoreOffer = false;
        this.reliable = this.semireliable = this.unreliable = null;
        this.reliability = net.Reliability.SEMIRELIABLE;
        this.lastReliableRelayTime = 0;
        this._currentBuffer = 0;

        this.newOutgoingStream();
        this._inAckInterval = setInterval(() => this._checkInAcks(), 1000);
    }

    /**
     * Disconnect/close/shut down this user.
     * @private
     */
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.closeStream();
        if (this._inAckInterval) {
            clearInterval(this._inAckInterval);
            this._inAckInterval = null;
        }
        this.promise = this.promise.then(async () => {
            if (this.rtc) {
                this.rtc.close();
                this.rtc = null;
            }
        }).catch(console.error);
        await this.promise;
    }

    /**
     * Establish peer-to-peer connections.
     * @private
     */
    async p2p(opts: {
        forceCompleteReconnect?: boolean
    } = {}) {
        if (this.closed)
            return;

        // Force a complete reconnect if asked
        if (this.rtc && opts.forceCompleteReconnect) {
            this.p2pReconnectPending = false;

            // Completely drop the old RTC instance and try again
            this.rtc.close();
            this.rtc = null;
            this.reliable = this.semireliable = this.unreliable = null;
        }

        if (this.p2pReconnectPending) {
            await this.p2pPromise;
            return;
        }

        this.p2pReconnectPending = true;
        this.p2pPromise = this.p2pPromise.then(async () => {
            // Create the RTCPeerConnection
            if (!this.rtc) {
                const peer = this.rtc = new RTCPeerConnection({
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
                        chan.onmessage = ev => this.onMessage(ev, chan, true);
                    else
                        chan.onmessage = ev => this.onMessage(ev, chan, false);
                };
            }

            // Outgoing data channels
            try {
                if (!this.unreliable) {
                    const chan = await this.p2pChannel("unreliable", {
                        ordered: false,
                        maxRetransmits: 0
                    }, chan => {
                        if (this.unreliable && this.unreliable.socket === chan)
                            this.unreliable = null;
                    });
                    const ps = this.unreliable = new pingingSocket.PingingSocket(
                        chan, pingTime, 1
                    );
                    ps.onmessage = ev => this.onMessage(ev, chan, false);
                }
            } catch (ex) {
                // Unreliable connection failed, try again
                this.p2p({forceCompleteReconnect: true});
                return;
            }

            try {
                if (!this.semireliable &&
                    this.reliability > net.Reliability.UNRELIABLE) {
                    const chan = await this.p2pChannel("semireliable", {
                        ordered: false,
                        maxRetransmits: 1
                    }, chan => {
                        if (this.semireliable && this.semireliable.socket === chan)
                            this.semireliable = null;
                    });
                    const ps = this.semireliable = new pingingSocket.PingingSocket(
                        chan, pingTime, 1
                    );
                    ps.onmessage = ev => this.onMessage(ev, chan, false);
                }

                if (!this.reliable &&
                    this.reliability > net.Reliability.UNRELIABLE) {
                    const chan = await this.p2pChannel("reliable", {
                        ordered: false
                    }, chan => {
                        if (this.reliable && this.reliable.socket === chan)
                            this.reliable = null;
                    });
                    const ps = this.reliable = new pingingSocket.PingingSocket(
                        chan, pingTime, 1
                    );
                    ps.onmessage = ev => this.onMessage(ev, chan, true);
                }

            } catch (ex) {
                // If any of this fails, we simply try again
                this.p2p({forceCompleteReconnect: true});
                return;
            }

            // Everything's open, inform the server
            {
                this.room.emitEvent("peer-p2p-connected", {
                    peer: this.id,
                    reliability: net.reliabilityStr(this.reliability)
                });

                const p = prot.parts.peer;
                const msg = net.createPacket(
                    p.length, this.id, prot.ids.peer,
                    [[p.status, 1, this.reliable ? 1 : 0]]
                );
                this.room._sendServer(msg);
            }

        }).catch(console.error).then(async () => {
            this.p2pReconnectPending = false;

        });

        await this.p2pPromise;
    }

    /**
     * Establish a single peer-to-peer connection.
     * @private
     * @param label  The name for the channel.
     * @param options  Options passed to createDataChannel.
     * @param onclose  Function to call when this connection is closed (as well
     *                 as reporting it and reconnecting).
     */
    async p2pChannel(
        label: string, options: any, onclose: (chan: RTCDataChannel) => unknown
    ): Promise<RTCDataChannel> {
        return new Promise((res, rej) => {
            const chan = this.rtc!.createDataChannel(label, options);
            chan.binaryType = "arraybuffer";
            let opened = false;

            let connTimeout: number | null = setTimeout(() => {
                // Failed to connect in time!
                connTimeout = null;
                this.reliability = net.Reliability.UNRELIABLE;
                if (this.reliable) {
                    this.reliable.close();
                    this.reliable = null;
                }
                rej(new Error);
            }, 10000);

            chan.addEventListener("open", () => {
                if (!connTimeout) {
                    // Too late, timed out
                    chan.close();
                    return;
                } else {
                    clearTimeout(connTimeout);
                }

                opened = true;
                res(chan);

            }, {once: true});

            chan.addEventListener("close", () => {
                if (!opened)
                    return;
                opened = false;

                onclose(chan);

                this.room.emitEvent("peer-p2p-disconnected", {
                    peer: this.id
                });

                const p = prot.parts.peer;
                const msg = net.createPacket(
                    p.length, this.id, prot.ids.peer,
                    [[p.status, 1, 0]]
                );
                this.room._sendServer(msg);

                this.p2p();
            }, {once: true});
        });
    }


    /**
     * Handler for incoming RTC negotiation messages from this user.
     * @private
     * @param pkt  Received packet.
     */
    async rtcRecv(pkt: DataView) {
        this.promise = this.promise.then(async () => {
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
            const peer: RTCPeerConnection = this.rtc!;
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
        }).catch(console.error);

        await this.promise;
    }

    /**
     * Handler for incoming messages from this peer.
     * @private
     * @param ev  Event containing the received message.
     * @param chan  The channel this message was received on.
     * @param reliable  True if this was sent over a reliable connection.
     */
    onMessage(
        ev: MessageEvent<ArrayBuffer>, chan: RTCDataChannel, reliable: boolean
    ) {
        const msg = new DataView(ev.data);
        if (msg.byteLength < 4)
            return;

        // Get the command
        const cmd = msg.getUint16(2, true);

        switch (cmd) {
            case prot.ids.ack:
                this.recvAck(msg);
                break;

            case prot.ids.info:
                this.recvInfo(msg);
                break;

            case prot.ids.data:
                this.recvData(msg);
                break;

            case prot.ids.ctcp:
                this.recvCTCP(msg);
                break;

            case prot.ids.ping:
                // Reverse to a pong
                msg.setUint16(2, prot.ids.pong, true);
                chan.send(msg.buffer);
                break;

            case prot.ids.pong:
                this.recvPong(chan);
                break;
        }
    }

    /**
     * Initialize this peer's incoming data with a new stream.
     * @private
     * @param ac  AudioContext on which to play the stream.
     * @param id  ID of the stream.
     * @param info  Track info given by the peer.
     * @param opts  Room options.
     */
    async newStream(ac: AudioContext, id: number, info: any, opts: any) {
        this.closeStream();

        this.promise = this.promise.then(async () => {
            this.playing = false;
            this.data = [];
            this.offset = 0;
            this.offsetByTrack = {};

            const tracks: (Track | null)[] =
                info.map(() => new Track);

            this.room.emitEvent("stream-started", {
                peer: this.id
            });

            // Initialize the metadata
            let firstAudioTrack = true;
            for (let i = 0; i < tracks.length; i++) {
                const trackInfo = info[i];
                const track = tracks[i]!;

                if (trackInfo.codec[0] === "v") {
                    // Video track
                    track.video = true;

                    // Figure out the codec
                    let codec = trackInfo.codec.slice(1);
                    let wcCodec = codec;
                    if (codec === "vp8lo") {
                        /* vp8lo is an internal name for "VP8, but be gentle,
                         * because there will be software decoders" */
                        wcCodec = "vp8";
                    }

                    // Find a decoding environment
                    const config: wcp.VideoDecoderConfig = {
                        codec: wcCodec
                    };
                    let env: wcp.VideoDecoderEnvironment | null = null;
                    try {
                        env = await LibAVWebCodecs.getVideoDecoder(config);
                    } catch (ex) {}

                    const player = track.player =
                        await videoPlayback.createVideoPlayback(
                            codec,
                            trackInfo.width || 640, trackInfo.height || 360
                        );

                    if (!player) {
                        tracks[i] = null;
                        continue;
                    } else if (!player.selfDecoding() && !env) {
                        player.close();
                        tracks[i] = null;
                        continue;
                    }

                    this.room.emitEvent("track-started-video", {
                        peer: this.id,
                        id: i,
                        element: player.element()
                    });

                    // Set up the decoder
                    if (env) {
                        const dec = track.decoder = new Decoder();
                        dec.envV = env;
                        dec.config = config;
                        await dec.init();
                    }

                } else if (trackInfo.codec[0] === "a") {
                    // Audio track
                    if (trackInfo.codec !== "aopus") {
                        // Unsupported
                        tracks[i] = null;
                        continue;
                    }

                    const config: wcp.AudioDecoderConfig = {
                        codec: "opus",
                        sampleRate: 48000,
                        numberOfChannels: 1
                    };
                    let env: wcp.AudioDecoderEnvironment | null = null;
                    try {
                        env = await LibAVWebCodecs.getAudioDecoder(config);
                    } catch (ex) {}
                    if (!env) continue;

                    // Set up the player
                    let player: weasound.AudioPlayback | null = null;
                    if (opts.createAudioPlayback)
                        player = await opts.createAudioPlayback(ac);
                    if (!player)
                        player = await weasound.createAudioPlayback(ac);
                    track.player = player;

                    this.room.emitEvent("track-started-audio", {
                        peer: this.id,
                        id: i,
                        playback: player
                    });

                    // Set up the decoder
                    const dec = track.decoder = new Decoder();
                    dec.envA = env;
                    dec.config = config;
                    await dec.init();

                    // Set up the resampler
                    const pChannels = player.channels();
                    track.resampler = await resampler!.ff_init_filter_graph(
                        "anull",
                        {
                            sample_fmt: resampler!.AV_SAMPLE_FMT_FLTP,
                            sample_rate: 48000,
                            channel_layout: 4
                        },
                        {
                            sample_fmt: resampler!.AV_SAMPLE_FMT_FLTP,
                            sample_rate: ac.sampleRate,
                            channel_layout:
                                (pChannels === 1)
                                ? 4
                                : ((1<<pChannels)-1)
                        }
                    );
                    track.framePtr = await resampler!.av_frame_alloc();

                    track.firstAudioTrack = firstAudioTrack;
                    firstAudioTrack = false;

                }

            }

            this.streamId = id;
            this.stream = info;
            this.tracks = tracks;
            this.audioLatency = 0;
        }).catch(console.error);

        await this.promise;
    }

    /**
     * Close this peer's stream.
     * @private
     */
    async closeStream() {
        this.promise = this.promise.then(async () => {
            if (this.streamId < 0)
                return;

            this.streamId = -1;

            if (!this.tracks)
                return;

            for (let i = 0; i < this.tracks.length; i++) {
                const track = this.tracks[i];
                if (!track)
                    continue;

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
                            playback: player
                        });

                    }
                }

                if (track.decoder && track.decoder.decoder)
                    await track.decoder.decoder.close();

                if (track.resampler)
                    await resampler!.avfilter_graph_free_js(track.resampler[0]);
                if (track.framePtr)
                    await resampler!.av_frame_free_js(track.framePtr);
            }
            this.tracks = null;

            this.room.emitEvent("stream-ended", {
                peer: this.id
            });
        }).catch(console.error);

        await this.promise;
    }

    /**
     * Called when an ack of data is received for this peer.
     */
    recvAck(pkt: DataView) {
        try {
            const p = prot.parts.ack;
            if (pkt.getUint16(p.type, true) !== prot.ids.data) {
                // No other acking currently needed
                return;
            }

            // Check that it's the right stream
            if (pkt.getUint8(p.dataStreamIdx) !== this.room._getStreamId() << 4)
                return;

            // Get the range being acked
            const msgU8 = new Uint8Array(pkt.buffer);
            const offset = {offset: p.dataAcks};
            const from = util.decodeNetInt(msgU8, offset) - this._inAckedOffset;
            let to = util.decodeNetInt(msgU8, offset) - this._inAckedOffset;
            if (to < from)
                to = from;
            else if (to > from + 1024)
                to = from + 1024;
            let bitIdx = -1;
            if (to <= 0)
                return;

            // Make sure we have room
            while (this._inAcked.length <= to)
                this._inAcked.push(false);

            // And read our acks
            for (let idx = from; idx < to; idx++) {
                // Move to the next bit
                bitIdx++;
                if (bitIdx >= 8) {
                    bitIdx = 0;
                    offset.offset++;
                }

                if (idx < 0)
                    continue;

                // Get its value
                const idxAcked = !!(msgU8[offset.offset] & (1 << bitIdx));
                if (idxAcked)
                    this._inAcked[idx] = true;
            }
        } catch (ex) {
            // Errors are equivalent to nacks
        }
    }

    /**
     * Called when metadata (info) for this peer is received.
     * @private
     * @param data  Received info packet.
     */
    recvInfo(pkt: DataView) {
        // No info is currently supported
    }

    /**
     * Called when data for this peer is received.
     * @private
     * @param data  Received data packet.
     */
    recvData(data: DataView) {
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
            const packetIdx = util.decodeNetInt(datau8, offset);
            const gopIdx = packetIdx - util.decodeNetInt(datau8, offset);

            if (this.data!.length === 0)
                this.offset = packetIdx;

            if (!(trackIdx in this.offsetByTrack))
                this.offsetByTrack[trackIdx] = this.offset;
            if (this.offsetByTrack[trackIdx] > packetIdx) {
                // This track has already played past here
                return;
            }

            // Make sure we have a place to put it
            let assertIdx = packetIdx;
            if (gopIdx >= this.offsetByTrack[trackIdx])
                assertIdx = gopIdx;
            if (assertIdx < this.offset) {
                // Need to make room for it
                if (this.offset - assertIdx >= 1024) {
                    // Don't make that much room!
                    return;
                }
                while (this.offset > assertIdx) {
                    this.data!.unshift(null);
                    this.offset--;
                }
            }

            const idxOffset = packetIdx - this.offset;

            if (idxOffset < 0 || idxOffset >= 1024)
                return;

            while (this.data!.length <= idxOffset)
                this.data!.push(null);

            const gopIdxOffset = gopIdx - this.offset;
            if (gopIdxOffset !== idxOffset &&
                gopIdx >= this.offsetByTrack[trackIdx] &&
                gopIdxOffset >= 0 && gopIdxOffset < this.data!.length) {
                /* Make sure we know this packet is a keyframe so we don't skip
                 * it */
                if (!this.data![gopIdxOffset]) {
                    this.data![gopIdxOffset] =
                        new IncomingData(trackIdx, gopIdx, true);
                }
            }

            const partIdx = util.decodeNetInt(datau8, offset);
            const partCt = util.decodeNetInt(datau8, offset);

            let timestamp = -1;
            if (partIdx === 0)
                timestamp = util.decodeNetInt(datau8, offset);

            // Make the surrounding structure
            let idata: IncomingData = this.data![idxOffset]!;
            if (!idata) {
                idata = this.data![idxOffset] =
                    new IncomingData(trackIdx, packetIdx, key);
            }
            if (!idata.encoded)
                idata.encoded = Array(partCt).fill(null);
            if (partCt !== idata.encoded.length) {
                // ??? Inconsistent data!
                return;
            }
            idata.encoded[partIdx] = datau8.slice(offset.offset);
            if (partIdx === 0)
                idata.remoteTimestamp = timestamp;
            idata.arrivedTimestamp = performance.now();

            // Check if it's complete and ack it if it is
            let complete = true;
            for (let i = 0; i < idata.encoded.length; i++) {
                if (!idata.encoded[i]) {
                    complete = false;
                    break;
                }
            }
            if (complete) {
                // Find the right offset to ack
                if (!this._outAcked.length)
                    this._outAckedOffset = packetIdx;
                let ackOffset = packetIdx - this._outAckedOffset;
                while (this._outAcked.length <= ackOffset &&
                       this._outAcked.length < 1024) {
                    this._outAcked.push(false);
                }
                while (ackOffset < 0 && this._outAcked.length < 1024) {
                    ackOffset++;
                    this._outAckedOffset--;
                    this._outAcked.unshift(false);
                }

                // Ack it
                if (ackOffset >= 0 && ackOffset < this._outAcked.length)
                    this._outAcked[ackOffset] = true;

                // Set the ack timeout
                if (!this._outAckTimeout) {
                    this._outAckTimeout = setTimeout(
                        () => this._doOutAck(), 100
                    );
                }
            }

        } catch (ex) {}

        // Decode what we can
        this.decodeMany();

        // And play if we should
        if (!this.playing) {
            if (this.resume)
                this.resume();
            else
                this.play();
        }
    }

    /**
     * Called when a CTCP message is received. Really just creates an event.
     * @private
     * @param msg  The CTCP message.
     */
    async recvCTCP(msg: DataView) {
        const p = prot.parts.ctcp;
        if (msg.byteLength < p.length)
            return;

        try {
            // Get out the message
            const msgU8 = new Uint8Array(
                msg.buffer,
                msg.byteOffset + p.data,
                msg.byteLength - p.data
            );
            const data = JSON.parse(await util.decodeText(msgU8));

            this.room.emitEvent("ctcp", {
                peer: this.id,
                data
            });
        } catch (ex) {
            console.error("Bad CTCP message", ex);
        }
    }

    /**
     * Receive a pong message. Really just used to report latency.
     * @private
     */
    recvPong(chan: WebSocket | RTCDataChannel) {
        let report: pingingSocket.PingingSocket | undefined;
        for (const ps of [this.semireliable, this.unreliable, this.reliable]) {
            if (!ps) continue;
            if (chan === ps.socket) report = ps;
            break;
        }

        if (report && typeof report.latency === "number") {
            const network = Math.round(report.latency);
            this.room.emitEvent("peer-p2p-latency", {
                peer: this.id,
                network,
                buffer: this._currentBuffer,
                playback: 50, // Just a guess
                total: network + this._currentBuffer + 50
            });
        }
    }

    /**
     * Decode as much as is reasonable of the input.
     * @private
     */
    decodeMany() {
        for (const packet of this.data!) {
            // If we don't have this packet, we can't decode past it
            if (!packet || !packet.encoded)
                break;

            // If this packet is incomplete, we can't decode it or past it
            let complete = true;
            for (const part of packet.encoded) {
                if (!part) {
                    complete = false;
                    break;
                }
            }
            if (!complete)
                break;

            // If we're already decoding this packet, don't decode it again
            if (packet.decoding)
                continue;

            this.decodeOne(packet);
        }
    }

    /**
     * Decode a single packet.
     * @private
     * @param packet  Packet to decode.
     * @param opts  Options for decoding, in particular whether to force
     *              decoding, possibly overloading the decoder.
     */
    decodeOne(packet: IncomingData, opts: {
        force?: boolean
    } = {}) {
        const track = this.tracks![packet.trackIdx];

        // No decoder, no decode
        if (!track) {
            packet.decoding = true;
            if (packet.decodingRes)
                packet.decodingRes();
            return;
        }

        /* If it's a video track with a player that self-decodes, we can just
         * transfer the data directly. */
        if (!track.decoder && track.video &&
            (<videoPlayback.VideoPlayback> track.player).selfDecoding()) {
            packet.decoded = new LibAVWebCodecs.EncodedVideoChunk({
                data: unify(),
                type: packet.key ? "key" : "delta",
                timestamp: 0
            });
            packet.track = track;
            packet.decoding = true;
            if (packet.decodingRes)
                packet.decodingRes();
            return;
        }

        // Get (but don't overload) the decoder
        const decoder = track.decoder;
        if (!decoder || !decoder.decoder)
            return;
        if (decoder.decoder.decodeQueueSize >
            3 + (opts.force ? 12 : 0)) {
            if (opts.force) {
                // Just mark it as done
                packet.decoding = true;
                if (packet.decodingRes)
                    packet.decodingRes();
            }
            return;
        }

        // Make sure we're actually ready to decode
        if (decoder.decoder.state === "closed") {
            decoder.init();
            return;
        }

        packet.decoding = true;

        // Function to unify the encoded parts
        function unify() {
            if (packet.encoded!.length === 1)
                return packet.encoded![0];
            const ret = new Uint8Array(
                packet.encoded!.map(x => x.length).reduce((a, b) => a + b));
            let idx = 0;
            for (const part of packet.encoded!) {
                ret.set(part, idx);
                idx += part.length;
            }
            return ret;
        }

        // Send it for decoding
        let chunk: wcp.EncodedVideoChunk | wcp.EncodedAudioChunk;
        if (track.video) {
            chunk = new decoder.envV!.EncodedVideoChunk({
                data: unify(),
                type: packet.key ? "key" : "delta",
                timestamp: 0
            });

        } else {
            chunk = new decoder.envA!.EncodedAudioChunk({
                data: unify(),
                type: "key",
                timestamp: 0
            });

        }

        // Decode
        decoder.decode(chunk);

        // And receive it
        if (track.video) {
            decoder.get().then(frame => {
                packet.decoded = <wcp.VideoFrame> frame;
                packet.track = track;
                if (packet.decodingRes)
                    packet.decodingRes();
            });

        } else {
            decoder.get().then(async halfDecoded => {
                if (!halfDecoded) {
                    // Failed!
                    if (packet.decodingRes)
                        packet.decodingRes();
                    return;
                }

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
                    format: resampler!.AV_SAMPLE_FMT_FLTP,
                    sample_rate: 48000,
                    channel_layout: 4,
                    pts: decoder.pts,
                    ptshi: 0
                };
                decoder.pts += buf.length;

                // Resample it
                const fframes =
                    await resampler!.ff_filter_multi(
                        track.resampler![1],
                        track.resampler![2],
                        track.framePtr,
                        [frame]
                    );

                if (fframes.length === 0) {
                    // Resampling is taking a frame
                    packet.decoded = [new Float32Array(0)];
                } else {
                    if (fframes.length !== 1)
                        console.error("[ERROR] Number of frames is not 1");

                    packet.decoded = fframes[0].data;
                }
                packet.track = track;
                if (packet.decodingRes)
                    packet.decodingRes();
            });

        }
    }

    /**
     * Get the next packet of data.
     * @param opts  Shift options
     * @private
     */
    shift(opts: {
        /// Force the actually earliest frame, even if it's incomplete
        incomplete?: boolean,
        /// Forcibly allow dropping of keyframes
        key?: boolean
    } = {}) {
        const needKey: Record<number, boolean> = {};
        let nextIdx = 0;
        let next: IncomingData | null = null;
        let complete = false;
        for (; nextIdx < this.data!.length; nextIdx++) {
            next = this.data![nextIdx];
            if (!next)
                continue;

            // If this *is* a keyframe, unblock
            if (next.key)
                delete needKey[next.trackIdx];
            if (needKey[next.trackIdx])
                continue;

            // next is set, but might be incomplete
            complete = false;
            if (next.encoded) {
                complete = true;
                for (const part of next.encoded) {
                    if (!part) {
                        complete = false;
                        break;
                    }
                }
            }

            if (!complete) {
                if (next.key) {
                    if (!opts.incomplete) {
                        // Ignore this track
                        needKey[next.trackIdx] = true;
                        continue;
                    } else if (!opts.key) {
                        // Don't skip this keyframe
                        return null;
                    }

                } else if (!opts.incomplete)
                    continue;
            }

            break;
        }

        if (!next || nextIdx >= this.data!.length)
            return null;

        // Remove any preceding data from the same track
        this.offsetByTrack[next.trackIdx] = next.index + 1;
        for (let idx = 0; idx < nextIdx; idx++) {
            const dropped = this.data![idx];
            if (dropped && dropped.trackIdx === next.trackIdx) {
                dropped.close();
                this.data![idx] = null;
            }
        }

        // Remove this
        this.data![nextIdx] = null;

        // Possibly shift all the track data
        while (this.data!.length && this.data![0] === null) {
            this.data!.shift();
            this.offset++;
        }

        // If it's incomplete, we're dropping it
        if (!complete) {
            next.close();
            return null;
        }

        return next;
    }

    /**
     * Play or continue playing the stream. If not currently playing, this
     * method will do nothing unless there's enough input data.
     * @private
     */
    async play() {
        let tsOffset: number | null = null;

        // Helper function to get the ideal timestamp offset
        const idealTSOffset = (chunk: IncomingData, delay: number) => {
            if (!chunk || chunk.remoteTimestamp < 0)
                return;
            tsOffset = chunk.remoteTimestamp - performance.now() - delay;
        };

        this.playing = true;

        // Promise per track to keep playing in order
        const trackPromises: Record<number, Promise<unknown>> = {};
        const streamId = this.streamId;

        try {
            while (true) {
                if (!this.tracks || this.streamId !== streamId) {
                    // Stream was closed
                    break;
                }

                // Find (adjust) the duration of the buffer
                {
                    let drop = false, dropKey = false;
                    while (true) {
                        let lo = 0, hi = 0;
                        let hiChunk: IncomingData | null = null;
                        for (const chunk of this.data!) {
                            if (!chunk || chunk.key || chunk.remoteTimestamp < 0)
                                continue;
                            lo = chunk.remoteTimestamp;
                            break;
                        }
                        for (let i = this.data!.length - 1; i >= 0; i--) {
                            const chunk = this.data![i];
                            if (!chunk || chunk.remoteTimestamp < 0)
                                continue;
                            hi = chunk.remoteTimestamp;
                            hiChunk = chunk;
                            break;
                        }
                        const currentBuffer = this._currentBuffer = hi - lo;

                        // If the timing is way out of wack, jump ahead
                        if (hiChunk) {
                            if (tsOffset === null) {
                                idealTSOffset(hiChunk, 50);
                            } else {
                                const hiWait = hiChunk.remoteTimestamp - tsOffset - performance.now();
                                if (hiWait > 200 || hiWait < 0)
                                    idealTSOffset(hiChunk, 50);
                            }
                        }

                        // If the buffer size gets way out of hand, drop it
                        drop = drop || (currentBuffer >= 10000);
                        dropKey = dropKey || (currentBuffer >= 20000);
                        if (drop && currentBuffer >= 1000) {
                            const chunk = this.shift({
                                incomplete: true,
                                key: dropKey
                            });
                            if (chunk)
                                chunk.close();
                            else break;
                        } else break;
                    }
                }

                // Get a chunk
                const chunk = this.shift();

                // Are we out of data?
                if (!chunk) {
                    this.playing = false;
                    await new Promise<void>(res => this.resume = res);
                    this.resume = null;
                    this.playing = true;
                    continue;
                }

                // Get our offset
                if (tsOffset === null)
                    idealTSOffset(chunk, 50);

                // Make sure it's decoding/ed
                if (!chunk.decoding)
                    this.decodeOne(chunk, {force: true});

                {
                    // Wait until we're actually supposed to be playing this chunk
                    const wait = chunk.remoteTimestamp - tsOffset! - performance.now();
                    if (wait > 500) {
                        // Something is wrong with our offsets
                        idealTSOffset(chunk, 0);
                    } else if (wait > 10)
                        await new Promise(res => setTimeout(res, wait - 10));
                }

                // Decode and present it in the background
                const promise = trackPromises[chunk.trackIdx] || Promise.all([]);
                trackPromises[chunk.trackIdx] = promise.catch(console.error).then(async () => {
                    // Make sure it's decoded
                    await chunk.decodingPromise;
                    if (!chunk.decoded) {
                        chunk.close();
                        return;
                    }

                    if (!this.tracks) {
                        chunk.close();
                        return;
                    }
                    const track = this.tracks[chunk.trackIdx];

                    // We may have to wait
                    const wait = chunk.remoteTimestamp - tsOffset! - performance.now();

                    // Play it
                    if (!track || chunk.track !== track) {
                        // No associated track, or track not yet configured

                    } else if (track.video) {
                        // Delay for the wait time plus audio latency
                        const lWait = Math.min(wait + this.audioLatency, 500);
                        if (lWait > 0) {
                            await new Promise(
                                res => setTimeout(res, lWait));
                        }

                        await (<videoPlayback.VideoPlayback> track.player)
                            .display(<wcp.VideoFrame> chunk.decoded);

                    } else {
                        if (wait < -10) {
                            // Blew this deadline
                            chunk.close();
                            return;
                        }

                        const player = <weasound.AudioPlayback> track.player;
                        if (!player.playing()) {
                            /* Only delay if we weren't already playing, so
                             * that we create an initial buffer time */
                            await new Promise(
                                res => setTimeout(res, Math.min(wait, 500)));
                        }

                        let latency = player.play(<Float32Array[]> chunk.decoded);

                        // Only use the latency data from the first audio track
                        if (track.firstAudioTrack) {
                            if (latency > 500)
                                latency = 500;
                            if (latency > this.audioLatency) {
                                this.audioLatency = latency;
                            } else {
                                this.audioLatency =
                                    (this.audioLatency * 63 / 64) +
                                    (latency / 64);
                            }

                            // Update speaking data
                            if (track.speakingTimeout) {
                                clearTimeout(track.speakingTimeout);
                            } else {
                                this.room.emitEvent("peer-speaking", {
                                    peer: this.id,
                                    speaking: true
                                });
                            }

                            track.speakingTimeout = setTimeout(() => {
                                this.room.emitEvent("peer-speaking", {
                                    peer: this.id,
                                    speaking: false
                                });
                                track.speakingTimeout = null;
                            }, 1000);
                        }

                    }

                    chunk.close();
                });
            }

            for (const trackIdx in trackPromises)
                await trackPromises[trackIdx];

        } finally {
            this.playing = false;
        }
    }

    /**
     * Perform an outgoing acknowledgment.
     */
    private _doOutAck() {
        this._outAckTimeout = null;
        if (!this._outAcked.length)
            return;
        const outAcks = this._outAcked;
        const from = this._outAckedOffset;
        this._outAcked = [];

        // Build the ack bit array itself
        const ackBits = new Uint8Array(Math.ceil(outAcks.length / 8));
        {
            let by = 0;
            let bi = -1;
            let w = 0;
            let oai;
            for (oai = 0; oai < outAcks.length; oai++) {
                bi++;
                if (bi >= 8) {
                    bi = 0;
                    ackBits[by++] = w;
                    w = 0;
                }
                if (outAcks[oai])
                    w |= 1 << bi;
            }
            ackBits[by] = w;
        }

        // Lengths of the two relevant words
        const to = from + outAcks.length;
        const fromLen = util.netIntBytes(from);
        const toLen = util.netIntBytes(to);

        // Build our outgoing acknowledgement message
        const p = prot.parts.ack;
        const outAckMsg = net.createPacket(
            p.dataLength + fromLen + toLen + ackBits.length,
            this.id, prot.ids.ack,
            [
                [p.type, 2, prot.ids.data],
                [p.dataStreamIdx, 1, this.streamId],
                [p.dataLength, 0, from],
                [p.dataLength + fromLen, 0, to],
                [p.dataLength + fromLen + toLen, ackBits]
            ]
        );

        // And send it
        let needRelay = true;
        if (this.reliable) {
            try {
                this.reliable.send(outAckMsg);
                needRelay = false;
            } catch (ex) {}
        }

        if (needRelay) {
            // Send it via relay
            this.room._relayMessage(outAckMsg, [this.id]);
        }
    }

    /**
     * When we start a new stream, reset our ack checks.
     */
    public newOutgoingStream() {
        this._inAckedOffset = this._inAckHeartbeat = this.room._getPacketIdx();
        this._inAcked = [];
    }

    /**
     * Check whether things have been acknowledged.
     */
    private _checkInAcks() {
        // Rotate the ranges for next time
        const from = this._inAckedOffset;
        let to = this._inAckHeartbeat;
        const next = this.room._getPacketIdx();
        this._inAckedOffset = to;
        this._inAckHeartbeat = next;
        to -= from;

        // If we have no range, nothing to ack
        if (to === 0)
            return;

        // Separate out the part we're acking
        while (this._inAcked.length < to)
            this._inAcked.push(false);
        const acked = this._inAcked.slice(0, to);
        this._inAcked = this._inAcked.slice(to);

        // Get our drop rate from this
        let dropCt = 0;
        for (const ack of acked) {
            if (!ack)
                dropCt++;
        }
        const dropRate = dropCt / acked.length;

        // If it's high, do something
        if (dropRate >= 1/16) {
            this._inAcksGood = 0;

            // Our drop rate to this peer is high. Mark it.
            this.outgoingDrops = true;
            if (this.outgoingDropsTimeout)
                clearTimeout(this.outgoingDropsTimeout);
            this.outgoingDropsTimeout = setTimeout(() => {
                this.outgoingDropsTimeout = null;
                this.outgoingDrops = false;
            }, dropForgetTimeout);

            // To avoid crying wolf, drop the next ack cycle
            while (this._inAckedOffset < this._inAckHeartbeat) {
                this._inAcked.shift();
                this._inAckedOffset++;
            }

            // Possibly just degrade for now
            if (this.room._grade(0.5))
                return;

            /* Couldn't degrade. Either reconnect with more
             * retransmits, or abort the P2P connection entirely and
             * proxy via the server. */
            let forceCompleteReconnect = false;
            switch (this.reliability) {
                case net.Reliability.RELIABLE:
                    // Use a semi-reliable connection
                    this.reliability = net.Reliability.SEMIRELIABLE;
                    this.p2p();
                    break;

                case net.Reliability.UNRELIABLE:
                    forceCompleteReconnect = true;
                    // Intentional fallthrough

                case net.Reliability.SEMIRELIABLE:
                default:
                    // Don't use any P2P connections
                    this.reliability = net.Reliability.UNRELIABLE;
                    if (this.semireliable) {
                        this.semireliable.close();
                        this.semireliable = null;
                    }
                    if (this.reliable) {
                        this.reliable.close();
                        this.reliable = null;
                    }
                    this.p2p({forceCompleteReconnect});
                    break;
            }

        } else if (dropRate === 0) {
            this._inAcksGood++;
            if (this._inAcksGood >= 3) {
                // Can probably bump our reliability
                this._inAcksGood = 0;
                if (this.reliability < net.Reliability.RELIABLE) {
                    this.reliability++;
                    this.p2p();
                }
            }

        }
    }

    /**
     * A single promise to keep everything this peer does in order.
     * @private
     */
    promise: Promise<unknown>;

    /**
     * A promise for P2P connection stuff, which should not serialize with the
     * rest.
     * @private
     */
    p2pPromise: Promise<unknown>;

    /**
     * Set if a P2P reconnect is pending, to avoid simultaneously attempting
     * multiple reconnections.
     * @private
     */
    p2pReconnectPending: boolean;

    /**
     * Set when this peer has been disconnected, so no reconnects should be
     * attempted.
     */
    closed: boolean;

    /**
     * The stream we're currently receiving from this peer, if any.
     * @private
     */
    streamId: number;

    /**
     * True if the current stream is actually playing right now.
     * @private
     */
    playing: boolean;

    /**
     * A callback to resume reading the playback buffer.
     * @private
     */
    resume: (() => void) | null;

    /**
     * The stream information.
     * @private
     */
    stream: any[] | null;

    /**
     * Incoming data.
     * @private
     */
    data: (IncomingData | null)[] | null;

    /**
     * Offset of the data (i.e., index of the first packet).
     * @private
     */
    offset: number;

    /**
     * Index of the first packet still being accepted for each track.
     * @private
     */
    offsetByTrack: Record<number, number>;

    /**
     * Each track's information.
     * @private
     */
    tracks: (Track | null)[] | null;

    /**
     * The (current) latency in playing audio data. Used to delay video
     * display.
     */
    audioLatency: number;

    /**
     * The RTC connection to this peer.
     * @private
     */
    rtc: RTCPeerConnection | null;

    /**
     * Perfect negotiation: Are we making an offer?
     * @private
     */
    rtcMakingOffer: boolean;

    /**
     * Perfect negotiation: Are we ignoring offers?
     * @private
     */
    rtcIgnoreOffer: boolean;

    /**
     * The reliable connection to this peer.
     * @private
     */
    reliable: pingingSocket.PingingSocket | null;

    /**
     * The semi-reliable connection (one retransmit) to this peer, only set if it's needed.
     * @private
     */
    semireliable: pingingSocket.PingingSocket | null;

    /**
     * The unreliable connection to this peer.
     * @private
     */
    unreliable: pingingSocket.PingingSocket | null;

    /**
     * The current (measured) reliability of our OUTGOING connection. This gets
     * reduced if too many outgoing packets drop.
     * @private
     */
    reliability: net.Reliability;

    /**
     * The last time we sent a reliable, relayed message to this peer. Used to
     * ensure connectivity is periodically probed.
     */
    lastReliableRelayTime: number;

    /**
     * Current actual buffer duration in milliseconds.
     */
    private _currentBuffer: number;

    /**
     * Acks of their incoming packets (i.e., outgoing acks).
     */
    private _outAcked: boolean[] = [];

    /**
     * Offset of _outAcked.
     */
    private _outAckedOffset: number = 0;

    /**
     * A timeout to do outgoing acknowledgements.
     */
    private _outAckTimeout: number | null = null;

    /**
     * Acks of our own outgoing packets (i.e., incoming acks).
     */
    private _inAcked: boolean[] = [];

    /**
     * Offset of _inAcked.
     */
    private _inAckedOffset: number = 0;

    /**
     * The heartbeat times that we use to check acknowledgment. When the
     * interval fires, we'll check between offset and heartbeat, then offset
     * becomes heartbeat and heartbeat becomes the current index.
     */
    private _inAckHeartbeat: number = 0;

    /**
     * The interval for checking acknowlegements.
     */
    private _inAckInterval: number | null;

    /**
     * How many in ack checks since we've had drops.
     */
    private _inAcksGood = 0;

    /**
     * Set when our outgoing drop rate is high.
     */
    outgoingDrops: boolean = false;

    /**
     * A timeout to clear out outgoingDrops when the drop rate is fine.
     */
    outgoingDropsTimeout: number | null = null;
}

/**
 * An individual track within a peer's stream.
 * @private
 */
class Track {
    constructor() {
        this.video = false;
        this.firstAudioTrack = false;
        this.duration = 0;
        this.decoder = null;
        this.resampler = null;
        this.framePtr = 0;
        this.player = null;
    }

    /**
     * Is this a video track?
     * @private
     */
    video: boolean;

    /**
     * Is this the *first* audio track? (We care because the first audio track
     * is used to measure audio latency and for speech info)
     * @private
     */
    firstAudioTrack: boolean;

    /**
     * A timeout for indicating speaking info to the host.
     * @private
     */
    speakingTimeout: number | null = null;

    /**
     * The duration of data that we have for this track.
     * @private
     */
    duration: number;

    /**
     * Decoder for this track.
     * @private
     */
    decoder: Decoder | null;

    /**
     * If needed, resampler for this track.
     * @private
     */
    resampler: number[] | null;

    /**
     * Frame pointer, needed if we're using a resampler.
     * @private
     */
    framePtr: number;

    /**
     * Player for this track.
     * @private
     */
    player: weasound.AudioPlayback | videoPlayback.VideoPlayback | null;
}

/**
 * Incoming data, whether audio or video.
 * @private
 */
class IncomingData {
    constructor(
        /**
         * The track number to which this packet belongs.
         * @private
         */
        public trackIdx: number,

        /**
         * The index of this packet.
         * @private
         */
        public index: number,

        /**
         * Is this a keyframe?
         * @private
         */
        public key: boolean
    ) {
        this.encoded = null;
        this.decoded = null;
        this.track = null;
        this.remoteTimestamp =
            this.arrivedTimestamp = -1;
        this.decoding = false;
        this.decodingPromise =
            new Promise<void>(res => this.decodingRes = res);
    }

    /**
     * Close any resources associated with this decoder.
     */
    close() {
        if (!this.decoding && !this.decoded)
            return;
        this.decodingPromise.then(async () => {
            const frame = <wcp.VideoFrame> this.decoded;
            if (frame && frame.close)
                frame.close();
        });
    }

    /**
     * The input encoded data, possibly split into parts.
     * @private
     */
    encoded: Uint8Array[] | null;

    /**
     * The actual displayable data.
     * @private
     */
    decoded: Float32Array[] | wcp.VideoFrame | wcp.EncodedVideoChunk | null;

    /**
     * The track used to decode this data.
     * @private
     */
    track: Track | null;

    /**
     * The timestamp for this chunk, as specified by the sender.
     * @private
     */
    remoteTimestamp: number;

    /**
     * The timestamp when (the last part of) this chunk arrived.
     * @private
     */
    arrivedTimestamp: number;

    /**
     * Set when this has been sent for decoding.
     * @private
     */
    decoding: boolean;

    /**
     * A promise that resolves when the decoded data is available.
     * @private
     */
    decodingPromise: Promise<void>;

    /**
     * And the function to call to resolve the above promise.
     * @private
     */
    decodingRes?: () => void;
}

/**
 * A decoder with surrounding information.
 * @private
 */
class Decoder {
    constructor() {
        this.keyChunkRequired = true;
        this.envA = null;
        this.envV = null;
        this.config = null;
        this.decoder = null;
        this.waiters = [];
        this.buf = [];
        this.pts = 0;
    }

    /**
     * Output callback for the decoder.
     * @private
     */
    output(
        dec: wcp.AudioDecoder | wcp.VideoDecoder | null,
        data: wcp.AudioData | wcp.VideoFrame | null
    ) {
        if (this.decoder !== dec)
            return;

        this.buf.push(data);
        if (this.waiters.length)
            this.waiters.shift()!();
    }

    /**
     * Error callback for the decoder.
     * @private
     */
    error(dec: wcp.AudioDecoder | wcp.VideoDecoder, error: DOMException) {
        if (this.decoder !== dec)
            return;

        /* Reinitialize (FIXME: Some type of timing so we don't do this over
         * and over?) */
        this.init();
    }

    /**
     * Initialize the decoder. env and config must be set.
     */
    async init() {
        // Close the current decoder
        if (this.decoder) {
            try {
                this.decoder.close();
            } catch (ex) {}
            this.decoder = null;
        }

        // Create a new one
        let dec: wcp.AudioDecoder | wcp.VideoDecoder;
        if (this.envV) {
            dec = new this.envV.VideoDecoder({
                output: data => this.output(dec, data),
                error: error => this.error(dec, error)
            });
        } else {
            dec = new this.envA!.AudioDecoder({
                output: data => this.output(dec, data),
                error: error => this.error(dec, error)
            });
        }
        await dec.configure(<any> this.config);

        // Flush any outdated data
        while (this.waiters.length > this.buf.length) {
            this.buf.push(null);
        }
        while (this.waiters.length)
            this.waiters.shift()!();

        // And set the new decoder
        this.keyChunkRequired = true;
        this.decoder = dec;
    }

    /**
     * Pass a packet in for decoding.
     * @private
     */
    async decode(chunk: wcp.EncodedVideoChunk | wcp.EncodedAudioChunk) {
        if (!this.decoder) {
            this.output(null, null);
            return;
        }

        if (this.keyChunkRequired) {
            if (chunk.type === "key") {
                this.keyChunkRequired = false;
            } else {
                this.output(this.decoder, null);
                return;
            }

        }

        try {
            this.decoder.decode(chunk);
        } catch (ex) {
            console.error(ex);
            await this.init();
        }
    }

    /**
     * Asynchronously get a decoded packet.
     * @private
     */
    async get() {
        if (!this.waiters.length && this.buf.length)
            return this.buf.shift();
        await new Promise<void>(res => this.waiters.push(res));
        return this.buf.shift();
    }

    /**
     * Set at the beginning when we still need a key chunk to start decoding.
     * @private
     */
    keyChunkRequired: boolean;

    envA: wcp.AudioDecoderEnvironment | null;
    envV: wcp.VideoDecoderEnvironment | null;
    config: wcp.AudioDecoderConfig | wcp.VideoDecoderConfig | null;
    decoder: wcp.AudioDecoder | wcp.VideoDecoder | null;
    waiters: (() => void)[];
    buf: (wcp.AudioData | wcp.VideoFrame | null)[];
    pts: number;
}
