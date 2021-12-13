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
import * as audioCapture from "./audio-capture";
import * as net from "./net";
import * as outgoingAudioStream from "./outgoing-audio-stream";
import * as outgoingVideoStream from "./outgoing-video-stream";
import * as peer from "./peer";
import {protocol as prot} from "./protocol";
import * as util from "./util";
import * as videoCapture from "./video-capture";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

// Supported en/decoders
let encoders: string[] = null;
let decoders: string[] = null;

// Amount to send per packet
const perPacket = 61440;

/**
 * An RTEnnui connection, including all requisite server and peer connections.
 * Everything to do with the outgoing stream is also implemented here, because
 * there's only one outgoing stream (with any number of tracks) per connection.
 */
export class Connection extends abstractRoom.AbstractRoom {
    constructor(
        private _ac: AudioContext
    ) {
        super();
        this._streamId = 0;
        this._videoTracks = [];
        this._audioTracks = [];
        this._serverReliable = null;
        this._serverUnreliable = null;
        this._serverUnreliablePC = null;
        this._peers = [];
    }

    /**
     * Connect to the RTEnnui server. Returns true if the connection was
     * successful. Do not use if this Connection is already connected or has
     * otherwise been used; make a new one.
     * @param url  Server address
     * @param credentials  Login credentials
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

            for (const codec of ["vp09", "vp8"]) {
                try {
                    await LibAVWebCodecs.getVideoDecoder({codec});
                    dec.push("v" + codec);
                    await LibAVWebCodecs.getVideoEncoder({
                        codec,
                        width: 640, height: 480
                    });
                    enc.push("v" + codec);
                } catch (ex) {}
            }

            // H.263+ is special because it's not in the codec registry
            try {
                await LibAVWebCodecs.getVideoDecoder({
                    codec: {libavjs:{
                        codec: "h263p"
                    }}
                });
                dec.push("vh263.2");
                await LibAVWebCodecs.getVideoEncoder({
                    codec: {libavjs:{
                        codec: "h263p",
                        ctx: {
                            pix_fmt: 0,
                            width: 640,
                            height: 480
                        }
                    }},
                    width: 640,
                    height: 480
                });
                enc.push("vh263.2");
            } catch (ex) {}

            /* We don't use native WebCodecs for audio, so our support is
             * always the same */
            enc.push("aopus");
            dec.push("aopus");

            if (!encoders)
                encoders = enc;
            if (!decoders)
                decoders = dec;
        }

        const conn = this._serverReliable = new WebSocket(url);
        conn.binaryType = "arraybuffer";

        // Wait for it to open
        const opened = await new Promise(res => {
            conn.addEventListener("open", ev => {
                res(true);
            }, {once: true});
            conn.addEventListener("close", ev => {
                res(false);
            }, {once: true});
        });
        if (!opened)
            return false;

        // Send our credentials and await a login ack
        {
            const p = prot.parts.login;
            const loginObj = {
                credentials,
                transmit: encoders,
                receive: decoders
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

        // Prepare for other messages
        conn.addEventListener("message", ev => {
            this._serverMessage(ev);
        });

        conn.addEventListener("close", ev => {
            this._serverReliable = this._serverUnreliable =
                this._serverUnreliablePC = null;
            this.emitEvent("disconnected", ev);
        });

        this.emitEvent("connected", null);

        this._connectUnreliable();

        return true;
    }

    /**
     * Establish an unreliable connection to the server.
     */
    private async _connectUnreliable() {
        let pc: RTCPeerConnection = this._serverUnreliablePC;
        if (!pc) {
            pc = this._serverUnreliablePC = new RTCPeerConnection({
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
                    this._serverReliable.send(msg);

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
                this._serverReliable.send(msg);
            };
        }

        // Set up the actual data channel
        const dc = pc.createDataChannel("unreliable", {
            ordered: false,
            maxRetransmits: 0
        });
        dc.binaryType = "arraybuffer";

        dc.addEventListener("open", () => {
            this._serverUnreliable = dc;
        }, {once: true});

        dc.addEventListener("close", () => {
            if (this._serverUnreliable === dc)
                this._serverUnreliable = null;
        }, {once: true});

        dc.onmessage = ev => {
            this._serverMessage(ev);
        };
    }

    /**
     * Handler for RTC messages from the server.
     */
    private async _serverRTCMessage(msg: DataView) {
        const pc = this._serverUnreliablePC;
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
                    this._serverReliable.send(msg);
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
     */
    private _serverMessage(ev: MessageEvent) {
        const msg = new DataView(ev.data);
        const peerId = msg.getUint16(0, true);
        const cmd = msg.getUint16(2, true);

        switch (cmd) {
            case prot.ids.ack:
                // Nothing to do
                break;

            case prot.ids.formats:
            {
                const p = prot.parts.formats;
                const formatsJSON =
                    util.decodeText(
                        (new Uint8Array(msg.buffer)).subarray(p.data));
                this._formats = JSON.parse(formatsJSON);
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
                let p2p: peer.Peer = null;
                if (status)
                    p2p = this._peers[peerId] = new peer.Peer(this, peerId);

                // Or destroy the old one
                else if (this._peers[peerId]) {
                    this._peers[peerId].close();
                    this._peers[peerId] = null;
                }

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
                peerO.newStream(this._ac, id, JSON.parse(dataJSON));
                break;
            }

            case prot.ids.data:
            {
                const peerO = this._peers[peerId];
                if (!peerO)
                    break;
                peerO.recv(msg);
                break;
            }

            default:
                console.error(`[INFO] Unrecognized command 0x${cmd.toString(16)}`);
        }
    }

    /**
     * Add an outgoing video track.
     */
    async addVideoTrack(track: videoCapture.VideoCapture) {
        const stream = new outgoingVideoStream.OutgoingVideoStream(track);

        // Choose a format
        let format: string = null;
        for (const opt of encoders) {
            if (!this._formats || this._formats.indexOf(opt) >= 0) {
                format = opt;
                break;
            }
        }
        if (!format)
            throw new Error("No supported video format found!");

        // Initialize the stream
        await stream.init(format);
        this._videoTracks.push(stream);
        stream.on("data", data => this._onOutgoingData(stream, data));
        stream.on("error", error => this._onOutgoingError(stream, error));
        this._newOutgoingStream();
    }

    /**
     * Add an outgoing audio track.
     */
    async addAudioTrack(track: audioCapture.AudioCapture) {
        const stream = new outgoingAudioStream.OutgoingAudioStream(track);
        await stream.init();
        this._audioTracks.push(stream);
        stream.on("data", data => this._onOutgoingData(stream, data));
        stream.on("error", error => this._onOutgoingError(stream, error));
        this._newOutgoingStream();
    }

    /**
     * Send data.
     * @param buf  Data to send
     * @param reliable  Whether to send it over the reliable connection
     */
    private _sendData(buf: ArrayBuffer, reliable: boolean) {
        // Send directly
        let needRelay = false;
        for (const peer of this._peers) {
            if (!peer)
                continue;
            if (!reliable && peer.unreliable)
                peer.unreliable.send(buf);
            else if (reliable && peer.reliable)
                peer.reliable.send(buf);
            else
                needRelay = true;
        }

        // Relay if needed
        if (needRelay) {
            if (!reliable && this._serverUnreliable)
                this._serverUnreliable.send(buf);
            else if (this._serverReliable)
                this._serverReliable.send(buf);
        }
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
        const tracks = []
            .concat(this._videoTracks.map(x => ({
                codec: x.format,
                frameDuration: ~~(1000000 / x.capture.getFramerate())
            })))
            .concat(this._audioTracks.map(x => ({
                codec: "aopus",
                frameDuration: 20000
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
        this._serverReliable.send(msg);
    }

    /**
     * Handle outgoing data.
     */
    private _onOutgoingData(
        stream: outgoingVideoStream.OutgoingVideoStream |
            outgoingAudioStream.OutgoingAudioStream,
        data: wcp.EncodedVideoChunk | wcp.EncodedAudioChunk
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

        // Get the data out
        const datau8 = new Uint8Array(data.byteLength);
        data.copyTo(datau8);

        // Make and send the messages
        const p = prot.parts.data;
        const packetIdxBytes = util.netIntBytes(packetIdx);
        const ct = Math.ceil(datau8.length / perPacket);
        const ctBytes = util.netIntBytes(ct);
        for (let i = 0; i < datau8.length; i += perPacket) {
            const dataPart = datau8.subarray(i, i + perPacket);
            const idxBytes = util.netIntBytes(i);

            const msg = net.createPacket(
                p.length + packetIdxBytes + idxBytes + ctBytes +
                dataPart.length,
                this._id, prot.ids.data,
                [
                    [p.info, 1, info],
                    [p.data, 0, packetIdx],
                    [p.data + packetIdxBytes, 0, i],
                    [p.data + packetIdxBytes + idxBytes, 0, ct],
                    [p.data + packetIdxBytes + idxBytes + ctBytes, dataPart],
                ]
            );

            this._sendData(msg, key);
        }
    }

    /**
     * Handler for encoding errors.
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

    // AbstractRoom methods
    override _getOwnId() { return this._id; }
    override _sendServer(msg: ArrayBuffer) {
        if (this._serverReliable)
            this._serverReliable.send(msg);
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
     * Our audio tracks.
     */
    private _audioTracks: outgoingAudioStream.OutgoingAudioStream[];

    /**
     * Reliable connection to the server.
     */
    private _serverReliable: WebSocket;

    /**
     * The peer connection corresponding to _serverUnreliable.
     */
    private _serverUnreliablePC: RTCPeerConnection;

    /**
     * Unreliable connection to the server.
     */
    private _serverUnreliable: RTCDataChannel;

    /**
     * Peers.
     */
    private _peers: peer.Peer[];

    /**
     * Formats that the server accepts.
     */
    private _formats: string[];
}
