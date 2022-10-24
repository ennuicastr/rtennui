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

import { protocol } from "./protocol";
import * as util from "./util";

/**
 * Modes of reliability.
 * @private
 */
export enum Reliability {
    // Even unreliable connections are expected to be reliable
    RELIABLE = 2,

    // Some packets dropped, but mostly OK
    SEMIRELIABLE = 1,

    // Do not use P2P connections
    UNRELIABLE = 0
}

/**
 * A reliability prober probes the reliability of an RTCDataChannel, either
 * momentarily or continuously, and calls a given callback when and if
 * reliability drops to 1/16 pings lost.
 */
export class ReliabilityProber {
    constructor(
        /**
         * The connection to probe.
         */
        public conn: RTCDataChannel,
        /**
         * Probe continuously?
         */
        public continuous: boolean,
        /**
         * The callback to call on reliability changes.
         */
        public cb: (reliable:boolean)=>unknown
    ) {
        this.go();
    }

    /**
     * Start probing reliability. (Do not call this. It's called by the constructor.)
     */
    go() {
        this.dead = false;
        this.wasReliable = null;
        this.idx = 0;
        this.pongs = [];
        this.drops = 0;
        this.pongIdx = 0;

        function onclose() {
            if (this.dead)
                return;
            this.dead = true;
            this.conn.removeEventListener("message", onmessage);
            this.conn.removeEventListener("close", onclose);
        }
        this.stop = onclose;

        this.conn.addEventListener("close", onclose);

        function onmessage(ev: MessageEvent<ArrayBuffer>) {
            if (this.dead)
                return;

            const msg = new DataView(ev.data);
            if (msg.byteLength < 8)
                return;

            const cmd = msg.getUint32(0, true);
            if (cmd !== protocol.ids.rpong)
                return;
            let pidx = msg.getUint32(protocol.parts.rpong.id, true);

            if (pidx < this.pongIdx || pidx >= this.idx)
                return;

            // Mark this pong as received
            pidx -= this.pongIdx;
            if (!this.pongs[pidx])
                this.drops--;
            this.pongs[pidx] = true;
        }

        function doPing() {
            if (this.dead)
                return;

            // Check our status
            if (this.pongs.length >= this.checkCt) {
                if (this.drops >= (this.pongs.length / this.dropReport)) {
                    // Too many drops!
                    if (this.wasReliable !== false) {
                        this.wasReliable = false;
                        this.cb(false);
                    }

                } else if (this.drops === 0 || this.wasReliable === null) {
                    if (this.wasReliable !== true) {
                        this.wasReliable = true;
                        this.cb(true);
                    }

                }

                if (!this.continuous) {
                    // That was enough, stop now
                    onclose();
                    return;
                }
            }

            // Make and send ping message
            const p = protocol.parts.rping;
            const msg = createPacket(
                p.length, -1, protocol.ids.rping,
                [[p.id, 4, this.idx]]
            );
            this.conn.send(msg);

            // Mark it as unreceived (because it is so far)
            this.pongs.push(false);
            this.drops++;

            // Maybe narrow the window
            while (this.pongs.length > this.checkCt) {
                if (!this.pongs[0])
                    this.drops--;
                this.pongs.shift();
            }

            // And send more pings
            if (this.pongs.length < this.checkCt) {
                setTimeout(doPing, 10);
            } else if (this.drops > 1) {
                // Try to find unreliability quickly
                setTimeout(doPing, 250);
            } else {
                setTimeout(doPing, 10000);
            }
        }

        doPing();
    }

    /**
     * Called when the connection is closed as a callback, or call this to stop
     * pinging.
     */
    stop: ()=>void;

    // Set when we've stopped probing
    dead: boolean;

    // Did the last callback call report reliable?
    wasReliable: boolean | null;

    // Do 32 pings before checking
    checkCt = 32;

    // Report a problem if more than 1/16 are dropped
    dropReport = 16;

    // Index we're next going to ping
    idx: number;

    // Whether each pong has yet been received
    pongs: boolean[];

    // Number of drops
    drops: number;

    // The index of pongs[0]
    pongIdx: number;
}

/**
 * A description of a number entry.
 * @private
 */
export type NumberDescr = [number, number, number];

/**
 * A description of a raw entry.
 * @private
 */
export type RawDescr = [number, Uint8Array];

/**
 * A description is either.
 * @private
 */
export type Descr = NumberDescr | RawDescr;

/**
 * Create an ArrayBuffer based on a description.
 * @private
 * @param len  Length of the packet in bytes.
 * @param peer  Peer ID for the packet.
 * @param cmd  Command.
 * @param descr  Packet description.
 */
export function createPacket(
    len: number, peer: number, cmd: number, descr: Descr[]
) {
    const retAB = new ArrayBuffer(len);
    const ret = new DataView(retAB);
    const retU8 = new Uint8Array(retAB);

    ret.setUint16(0, peer, true);
    ret.setUint16(2, cmd, true);

    for (const d of descr) {
        if (typeof d[1] === "number") {
            switch (d[1]) {
                case 0: // netint
                    util.encodeNetInt(retU8, d[0], d[2]);
                    break;

                case 1:
                    ret.setUint8(d[0], d[2]);
                    break;

                case 2:
                    ret.setUint16(d[0], d[2], true);
                    break;

                case 4:
                    ret.setUint32(d[0], d[2], true);
                    break;

                case 8: // float64
                    ret.setFloat64(d[0], d[2], true);
                    break;

                default:
                    throw new Error("Invalid description");
            }

        } else {
            retU8.set(<Uint8Array> d[1], d[0]);

        }
    }

    return retAB;
}
