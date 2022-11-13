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
 * @private
 */
let resampler: libavT.LibAV = null;

export async function load() {
    resampler = await LibAV.LibAV();
}

/**
 * Ideal number of pings before reporting buffering.
 * @private
 */
const idealPings = 5;

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
        this.closed = false;
        this.streamId = -1;
        this.playing = false;
        this.stream = null;
        this.data = null;
        this.offset = 0;

        // We log 128 packets for the drop log
        let dropLog: boolean[] = this.dropLog = [];
        for (let i = 0; i < 128; i++) {
            dropLog.push(false);
        }
        this.drops = 0;
        this.dropInfoTimeout = null;

        this.tracks = null;
        this.rtc = null;
        this.rtcMakingOffer = false;
        this.rtcIgnoreOffer = false;
        this.reliable = this.semireliable = this.unreliable = null;
        this.reliabilityProber = null;
        this.reliability = net.Reliability.RELIABLE;
        this.pingInterval = null;
        this.pongs = [];
        this._idealBufferMs = 0;
        this._incomingReliable = 0;
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
            // Completely drop the old RTC instance and try again
            this.rtc.close();
            this.rtc = null;
        }

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
                    if (chan.label === "reliable") {
                        chan.onmessage = ev => this.onMessage(ev, chan, true);

                        chan.onclose = () => this._incomingReliable--;
                        this._incomingReliable++;

                        // Possibly set up pings
                        this.ping();

                    } else {
                        chan.onmessage = ev => this.onMessage(ev, chan, false);

                    }
                };
            }

            // Outgoing data channels
            try {
                if (!this.unreliable) {
                    this.unreliable = await this.p2pChannel("unreliable", {
                        ordered: false
                    }, chan => {
                        if (this.unreliable === chan)
                            this.unreliable = null;
                    });
                }
            } catch (ex) {
                // Unreliable connection failed, try again
                this.p2p({forceCompleteReconnect: true});
                return;
            }

            // Once we have an unreliable connection, we can probe reliability
            if (this.unreliable &&
                this.reliability !== net.Reliability.RELIABLE) {
                /* In reliable mode, we'll discover the reliability from the
                 * data. Otherwise, we'll need to probe. */
                if (this.reliabilityProber)
                    this.reliabilityProber.stop();
                const rp = this.reliabilityProber = new net.ReliabilityProber(
                    this.unreliable, true,
                    (reliability: net.Reliability) => {
                        if (this.reliabilityProber === rp &&
                            reliability > this.reliability) {
                            if (this.reliability < net.Reliability.RELIABLE)
                                this.reliability++;
                            this.reliabilityProber.stop();
                            this.reliabilityProber = null;
                            this.p2p();
                        }
                    }
                );
            } else if (this.reliabilityProber) {
                this.reliabilityProber.stop();
                this.reliabilityProber = null;
            }

            try {
                if (!this.semireliable &&
                    this.reliability === net.Reliability.SEMIRELIABLE) {
                    this.semireliable = await this.p2pChannel("semireliable", {
                        ordered: false,
                        maxRetransmits: 1
                    }, chan => {
                        if (this.semireliable === chan)
                            this.semireliable = null;
                    });
                }

                if (!this.reliable &&
                    this.reliability > net.Reliability.UNRELIABLE) {
                    this.reliable = await this.p2pChannel("reliable", void 0,
                    chan => {
                        if (this.reliable === chan)
                            this.reliable = null;
                    });


                    // Pings are only done on the reliable channel
                    this.ping();
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

        }).catch(console.error);

        await this.promise;
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
            const chan = this.rtc.createDataChannel(label, options);
            chan.binaryType = "arraybuffer";
            let opened = false;

            let connTimeout = setTimeout(() => {
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
            case prot.ids.ping:
                // Just reverse it into a pong
                if (!this.reliable)
                    return;
                msg.setUint16(0, this.room._getOwnId(), true);
                msg.setUint16(2, prot.ids.pong, true);
                this.reliable.send(msg.buffer);
                break;

            case prot.ids.rping:
                // Reliability ping. Just reverse it into a pong.
                msg.setUint16(0, this.room._getOwnId(), true);
                msg.setUint16(2, prot.ids.rpong, true);
                try {
                    chan.send(msg.buffer);
                } catch (ex) {
                    console.error(ex);
                }
                break;

            case prot.ids.pong:
                this.pong(msg.getFloat64(prot.parts.pong.timestamp, true));
                break;

            case prot.ids.info:
                this.recvInfo(msg);
                break;

            case prot.ids.data:
                this.recvData(msg);
                break;
        }
    }

    /**
     * Possibly set up pings to this user.
     * @private
     */
    ping() {
        if (this.pingInterval || !this.reliable || !this._incomingReliable)
            return;

        if (this.pongs.length >= idealPings) {
            // Ping at a leisurely pace
            this.pingInterval = setInterval(() => {
                this.sendPing();
            }, 30000);

        } else {
            // Ping once and move from there
            this.sendPing();

        }
    }

    /**
     * Send a single ping.
     * @private
     */
    sendPing() {
        if (!this.reliable || !this._incomingReliable) {
            // Nowhere to ping!
            return;
        }

        // Create the packet and send it
        const p = prot.parts.ping;
        const msg = net.createPacket(
            p.length, this.room._getOwnId(), prot.ids.ping,
            [[p.timestamp, 8, performance.now()]]
        );
        this.reliable.send(msg);
    }

    /**
     * Handler for receiving a pong.
     * @private
     * @param timestamp  Timestamp of the original ping.
     */
    pong(timestamp: number) {
        // Add the RTT to the list
        const pongs = this.pongs;
        pongs.push(performance.now() - timestamp);
        while (pongs.length > idealPings)
            pongs.shift();

        // Calculate the buffer size
        this._idealBufferMs = Math.min(
            250, // No more than 250ms buffer
            Math.max(
                10, // No less than 10ms buffer

                /* Otherwise, calculate the difference between the max and min
                 * latency */
                (Math.max.apply(Math, pongs) - Math.min.apply(Math, pongs))

                /* and multiply it by 0.75, since that's RTT, but data is sent
                 * one way. i.e., our ideal is 150% of the variance in one-way
                 * latency. */
                * 0.75
            )
        );

        if (this.reliable && this._incomingReliable &&
            this.pongs.length >= idealPings) {
            // Inform the user
            this.room.emitEvent("peer-p2p-latency", {
                peer: this.id,
                network: Math.round(pongs[pongs.length-1]),
                buffer: this._idealBufferMs,
                total: Math.round(
                    // The actual network latency...
                    pongs[pongs.length-1] +

                    // Our buffer
                    this._idealBufferMs * 1.5 +

                    // The playback delay (final buffer)
                    10
                )
            });
        }

        this.ping();
    }

    /**
     * Get the ideal buffer size for this peer.
     * @private
     */
    idealBufferMs() {
        if (!this.reliable || !this._incomingReliable || this.pongs.length < idealPings) {
            // No reliable connection, so use the default
            return 100;
        }

        let min = 0;

        // No less than two frames
        if (this.stream) {
            min = Math.max.apply(Math, this.stream.map(
                x => x.frameDuration * 2 / 1000));
        }

        const ideal = Math.max(this._idealBufferMs, min);

        return ideal;
    }

    /**
     * Initialize this peer's incoming data with a new stream.
     * @private
     * @param ac  AudioContext on which to play the stream.
     * @param id  ID of the stream.
     * @param info  Track info given by the peer.
     */
    async newStream(ac: AudioContext, id: number, info: any) {
        this.closeStream();

        this.promise = this.promise.then(async () => {
            this.streamId = id;
            this.playing = false;
            this.stream = info;
            this.data = [];
            this.offset = 0;

            const tracks: Track[] = this.tracks =
                info.map(() => new Track);

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
                        env = await LibAVWebCodecs.getVideoDecoder(config);
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
                    dec.envV = env;
                    dec.config = config;
                    await dec.init();

                } else if (trackInfo.codec[0] === "a") {
                    // Audio track
                    if (trackInfo.codec !== "aopus") {
                        // Unsupported
                        continue;
                    }

                    const config: wcp.AudioDecoderConfig = {
                        // For now, force the polyfill
                        //codec: "opus",
                        codec: {libavjs:{
                            codec: "libopus"
                        }},
                        sampleRate: 48000,
                        numberOfChannels: 1
                    };
                    let env: wcp.AudioDecoderEnvironment = null;
                    try {
                        env = await LibAVWebCodecs.getAudioDecoder(config);
                    } catch (ex) {}
                    if (!env) continue;

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
                    dec.envA = env;
                    dec.config = config;
                    await dec.init();

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

                if (track.decoder && track.decoder.decoder)
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
        }).catch(console.error);

        await this.promise;
    }

    /**
     * Called when metadata (info) for this peer is received.
     * @private
     * @param data  Received info packet.
     */
    recvInfo(pkt: DataView) {
        try {
            const p = prot.parts.info;
            const info = JSON.parse(
                util.decodeText(
                    (new Uint8Array(pkt.buffer)).subarray(p.data)
                )
            );

            // c is the "command" (tho these are generally not command-like)
            switch (info.c) {
                case "dropRate":
                    /* Our drop rate (to this peer) is high. Either reconnect
                     * with more retransmits, or abort the P2P connection
                     * entirely and proxy via the server. */
                    switch (this.reliability) {
                        case net.Reliability.RELIABLE:
                            // Use a semi-reliable connection
                            this.reliability = net.Reliability.SEMIRELIABLE;
                            if (!this.semireliable)
                                this.p2p();
                            break;

                        case net.Reliability.SEMIRELIABLE:
                        case net.Reliability.UNRELIABLE:
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
                            this.p2p();
                            break;
                    }
                    break;
            }
        } catch (ex) {}
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

            if (this.data.length === 0)
                this.offset = packetIdx;

            const idxOffset = packetIdx - this.offset;

            if (idxOffset < 0 || idxOffset >= 1024)
                return;

            while (this.data.length <= idxOffset)
                this.data.push(null);

            const partIdx = util.decodeNetInt(datau8, offset);
            const partCt = util.decodeNetInt(datau8, offset);

            // Make the surrounding structure
            let idata: IncomingData = this.data[idxOffset];
            if (!idata) {
                idata = this.data[idxOffset] =
                    new IncomingData(trackIdx, packetIdx, key, partCt);
                this.tracks[trackIdx].duration +=
                    this.stream[trackIdx].frameDuration;
            }
            if (partCt !== idata.encoded.length) {
                // ??? Inconsistent data!
                return;
            }
            idata.encoded[partIdx] = datau8.slice(offset.offset);

        } catch (ex) {}

        // Decode what we can
        this.decodeMany();

        // And play if we should
        if (!this.playing)
            this.play();
    }

    /**
     * Decode as much as is reasonable of the input.
     * @private
     */
    decodeMany() {
        for (const packet of this.data) {
            // If we don't have this packet, we can't decode past it
            if (!packet)
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
        const track = this.tracks[packet.trackIdx];

        // Get (but don't overload) the decoder
        const decoder = track.decoder;
        if (!decoder || !decoder.decoder)
            return;
        if (decoder.decoder.decodeQueueSize > 1) {
            if (opts.force) {
                // Just mark it as done
                packet.decoding = true;
                packet.decodingRes();
            }
            return;
        }
        packet.decoding = true;

        // Function to unify the encoded parts
        function unify() {
            if (packet.encoded.length === 1)
                return packet.encoded[0];
            const ret = new Uint8Array(
                packet.encoded.map(x => x.length).reduce((a, b) => a + b));
            let idx = 0;
            for (const part of packet.encoded) {
                ret.set(part, idx);
                idx += part.length;
            }
            return ret;
        }

        // Send it for decoding
        let chunk: wcp.EncodedVideoChunk | wcp.EncodedAudioChunk;
        if (track.video) {
            if (decoder.keyChunkRequired && !packet.key) {
                // Not decodable
                packet.decoded = new decoder.envV.VideoFrame(
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
                chunk = new decoder.envV.EncodedVideoChunk({
                    data: unify(),
                    type: packet.key ? "key" : "delta",
                    timestamp: 0
                });

            }

        } else {
            chunk = new decoder.envA.EncodedAudioChunk({
                data: unify(),
                type: "key",
                timestamp: 0
            });

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
                if (!halfDecoded) {
                    // Failed!
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

                if (fframes.length === 0) {
                    // Resampling is taking a frame
                    packet.decoded = [];
                } else {
                    if (fframes.length !== 1)
                        console.error("[ERROR] Number of frames is not 1");

                    packet.decoded = fframes[0].data;
                }
                packet.decodingRes();
            });

        }
    }

    /**
     * Get the next packet of data.
     * @private
     */
    shift() {
        while (this.data.length > 1) {
            const next: IncomingData = this.data[0];
            if (!next) {
                // Dropped!
                this.data.shift();
                this.offset++;
                this.logDrop(true);
                continue;
            }

            // next is set, but might be incomplete
            let complete = true;
            for (const part of next.encoded) {
                if (!part) {
                    complete = false;
                    break;
                }
            }

            /*
            if (!complete && next.key) {
                // Can't skip keyframes
                return null;
            }
            */

            // We're either displaying it or skipping it, so shift it
            this.data.shift();
            this.offset++;
            this.logDrop(false);
            const track = this.tracks[next.trackIdx];
            track.duration -=
                this.stream[next.trackIdx].frameDuration;

            if (!complete)
                continue;

            // OK, this part is ready
            return next;
        }
        return null;
    }

    /**
     * Play or continue playing the stream. If not currently playing, this
     * method will do nothing unless there's enough input data.
     * @private
     */
    async play() {
        /* Set the ideal start time on the first packet to the ideal buffering
         * time */
        for (const chunk of this.data) {
            if (!chunk)
                continue;
            chunk.idealTimestamp = performance.now() + this.idealBufferMs();
            break;
        }

        this.playing = true;

        while (true) {
            // Do we have too much data (more than double our ideal buffer)?
            const tooMuch = this.idealBufferMs() * 2000;
            while (Math.max.apply(Math, this.tracks.map(x => x.duration))
                   >= tooMuch) {
                if (!this.shift())
                    break;
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
                    const frame = <wcp.VideoFrame> chunk.decoded;
                    (<videoPlayback.VideoPlayback> track.player)
                        .display(frame)
                        .then(() => frame.close());

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
     * Log a drop or non-drop of a packet.
     * @private
     * @param dropped  True if the packet was dropped.
     */
    logDrop(dropped: boolean) {
        // Shift it into the log
        if (this.dropLog[0])
            this.drops--;
        this.dropLog.shift();
        this.dropLog.push(dropped);
        if (dropped)
            this.drops++;
        //console.error(`[INFO] Drop rate: ${Math.round(this.drops / this.dropLog.length * 100)}%`);

        // Check for high drop rate
        if (!this.dropInfoTimeout &&
            this.drops >= this.dropLog.length / 16) {
            // Tell them about it
            const p = prot.parts.info;
            const data = util.encodeText(
                JSON.stringify({
                    c: "dropRate",
                    dropRate: this.drops / this.dropLog.length
                })
            );
            const msg = net.createPacket(
                p.length + data.length,
                this.id, prot.ids.info,
                [[p.data, data]]
            );
            if (this.reliable)
                this.reliable.send(msg);
            else
                this.room._sendServer(msg);

            // And wait to tell them again
            this.dropInfoTimeout = setTimeout(() => {
                this.dropInfoTimeout = null;

                // Reset the log
                const len = this.dropLog.length;
                this.dropLog = [];
                for (let i = 0; i < len; i++)
                    this.dropLog.push(false);
                this.drops = 0;
            }, 5000);
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
     * The stream information.
     * @private
     */
    stream: any[];

    /**
     * Incoming data.
     * @private
     */
    data: IncomingData[];

    /**
     * Offset of the data (i.e., index of the first packet).
     * @private
     */
    offset: number;

    /**
     * Drops for the previous (some reasonable amount) packets.
     * @private
     */
    dropLog: boolean[];

    /**
     * # of drops in the drop log.
     * @private
     */
    drops: number;

    /**
     * If the # of drops gets too high and we inform the other end, we set a
     * timeout to avoid telling them repeatedly.
     * @private
     */
    dropInfoTimeout: number | null;

    /**
     * Each track's information.
     * @private
     */
    tracks: Track[];

    /**
     * The RTC connection to this peer.
     * @private
     */
    rtc: RTCPeerConnection;

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
    reliable: RTCDataChannel;

    /**
     * The semi-reliable connection (one retransmit) to this peer, only set if it's needed.
     * @private
     */
    semireliable: RTCDataChannel;

    /**
     * The unreliable connection to this peer.
     * @private
     */
    unreliable: RTCDataChannel;

    /**
     * Prober to probe unreliable connections, *if* we're currently in
     * *unreliable* mode, so can't use the actual data to probe.
     */
    reliabilityProber: net.ReliabilityProber;

    /**
     * The current (measured) reliability of our OUTGOING connection. This gets
     * reduced if too many outgoing packets drop.
     * @private
     */
    reliability: net.Reliability;

    /**
     * Interval used to ping the reliable socket for timing info.
     * @private
     */
    pingInterval: number;

    /**
     * Pongs from the peer, in terms of microseconds RTT.
     * @private
     */
    pongs: number[];

    /**
     * Ideal buffer duration *in milliseconds*, based on ping-pong time. Use
     * the getter instead of this.
     */
    private _idealBufferMs: number;

    /**
     * Number of incoming reliable streams. A number instead of a boolean so
     * that events can be reordered and we still know whether we have a
     * connection.
     */
    private _incomingReliable: number;
}

/**
 * An individual track within a peer's stream.
 * @private
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
     * @private
     */
    video: boolean;

    /**
     * The duration of data that we have for this track.
     * @private
     */
    duration: number;

    /**
     * Decoder for this track.
     * @private
     */
    decoder: Decoder;

    /**
     * If needed, resampler for this track.
     * @private
     */
    resampler: number[];

    /**
     * Frame pointer, needed if we're using a resampler.
     * @private
     */
    framePtr: number;

    /**
     * Player for this track.
     * @private
     */
    player: audioPlayback.AudioPlayback | videoPlayback.VideoPlayback;
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
        public key: boolean,

        /**
         * The number of parts to expect.
         */
        partCt: number
    ) {
        this.encoded = Array(partCt).fill(null);
        this.decoded = null;
        this.idealTimestamp = -1;
        this.decoding = false;
        this.decodingPromise =
            new Promise<void>(res => this.decodingRes = res);
    }

    /**
     * The input encoded data, possibly split into parts.
     * @private
     */
    encoded: Uint8Array[];

    /**
     * The actual displayable data.
     * @private
     */
    decoded: Float32Array[] | wcp.VideoFrame;

    /**
     * The ideal timestamp at which to display this.
     * @private
     */
    idealTimestamp: number;

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
    decodingRes: () => void;
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
    }

    /**
     * Output callback for the decoder.
     * @private
     */
    output(
        dec: wcp.AudioDecoder | wcp.VideoDecoder,
        data: wcp.AudioData | wcp.VideoFrame
    ) {
        if (this.decoder !== dec)
            return;

        this.buf.push(data);
        if (this.waiters.length)
            this.waiters.shift()();
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

        // If there's a handler for uncaught errors, it will receive this
        throw error;
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
            dec = new this.envA.AudioDecoder({
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
            this.waiters.shift()();

        // And set the new decoder
        this.keyChunkRequired = true;
        this.decoder = dec;
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

    envA: wcp.AudioDecoderEnvironment;
    envV: wcp.VideoDecoderEnvironment;
    config: wcp.AudioDecoderConfig | wcp.VideoDecoderConfig;
    decoder: wcp.AudioDecoder | wcp.VideoDecoder;
    waiters: (() => void)[];
    buf: (wcp.AudioData | wcp.VideoFrame)[];
}
