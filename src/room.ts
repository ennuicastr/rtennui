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
import * as outgoingAudioStream from "./outgoing-audio-stream";
import * as outgoingVideoStream from "./outgoing-video-stream";
import * as peer from "./peer";
import * as pingSocket from "./pinging-socket";
import {protocol as prot} from "./protocol";
import * as util from "./util";
import * as videoCapture from "./video-capture";
import * as videoPlayback from "./video-playback";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

// Supported en/decoders
let encoders: string[] | null = null;
let decoders: string[] | null = null;

// Amount to send per packet
const perPacket = 61440;

/**
 * An RTEnnui connection, including all requisite server and peer connections.
 * Everything to do with the outgoing stream is also implemented here, because
 * there's only one outgoing stream (with any number of tracks) per connection.
 *
 * Events:
 * * connected(null): Connection has successfully been established.
 * * disconnected(CloseEvent): The connection has been closed.
 * * peer-joined({id: number, info: any}): A peer has joined.
 * * peer-left({id: number, info: any}): A peer has left.
 * * peer-speaking({peer: number, speaking: boolean}): Indicate whether a peer
 *   is speaking.
 * * peer-p2p-connected({peer: number}): We've established a P2P connection
 *   with this peer.
 * * peer-p2p-disconnected({peer: number}): We've lost our P2P connection with
 *   this peer.
 * * peer-p2p-latency({peer: number, network: number, buffer: number,
 *   total: number}): Reports the expected latency in receiving audio from this
 *   peer, in ms, in several components.
 * * stream-started({peer: number}): A new stream from this peer has started.
 * * stream-ended({peer: number}): This peer's stream has ended.
 * * track-started-video({peer: number, id: number, element: HTMLElement}):
 *   Video track started.
 * * track-started-audio({
 *       peer: number, id: number, playback: AudioPlayback
 *   }):
 *   Audio track started.
 * * track-ended-video({peer: number, id: number, element: HTMLElement}): Video
 *   track ended.
 * * track-ended-audio({
 *       peer: number, id: number, playback: AudioPlayback
 *   }):
 *   Audio track ended.
 * * ctcp({
 *       peer: number, data: any
 *   }):
 *   Client-to-client message.
 */
export class Connection extends abstractRoom.AbstractRoom {
    constructor(
        /**
         * The audio context to use for all audio.
         */
        private _ac: AudioContext,

        /**
         * Optional extra options.
         */
        private _opts: {
            /**
             * Substitute createAudioPlayback to use in place of the built-in
             * one. Allowed to return null.
             */
            createAudioPlayback?:
                (ac: AudioContext) => Promise<weasound.AudioPlayback>
        } = {}
    ) {
        super();
        this._id = -1;
        this._streamId = 0;
        this._packetIdx = 0;
        this._videoTracks = [];
        this._videoTrackKeyframes = [];
        this._audioTracks = [];
        this._serverControl = null;
        this._serverReliableWS = null;
        this._serverSemireliableWS = null;
        this._serverUnreliableWS = null;
        this._serverPC = null;
        this._serverSemireliableDC = null;
        this._serverUnreliableDC = null;
        this._serverReliability = net.Reliability.RELIABLE;
        this._serverReliabilityProber = null;
        this._peers = [];
        this._formats = [];
        this._upgradeTimer = null;
    }

    /**
     * Connect to the RTEnnui server. Returns true if the connection was
     * successful. Do not use if this Connection is already connected or has
     * otherwise been used; make a new one.
     * @param url  Server address.
     * @param credentials  Login credentials.
     */
    async connect(url: string, credentials: any): Promise<boolean> {
        if (url.indexOf("://") < 0) {
            // Figure out the WebSocket URL relative to the current URL
            const u = new URL(document.location.href);
            u.protocol = "ws" + (u.protocol === "https:" ? "s" : "") + ":";
            if (url[0] === "/")
                u.pathname = url;
            else
                u.pathname = u.pathname.replace(/\/[^\/]*$/, "/" + url);
            url = u.href;
        }

        // Perhaps take this time to figure out what en/decoders we support
        if (!encoders) {
            let enc = [];
            let dec = [];

            for (const codec of await videoCapture.codecSupportList())
                enc.push("v" + codec);

            for (const codec of await videoPlayback.codecSupportList())
                dec.push("v" + codec);

            /* We don't use native WebCodecs for audio, so our support is
             * always the same */
            enc.push("aopus");
            dec.push("aopus");

            if (!encoders)
                encoders = enc;
            if (!decoders)
                decoders = dec;
        }

        this._serverURL = url;
        const conn = new WebSocket(url);
        conn.binaryType = "arraybuffer";

        // Wait for it to open
        const opened = await new Promise(res => {
            let timeout: number | null = setTimeout(() => {
                timeout = null;
                res(false);
            }, 30000);
            conn.addEventListener("open", ev => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                    res(true);
                }
            }, {once: true});
            conn.addEventListener("close", ev => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                    res(false);
                }
            }, {once: true});
        });
        if (!opened)
            return false;

        // Send our credentials and await a login ack
        {
            const p = prot.parts.login;
            const loginObj = {
                credentials,
                transmit: encoders!,
                receive: decoders!
            };
            const data = util.encodeText(JSON.stringify(loginObj));
            const msg = net.createPacket(
                p.length + data.length,
                65535, prot.ids.login,
                [[p.data, data]]
            );
            conn.send(msg);
        }

        const connected = await new Promise(res => {
            let done = false;
            conn.addEventListener("message", ev => {
                if (done)
                    return;
                done = true;

                const msg = new DataView(ev.data);
                if (msg.getUint16(2, true) === prot.ids.ack) {
                    this._id = msg.getUint16(0, true);
                    res(true);
                } else {
                    res(false);
                }
            }, {once: true});

            conn.addEventListener("close", ev => {
                done = done || (res(false), true);
            }, {once: true});
        });

        if (!connected)
            return false;

        const pconn = this._serverControl =
            new pingSocket.PingingSocket(conn);

        // Prepare for other messages
        pconn.addEventListener("message", ev => {
            this._serverMessage(<MessageEvent> ev, conn);
        });

        pconn.addEventListener("close", ev => {
            this._serverControl =
                this._serverReliableWS =
                this._serverSemireliableWS =
                this._serverUnreliableWS = null;
            this._serverPC = null;
            this._serverSemireliableDC =
                this._serverUnreliableDC = null;
            if (this._serverReliabilityProber) {
                this._serverReliabilityProber.stop();
                this._serverReliabilityProber = null;
            }
            for (const peer of this._peers) {
                if (peer)
                    peer.closeStream();
            }
            this.emitEvent("disconnected", ev);
        });

        this.emitEvent("connected", null);

        this._connectSecondWS(net.Reliability.UNRELIABLE);
        this._connectSecondWS(net.Reliability.SEMIRELIABLE);
        this._connectSecondWS(net.Reliability.RELIABLE);
        this._connectUnreliableDC();
        this._connectSemireliableDC();
        this._upgradeTimer = setInterval(this._maybeUpgrade.bind(this), 10000);

        return true;
    }

    /**
     * Disconnect from the RTEnnui server.
     */
    disconnect() {
        for (const part of [
            "_serverUnreliableDC",
            "_serverSemireliableDC",
            "_serverUnreliableWS",
            "_serverSemireliableWS",
            "_serverReliableWS",
            "_serverControl"
        ]) {
            const conn = <pingSocket.PingingSocket | RTCDataChannel | null> (
                (<any> this)[part]
            );
            if (!conn)
                continue;
            conn.close();
            (<any> this)[part] = null;
        }
        if (this._upgradeTimer)
            clearTimeout(this._upgradeTimer);
        for (const track of this._videoTracks)
            track.close();
        for (const track of  this._audioTracks)
            track.close();
    }

    /**
     * Send the initial handshake to establish a secondary connection at this
     * reliability.
     */
    private _connectSecondWS(reliability: net.Reliability) {
        const p = prot.parts.wsc.cs;
        const msg = net.createPacket(
            p.length,
            65535, prot.ids.wsc,
            [[p.reliability, 1, reliability]]
        );
        this._serverControl!.send(msg);
    }

    /**
     * Given a server wsc message, establish the secondary connection.
     */
    private async _connectSecondWSResponse(msg: DataView) {
        const msgu8 = new Uint8Array(msg.buffer);
        const p = prot.parts.wsc.sc;
        const reliability = <net.Reliability> msg.getUint8(p.reliability);
        const key = msgu8.slice(p.key, p.key + 8);

        const conn = new WebSocket(this._serverURL!);
        conn.binaryType = "arraybuffer";

        // Wait for it to open
        const opened = await new Promise(res => {
            let timeout: number | null = setTimeout(() => {
                timeout = null;
                res(false);
            }, 30000);
            conn.addEventListener("open", ev => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                    res(true);
                }
            }, {once: true});
            conn.addEventListener("close", ev => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                    res(false);
                }
            }, {once: true});
        });
        if (!opened)
            return;

        // Send the key and await a login ack
        {
            const p = prot.parts.wscLogin;
            const msg = net.createPacket(
                p.length,
                65535, prot.ids.wscLogin,
                [[p.key, key]]
            );
            conn.send(msg);
        }

        const connected = await new Promise(res => {
            let done = false;
            conn.addEventListener("message", ev => {
                if (done)
                    return;
                done = true;

                const msg = new DataView(ev.data);
                res(msg.getUint16(2, true) === prot.ids.ack);
            }, {once: true});

            conn.addEventListener("close", ev => {
                done = done || (res(false), true);
            }, {once: true});
        });

        if (!connected)
            return;

        const pconn = new pingSocket.PingingSocket(conn);

        let haveDC = false;
        let reliabilityStr = "unreliable";
        switch (reliability) {
            case net.Reliability.RELIABLE:
                reliabilityStr = "reliable";
                this._serverReliableWS = pconn;
                break;

            case net.Reliability.SEMIRELIABLE:
                reliabilityStr = "semireliable";
                this._serverSemireliableWS = pconn;
                haveDC = !!this._serverSemireliableDC;
                break;

            default: // unreliable
                this._serverUnreliableWS = pconn;
                haveDC = !!this._serverUnreliableDC;
        }

        if (haveDC) {
            // Don't need both
            pconn.close();
            if (this._serverReliableWS === pconn)
                this._serverReliableWS = null;
            if (this._serverSemireliableWS === pconn)
                this._serverSemireliableWS = null;
            if (this._serverUnreliableWS === pconn)
                this._serverUnreliableWS = null;
            return;
        }

        this.emitEvent("server-secondary-connected", {
            reliability: reliabilityStr
        });

        conn.addEventListener("close", ev => {
            let haveDC = false;
            switch (reliability) {
                case net.Reliability.RELIABLE:
                    // No reliable DC
                    if (this._serverReliableWS !== pconn)
                        return;
                    break;

                case net.Reliability.SEMIRELIABLE:
                    if (this._serverSemireliableWS !== pconn)
                        return;
                    haveDC = !!this._serverSemireliableDC;
                    break;

                default: // unreliable
                    if (this._serverUnreliableWS !== pconn)
                        return;
                    haveDC = !!this._serverUnreliableDC;
            }

            this.emitEvent("server-secondary-disconnected", {
                reliability: reliabilityStr
            });

            if (!haveDC)
                this._connectSecondWS(reliability);
        });

        conn.onmessage = ev => {
            this._serverMessage(ev, conn);
        };
    }

    /**
     * Establish an RTC peer connection to the server.
     */
    private async _connectRTCPC() {
        if (this._serverPC)
            return this._serverPC;

        const pc = this._serverPC = new RTCPeerConnection({
            iceServers: util.iceServers
        });

        // Perfect negotiation logic (we're always polite)
        pc.onnegotiationneeded = async () => {
            try {
                await pc.setLocalDescription();

                const descr = util.encodeText(
                    JSON.stringify({
                        description: pc.localDescription
                    })
                );
                const p = prot.parts.rtc;
                const msg = net.createPacket(
                    p.length + descr.length,
                    65535, prot.ids.rtc,
                    [[p.data, descr]]
                );
                this._serverControl!.send(msg);

            } catch (ex) {
                console.error(ex);

            }
        };

        pc.onicecandidate = ev => {
            const cand = util.encodeText(
                JSON.stringify({
                    candidate: ev.candidate
                })
            );
            const p = prot.parts.rtc;
            const msg = net.createPacket(
                p.length + cand.length,
                65535, prot.ids.rtc,
                [[p.data, cand]]
            );
            this._serverControl!.send(msg);
        };

        return pc;
    }

    /**
     * Establish a semireliable connection to the server.
     */
    private async _connectSemireliableDC() {
        const pc = await this._connectRTCPC();

        // Set up the actual data channel
        const dc = pc.createDataChannel("semireliable", {
            ordered: false,
            maxRetransmits: 1
        });
        dc.binaryType = "arraybuffer";

        dc.addEventListener("open", () => {
            this._serverSemireliableDC = dc;
            this.emitEvent("server-semireliable-connected", {});

            if (this._serverSemireliableWS) {
                // Don't need both
                this._serverSemireliableWS.close();
            }
        }, {once: true});

        dc.addEventListener("close", () => {
            if (this._serverSemireliableDC === dc) {
                this._serverSemireliableDC = null;
                this.emitEvent("server-semireliable-disconnected", {});

                if (!this._serverSemireliableWS)
                    this._connectSecondWS(net.Reliability.SEMIRELIABLE);
                this._connectSemireliableDC();
            }
        }, {once: true});

        dc.onmessage = ev => {
            this._serverMessage(ev, dc);
        };
    }

    /**
     * Establish an unreliable connection to the server.
     */
    private async _connectUnreliableDC() {
        const pc = await this._connectRTCPC();

        // Set up the actual data channel
        const dc = pc.createDataChannel("unreliable", {
            ordered: false,
            maxRetransmits: 0
        });
        dc.binaryType = "arraybuffer";

        dc.addEventListener("open", () => {
            this._serverUnreliableDC = dc;
            this._serverReliability = net.Reliability.RELIABLE;
            this._serverReliabilityProber = new net.ReliabilityProber(
                dc, true,
                (reliability: net.Reliability) => {
                    const was = this._serverReliability;
                    this._serverReliability = (reliability === net.Reliability.RELIABLE) ?
                        net.Reliability.RELIABLE :
                        net.Reliability.UNRELIABLE;
                    if (this._serverReliability !== was) {
                        this.emitEvent("server-unreliable-connected", {
                            reliability: net.reliabilityStr(this._serverReliability)
                        });
                    }
                }
            );
            this.emitEvent("server-unreliable-connected", {
                reliability: "reliable"
            });

            if (this._serverUnreliableWS) {
                // Don't need both
                this._serverUnreliableWS.close();
            }
        }, {once: true});

        dc.addEventListener("close", () => {
            if (this._serverUnreliableDC === dc) {
                this._serverUnreliableDC = null;
                if (this._serverReliabilityProber) {
                    this._serverReliabilityProber.stop();
                    this._serverReliabilityProber = null;
                }
                this.emitEvent("server-unreliable-disconnected", {});

                if (!this._serverUnreliableWS)
                    this._connectSecondWS(net.Reliability.UNRELIABLE);
                this._connectUnreliableDC();
            }
        }, {once: true});

        dc.onmessage = ev => {
            this._serverMessage(ev, dc);
        };
    }

    /**
     * Handler for RTC messages from the server.
     * @param msg  Received message.
     */
    private async _serverRTCMessage(msg: DataView) {
        const pc = this._serverPC!;
        const p = prot.parts.rtc;
        const dataU8 = (new Uint8Array(msg.buffer)).subarray(p.data);
        const dataS = util.decodeText(dataU8);
        const data = JSON.parse(dataS);

        // Perfect negotiation (we're polite)
        try {
            if (data.description) {
                await pc.setRemoteDescription(data.description);
                if (data.description.type === "offer") {
                    await pc.setLocalDescription();
                    const descr = util.encodeText(
                        JSON.stringify({
                            description: pc.localDescription
                        })
                    );
                    const msg = net.createPacket(
                        p.length + descr.length,
                        65535, prot.ids.rtc,
                        [[p.data, descr]]
                    );
                    this._serverControl!.send(msg);
                }

            } else if (data.candidate) {
                await pc.addIceCandidate(data.candidate);

            }

        } catch (ex) {
            console.error(ex);

        }
    }

    /**
     * Handler for messages from the server.
     * @private
     * @param ev  Received message event.
     * @param chan  The channel that this message was received on.
     */
    private _serverMessage(ev: MessageEvent, chan: WebSocket | RTCDataChannel) {
        const msg = new DataView(ev.data);
        const peerId = msg.getUint16(0, true);
        const cmd = msg.getUint16(2, true);

        switch (cmd) {
            case prot.ids.pong:
                // Their pong, only informational
                break;

            case prot.ids.rping:
                // Reliability ping. Just reverse it into a pong.
                msg.setUint16(0, this._getOwnId(), true);
                msg.setUint16(2, prot.ids.rpong, true);
                try {
                    chan.send(msg.buffer);
                } catch (ex) {
                    console.error(ex);
                }
                break;

            case prot.ids.rpong:
                // Their pong, handled elsewhere
                break;

            case prot.ids.formats:
            {
                const p = prot.parts.formats;
                const formatsJSON =
                    util.decodeText(
                        (new Uint8Array(msg.buffer)).subarray(p.data));
                this._formats = JSON.parse(formatsJSON);
                this._formatsUpdated();
                break;
            }

            case prot.ids.rtc:
                if (peerId === 65535 /* max u16 */) {
                    // Server
                    this._serverRTCMessage(msg);
                } else {
                    // Client
                    const peer = this._peers[peerId];
                    if (!peer)
                        break;
                    peer.rtcRecv(msg);
                }
                break;

            case prot.ids.wsc:
                this._connectSecondWSResponse(msg);
                break;

            case prot.ids.peer:
            {
                const p = prot.parts.peer;
                const status = !!msg.getUint8(p.status);
                const infoJSON =
                    util.decodeText(
                        (new Uint8Array(msg.buffer)).subarray(p.data));
                while (this._peers.length <= peerId)
                    this._peers.push(null);

                // Delete any existing peer info
                if (this._peers[peerId]) {
                    this._peers[peerId].close();
                    this._peers[peerId] = null;
                }

                // Create the new one
                let p2p: peer.Peer | null = null;
                if (status)
                    p2p = this._peers[peerId] = new peer.Peer(this, peerId);

                // Establish P2P connections
                if (p2p)
                    p2p.p2p();

                // And tell the user
                this.emitEvent(
                    status ? "peer-joined" : "peer-left",
                    {
                        id: peerId,
                        info: JSON.parse(infoJSON)
                    }
                );
                break;
            }

            case prot.ids.stream:
            {
                const p = prot.parts.stream;
                const peerO = this._peers[peerId];
                if (!peerO)
                    break;
                const id = msg.getUint8(p.id);
                const dataJSON = util.decodeText(
                    (new Uint8Array(msg.buffer)).subarray(p.data));
                peerO.newStream(this._ac, id, JSON.parse(dataJSON),
                    this._opts);
                break;
            }

            case prot.ids.ack:
            case prot.ids.info:
            case prot.ids.data:
            {
                const peerO = this._peers[peerId];
                if (!peerO)
                    break;
                if (cmd === prot.ids.ack)
                    peerO.recvAck(msg);
                if (cmd === prot.ids.info)
                    peerO.recvInfo(msg);
                else // data
                    peerO.recvData(msg);
                break;
            }

            default:
                console.error(`[INFO] Unrecognized command 0x${cmd.toString(16)}`);
        }
    }

    /**
     * Choose a video codec.
     */
    private _chooseVideoCodec(): string {
        let codec: string | null = null;
        for (const opt of encoders!) {
            if (opt[0] !== "v")
                continue;
            if (!this._formats || this._formats.indexOf(opt) >= 0) {
                codec = opt;
                break;
            }
        }
        if (!codec)
            throw new Error("No supported video codec found!");
        return codec;
    }

    /**
     * Add an outgoing video track.
     * @param ms  Stream to add.
     */
    async addVideoTrack(ms: MediaStream) {
        // Choose a codec
        const codec = this._chooseVideoCodec();

        const stream = new outgoingVideoStream.OutgoingVideoStream(ms, codec);

        // Set up the stream
        await stream.init();
        const forceReliable = stream.forceReliable();
        this._videoTracks.push(stream);
        this._videoTrackKeyframes.push(0);
        stream.on("data", data => this._onOutgoingData(stream, data, forceReliable));
        stream.on("error", error => this._onOutgoingError(stream, error));
        this._newOutgoingStream();
    }

    /**
     * Remove an outgoing video track.
     * @param ms  Stream to remove.
     */
    async removeVideoTrack(ms: MediaStream) {
        // Find the stream
        let idx: number;
        let stream: outgoingVideoStream.OutgoingVideoStream | null = null;
        for (idx = 0; idx < this._videoTracks.length; idx++) {
            let str = this._videoTracks[idx];
            if (str.ms === ms) {
                stream = str;
                break;
            }
        }
        if (!stream)
            return;

        // Stop and remove it
        stream.close();
        this._videoTracks.splice(idx, 1);
        this._videoTrackKeyframes.splice(idx, 1);
        this._newOutgoingStream();
    }

    /**
     * Add an outgoing audio track.
     * @param track  Track to add.
     * @param opts  Outgoing stream options.
     */
    async addAudioTrack(
        track: weasound.AudioCapture,
        opts: outgoingAudioStream.OutgoingAudioStreamOptions = {}
    ) {
        const stream = new outgoingAudioStream.OutgoingAudioStream(track);
        await stream.init(opts);
        this._audioTracks.push(stream);
        stream.on("data", data => this._onOutgoingData(stream, data, false));
        stream.on("error", error => this._onOutgoingError(stream, error));
        this._newOutgoingStream();
    }

    /**
     * Remove an outgoing audio track.
     * @param track  Track to remove.
     */
    async removeAudioTrack(track: weasound.AudioCapture) {
        // Find the stream
        let idx: number;
        let stream: outgoingAudioStream.OutgoingAudioStream | null = null;
        for (idx = 0; idx < this._audioTracks.length; idx++) {
            let str = this._audioTracks[idx];
            if (str.capture === track) {
                stream = str;
                break;
            }
        }
        if (!stream)
            return;

        // Stop and remove it
        stream.close();
        this._audioTracks.splice(idx, 1);
        this._newOutgoingStream();
    }

    /**
     * Called when the formats list is updated to reinitialize any streams that
     * need to be done in a different format.
     */
    private async _formatsUpdated() {
        const fromFormats =
            this._videoTracks.map(x => "v" + x.getCodec())
            .concat(this._audioTracks.map(x => "aopus"))
            .join(",");

        // Find new formats for each track
        const vCodec = this._chooseVideoCodec();
        const toFormats =
            Array(this._videoTracks.length).fill(vCodec)
            .concat(Array(this._audioTracks.length).fill("aopus"))
            .join(",");

        if (fromFormats === toFormats) {
            // No change needed
            return;
        }

        // Replace tracks!
        for (let i = 0; i < this._videoTracks.length; i++) {
            const inVT = this._videoTracks[i];
            if (inVT.getCodec() === vCodec)
                continue;

            // Replace the codec
            inVT.close();
            const stream =
                new outgoingVideoStream.OutgoingVideoStream(
                    inVT.ms, vCodec
                );
            await stream.init();
            const forceReliable = stream.forceReliable();
            this._videoTracks[i] = stream;
            this._videoTrackKeyframes[i] = 0;
            stream.on("data", data => this._onOutgoingData(stream, data, forceReliable));
            stream.on("error", error => this._onOutgoingError(stream, error));
        }

        // FIXME: If we ever support multiple audio codecs, replace those too

        this._newOutgoingStream();
    }

    /**
     * Send data.
     * @param buf  Data to send
     * @param reliability  The appropriate level of reliability with which to
     *                     send this data
     */
    private _sendData(buf: ArrayBuffer, reliability: net.Reliability) {
        let needRelay: number[] = [];
        let phi = 0, plo = -1;
        let forceReliableRelay = false;
        const now = performance.now();
        const oneSecondAgo = now - 1000;

        // Send directly
        for (let peerIdx = 0; peerIdx < this._peers.length; peerIdx++) {
            plo++;
            if (plo >= 8) {
                phi++;
                plo = 0;
            }

            const peer = this._peers[peerIdx];
            if (!peer)
                continue;
            let peerRelay = false;

            try {
                switch (reliability) {
                    case net.Reliability.UNRELIABLE:
                        /* For unreliable messages, we'll always send it
                         * unreliably, even if there's little hope of it going
                         * through */
                        if (peer.unreliable) {
                            peer.unreliable.send(buf);
                            break;
                        }
                        // Intentional fallthrough

                    case net.Reliability.SEMIRELIABLE:
                        // Bump up semireliable to reliable if needed
                        if (peer.reliability >= net.Reliability.SEMIRELIABLE &&
                            peer.semireliable) {
                            peer.semireliable.send(buf);
                            break;
                        }
                        // Intentional fallthrough

                    case net.Reliability.RELIABLE:
                        if (peer.reliable) {
                            peer.reliable.send(buf);
                            break;
                        }
                        // Intentional fallthrough

                    default:
                        peerRelay = true;
                }
            } catch (ex) {
                peerRelay = true;
            }

            // If we haven't relayed recently, do so
            if (peer.lastReliableRelayTime < oneSecondAgo)
                forceReliableRelay = true;
            if (forceReliableRelay ||
                (peerRelay && reliability === net.Reliability.RELIABLE)) {
                peer.lastReliableRelayTime = now;
                peerRelay = true;
            }

            // If we need to relay, set it
            if (peerRelay) {
                while (needRelay.length <= phi)
                    needRelay.push(0);
                needRelay[phi] |= 1 << plo;
            }
        }

        // Relay if needed
        if (needRelay.length) {
            this._relayMessageBitArray(buf, needRelay, {reliability});
        }
    }

    /**
     * Relay data, with targets already a bitarray.
     * @private
     */
    private _relayMessageBitArray(
        msg: ArrayBuffer, targets: number[], opts: {
            reliability?: net.Reliability
        } = {}
    ) {
        let reliability = net.Reliability.RELIABLE;
        if (typeof opts.reliability === "number")
            reliability = opts.reliability;

        // Build the relay message
        const rp = prot.parts.relay;
        const relayMsg = new DataView(net.createPacket(
            rp.length + 1 + targets.length + msg.byteLength,
            -1, prot.ids.relay, [
                [rp.data, 1, targets.length],
                [rp.data + 1 + targets.length, new Uint8Array(msg)]
            ]
        ));
        for (let phi = 0; phi < targets.length; phi++)
            relayMsg.setUint8(rp.data + 1 + phi, targets[phi]);

        /* We can either relay via the server's unreliable connection or
         * via the server's reliable connection. We prefer the unreliable
         * connection if the data is unreliable *or* the data is
         * semireliable but the reliable connection is full. We prefer the
         * reliable connection if the data is reliable, of course. */
        switch (reliability) {
            case net.Reliability.RELIABLE:
                this._sendAnySock(
                    [this._serverReliableWS, this._serverControl],
                    relayMsg.buffer
                );
                break;

            case net.Reliability.SEMIRELIABLE:
                this._sendAnySock(
                    [
                        this._serverSemireliableDC, this._serverSemireliableWS,
                        this._serverControl
                    ],
                    relayMsg.buffer, 8192
                );
                break;

            default: // unreliable
                this._sendAnySock(
                    [
                        this._serverUnreliableDC, this._serverUnreliableWS,
                        this._serverControl
                    ],
                    relayMsg.buffer, 1024
                );
        }
    }

    /**
     * Send this data via one of a collection of possible sockets.
     * @param socks  Sockets to send it to
     * @param buf  Buffer to send
     * @param limit  Only send if the buffered amount on the socket is less than
     *               this
     */
    private _sendAnySock(
        socks: (pingSocket.PingingSocket | RTCDataChannel | null)[],
        buf: ArrayBuffer,
        limit = -1
    ) {
        for (let si = 0; si < socks.length; si++) {
            const sock = socks[si];
            if (!sock) continue;
            if (limit >= 0 && si > 0) {
                let ba = 0;
                if (typeof sock.bufferedAmount === "function")
                    ba = sock.bufferedAmount();
                else
                    ba = sock.bufferedAmount;
                if (ba >= limit)
                    continue;
            }
            if (si < socks.length - 1) {
                try {
                    sock.send(buf);
                    break;
                } catch (ex) {}
            } else {
                sock.send(buf);
            }
        }
    }

    /**
     * Relay a message to a specific list of users.
     * @param msg  Message to relay
     * @param targets  User IDs to relay it to
     * @private
     */
    override _relayMessage(
        msg: ArrayBuffer, targets: number[], opts: {
            reliability?: number
        } = {}
    ): void {
        // Turn targets into a bitarray
        const tba: number[] = [];
        for (const target of targets) {
            const phi = ~~(target / 8);
            const plo = target % 8;
            while (tba.length < phi)
                tba.push(0);
            tba[phi] |= 1 << plo;
        }

        // Then send it
        this._relayMessageBitArray(msg, tba, opts);
    }

    /**
     * Set up our outgoing stream.
     */
    private _newOutgoingStream() {
        // Update the stream ID
        const streamId = this._streamId =
            (this._streamId + 1) % 8;
        this._packetIdx = 0;

        // Get our track listing
        const tracks = (<any[]> [])
            .concat(this._videoTracks.map(x => ({
                codec: x.getCodec(),
                frameDuration: ~~(1000000 / x.getFramerate()),
                width: x.getWidth(),
                height: x.getHeight()
            })))
            .concat(this._audioTracks.map(x => ({
                codec: "aopus",
                frameDuration: x.getFrameDuration()
            })));

        // Send out the info
        const p = prot.parts.stream;
        const data = util.encodeText(JSON.stringify(tracks));
        const msg = net.createPacket(
            p.length + data.length,
            this._id, prot.ids.stream,
            [
                [p.id, 1, streamId << 4],
                [p.data, data]
            ]
        );
        this._serverControl!.send(msg);

        // And inform all the peer connections
        for (const peer of this._peers) {
            if (!peer)
                continue;
            peer.newOutgoingStream();
        }
    }

    /**
     * Handle outgoing data.
     * @param stream  Stream generating the data.
     * @param data  Data packet to send.
     */
    private _onOutgoingData(
        stream: outgoingVideoStream.OutgoingVideoStream |
            outgoingAudioStream.OutgoingAudioStream,
        data: wcp.EncodedVideoChunk | wcp.EncodedAudioChunk,
        forceReliable: boolean
    ) {
        let isVideo = true;
        let trackIdx = this._videoTracks.indexOf(
            <outgoingVideoStream.OutgoingVideoStream> stream);
        if (trackIdx < 0) {
            isVideo = false;
            trackIdx = this._audioTracks.indexOf(
                <outgoingAudioStream.OutgoingAudioStream> stream);
            if (trackIdx < 0)
                return;

            // Audio tracks come after video tracks
            trackIdx += this._videoTracks.length;
        }

        const packetIdx = this._packetIdx++;

        // Info byte
        const key = isVideo && data.type === "key";
        const info =
            (key ? 0x80 : 0) |
            (this._streamId << 4) |
            trackIdx;

        // Keyframe index
        let gopIdx = 0;
        if (isVideo) {
            if (key)
                this._videoTrackKeyframes[trackIdx] = packetIdx;
            else
                gopIdx = packetIdx - this._videoTrackKeyframes[trackIdx];
        }

        // Give it a timestamp
        const timestamp = performance.now();
        const tsBytes = util.netIntBytes(timestamp);

        // Get the data out
        const datau8 = new Uint8Array(tsBytes + data.byteLength);
        util.encodeNetInt(datau8, 0, timestamp);
        data.copyTo(datau8.subarray(tsBytes));

        // Make and send the messages
        const p = prot.parts.data;
        const packetIdxBytes = util.netIntBytes(packetIdx);
        const gopIdxBytes = util.netIntBytes(gopIdx);
        let idx = 0;
        const ct = Math.ceil(datau8.length / perPacket);
        const ctBytes = util.netIntBytes(ct);
        for (let i = 0; i < datau8.length; i += perPacket) {
            const dataPart = datau8.subarray(i, i + perPacket);
            const idxBytes = util.netIntBytes(idx);

            const msg = net.createPacket(
                p.length + packetIdxBytes + gopIdxBytes + idxBytes + ctBytes +
                dataPart.length,
                this._id, prot.ids.data,
                [
                    [p.info, 1, info],
                    [p.data, 0, packetIdx],
                    [p.data + packetIdxBytes, 0, gopIdx],
                    [p.data + packetIdxBytes + gopIdxBytes, 0, idx],
                    [p.data + packetIdxBytes + gopIdxBytes + idxBytes, 0, ct],
                    [p.data + packetIdxBytes + gopIdxBytes + idxBytes + ctBytes,
                     dataPart],
                ]
            );

            this._sendData(msg,
                forceReliable
                    ? net.Reliability.RELIABLE
                    : (isVideo
                        ? (key
                           ? net.Reliability.RELIABLE
                           : net.Reliability.UNRELIABLE
                        )
                        : net.Reliability.SEMIRELIABLE
                    )
            );

            idx++;
        }
    }

    /**
     * Handler for encoding errors.
     * @param stream  Stream generating the error.
     * @param error  Generated error.
     */
    private _onOutgoingError(
        stream: outgoingVideoStream.OutgoingVideoStream |
            outgoingAudioStream.OutgoingAudioStream,
        error: DOMException
    ) {
        console.error(`[ERROR] ${error}\n${error.stack}`);

        // Just remove the stream
        {
            const trackIdx = this._videoTracks.indexOf(
                <outgoingVideoStream.OutgoingVideoStream> stream);
            if (trackIdx >= 0) {
                this._videoTracks.splice(trackIdx, 1);
                this._newOutgoingStream();
            }
        }
        {
            const trackIdx = this._audioTracks.indexOf(
                <outgoingAudioStream.OutgoingAudioStream> stream);
            if (trackIdx >= 0) {
                this._audioTracks.splice(trackIdx, 1);
                this._newOutgoingStream();
            }
        }

        stream.close();
    }

    /**
     * Perform any possible upgrades *if* no peer is reporting drops.
     * @private
     */
    private _maybeUpgrade() {
        for (const peer of this._peers)
            if (peer && peer.outgoingDrops)
                return;
        this._grade(2);
    }

    override _grade(by: number) {
        if (!this._videoTracks.length)
            return false;

        let ret = false;
        for (const track of this._videoTracks) {
            if (track.grade(by))
                ret = true;
        }
        return ret;
    }

    /**
     * Send a message via CTCP to a given client.
     * @param target  An array of targets, OR a single target ID number, OR
     *                null to broadcast.
     * @param data  Data to send, must be JSON-able.
     */
    ctcp(targetsIn: number[] | number | null, data: any) {
        let targets: number[];
        if (targetsIn === null) {
            targets = this._peers.map((_, idx) => idx);
        } else if (typeof targetsIn === "number") {
            targets = [targetsIn];
        } else {
            targets = targetsIn;
        }

        // Make the CTCP message
        const p = prot.parts.ctcp;
        const dataU8 = util.encodeText(JSON.stringify(data));
        const msg = net.createPacket(
            p.length + data.length,
            this._id, prot.ids.ctcp,
            [[p.data, data]]
        );

        let needRelay: number[] = [];

        // Send directly where possible
        for (const peerIdx of targets) {
            const peer = this._peers[peerIdx];
            if (!peer)
                continue;
            let peerRelay = false;

            try {
                peer.reliable!.send(msg);
            } catch (ex) {
                peerRelay = true;
            }

            // If we need to relay, set it
            if (peerRelay)
                needRelay.push(peerIdx);
        }

        // Relay if needed
        if (needRelay.length)
            this._relayMessage(msg, needRelay);
    }

    // AbstractRoom methods
    /** @private */
    override _getOwnId() { return this._id; }
    /** @private */
    override _getStreamId() { return this._streamId; }
    /** @private */
    override _getPacketIdx() { return this._packetIdx; }
    /** @private */
    override _sendServer(msg: ArrayBuffer) {
        if (this._serverControl)
            this._serverControl.send(msg);
    }

    /**
     * Our own peer ID.
     */
    private _id: number;

    /**
     * Our current stream ID, which just rotates.
     */
    private _streamId: number;

    /**
     * Current packet index within the stream.
     */
    private _packetIdx: number;

    /**
     * Our video tracks.
     */
    private _videoTracks: outgoingVideoStream.OutgoingVideoStream[];

    /**
     * The index of the last keyframe from each video track.
     */
    private _videoTrackKeyframes: number[];

    /**
     * Our audio tracks.
     */
    private _audioTracks: outgoingAudioStream.OutgoingAudioStream[];

    /**
     * The URL that we connected to the WebSocket server with.
     */
    private _serverURL?: string;

    /**
     * Control connection to the server.
     */
    private _serverControl: pingSocket.PingingSocket | null;

    /**
     * Reliable data connection to the server.
     */
    private _serverReliableWS: pingSocket.PingingSocket | null;

    /**
     * Semireliable WebSocket connection to the server.
     */
    private _serverSemireliableWS: pingSocket.PingingSocket | null;

    /**
     * Unreliable WebSocket connection to the server.
     * (Of course, as a WebSocket connection, it will always be reliable, but
     * this is for unreliable data if no other connection can be established)
     */
    private _serverUnreliableWS: pingSocket.PingingSocket | null;

    /**
     * The peer connection corresponding to _serverUnreliableDC and
     * _serverSemireliableDC.
     */
    private _serverPC: RTCPeerConnection | null;

    /**
     * Semireliable connection to the server.
     */
    private _serverSemireliableDC: RTCDataChannel | null;

    /**
     * Unreliable connection to the server.
     */
    private _serverUnreliableDC: RTCDataChannel | null;

    /**
     * Expected reliability of the *unreliable* server connection.
     */
    private _serverReliability: net.Reliability;

    /**
     * Prober for server reliability.
     */
    private _serverReliabilityProber: net.ReliabilityProber | null;

    /**
     * Peers.
     */
    private _peers: (peer.Peer | null)[];

    /**
     * Formats that the server accepts.
     */
    private _formats: string[];

    /**
     * An interval for considering upgrading any degraded streams.
     */
    private _upgradeTimer: number | null;
}
