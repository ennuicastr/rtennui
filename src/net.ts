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

import * as audioCapture from "./audio-capture";
import * as events from "./events";
import * as outgoingAudioStream from "./outgoing-audio-stream";
import * as peer from "./peer";
import {protocol as prot} from "./protocol";
import * as util from "./util";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

// Supported en/decoders
let encoders: string[] = null;
let decoders: string[] = null;

/**
 * An RTEnnui connection, including all requisite server and peer connections.
 * Everything to do with the outgoing stream is also implemented here, because
 * there's only one outgoing stream (with any number of tracks) per connection.
 */
export class Connection extends events.EventEmitter {
    constructor(
        private _ac: AudioContext
    ) {
        super();
        this._streamId = 0;
        this._audioTracks = [];
        this._serverReliable = null;
        this._serverUnreliable = null;
        this._p2p = [];
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
                dec.push("vh263p");
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
                enc.push("vh263p");
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
        const p = prot.parts.login;
        const loginObj = {
            credentials,
            transmit: encoders,
            receive: decoders
        };
        const loginU8 = util.encodeText(JSON.stringify(loginObj));
        const login = new DataView(new ArrayBuffer(p.length + loginU8.length));
        login.setUint16(0, 0, true);
        login.setUint16(2, prot.ids.login, true);
        (new Uint8Array(login.buffer)).set(loginU8, p.data);
        conn.send(login.buffer);

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
            this.serverMessage(ev);
        });

        conn.addEventListener("close", ev => {
            this.emitEvent("disconnected", ev);
        });

        this.emitEvent("connected", null);

        return true;
    }

    /**
     * Handler for messages from the server.
     */
    private serverMessage(ev: MessageEvent) {
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

            case prot.ids.peer:
            {
                const p = prot.parts.peer;
                const status = !!msg.getUint8(p.status);
                const infoJSON =
                    util.decodeText(
                        (new Uint8Array(msg.buffer)).subarray(p.data));
                while (this._p2p.length <= peerId)
                    this._p2p.push(null);

                // Delete any existing peer info
                if (this._p2p[peerId]) {
                    this._p2p[peerId].close();
                    this._p2p[peerId] = null;
                }

                // Create the new one
                if (status)
                    this._p2p[peerId] = new peer.Peer(this, peerId);

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
                const peerO = this._p2p[peerId];
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
                const peerO = this._p2p[peerId];
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
     * Add an outgoing audio track.
     */
    async addAudioTrack(track: audioCapture.AudioCapture) {
        const stream = new outgoingAudioStream.OutgoingAudioStream(track);
        this._audioTracks.push(stream);
        await stream.init();
        stream.on("data", data => this._onOutgoingAudioData(stream, data));
        stream.on("error", error => this._onOutgoingAudioError(stream, error));
        this._newOutgoingStream();
    }

    /**
     * Send data.
     * @param buf  Data to send
     * @param reliable  Whether to send it over the reliable connection
     */
    private _send(buf: ArrayBuffer, reliable: boolean) {
        // FIXME
        this._serverReliable.send(buf);
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
        const tracks = this._audioTracks.map(x => ({
            codec: "aopus",
            frameDuration: 20000
        }));

        // Send out the info
        const p = prot.parts.stream;
        const dataBuf = util.encodeText(JSON.stringify(tracks));
        const msg = new DataView(new ArrayBuffer(p.length + dataBuf.length));
        msg.setUint16(0, this._id, true);
        msg.setUint16(2, prot.ids.stream, true);
        msg.setUint8(p.id, streamId << 4);
        (new Uint8Array(msg.buffer)).set(dataBuf, p.data);
        this._serverReliable.send(msg.buffer);
    }

    /**
     * Handle outgoing audio data.
     */
    private _onOutgoingAudioData(
        stream: outgoingAudioStream.OutgoingAudioStream,
        data: wcp.EncodedAudioChunk
    ) {
        const trackIdx = this._audioTracks.indexOf(stream);
        if (trackIdx < 0)
            return;

        const packetIdx = this._packetIdx++;

        // Make the message
        const p = prot.parts.data;
        const netIntBytes = util.netIntBytes(packetIdx);
        const msg = new DataView(new ArrayBuffer(
            p.length + netIntBytes + data.byteLength));
        const msgu8 = new Uint8Array(msg.buffer);
        msg.setUint16(0, this._id, true);
        msg.setUint16(2, prot.ids.data, true);
        msg.setUint8(p.info, (this._streamId << 4) + trackIdx);
        util.encodeNetInt(msgu8, p.data, packetIdx);
        data.copyTo(msgu8.subarray(p.data + netIntBytes));

        this._send(msg.buffer, false);
    }

    /**
     * Handler for audio encoding errors.
     */
    private _onOutgoingAudioError(
        stream: outgoingAudioStream.OutgoingAudioStream, error: DOMException
    ) {
        console.error(`[ERROR] ${error}\n${error.stack}`);

        // Just remove the stream
        const trackIdx = this._audioTracks.indexOf(stream);
        if (trackIdx >= 0) {
            this._audioTracks.splice(trackIdx, 1);
            this._newOutgoingStream();
        }

        stream.close();
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
     * Our audio tracks.
     */
    private _audioTracks: outgoingAudioStream.OutgoingAudioStream[];

    /**
     * Reliable connection to the server.
     */
    private _serverReliable: WebSocket;

    /**
     * Unreliable connection to the server.
     */
    private _serverUnreliable: RTCDataChannel;

    /**
     * Peers.
     */
    private _p2p: peer.Peer[];

    /**
     * Formats that the server accepts.
     */
    private _formats: string[];
}
