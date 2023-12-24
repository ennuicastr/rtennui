// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2021-2023 Yahweasel
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

export const protocol = {
    ids: {
        // Good and evil
        ack: 0x00,
        nack: 0x01,
        ping: 0x02,
        pong: 0x03,
        rping: 0x04,
        rpong: 0x05,

        // Basic negotiation
        login: 0x10,
        formats: 0x11,
        rtc: 0x12,

        // Peer and stream info
        peer: 0x20,
        stream: 0x21,
        info: 0x22, // Other info

        // Actual streaming data, sent via multiple channels
        data: 0x30,
        relay: 0x31
    },

    parts: {
        /* ack:
         * c->c: Acknowledge receipt of data.
         */
        ack: {
            length: 6, // More for specific kinds of ack
            type: 4, // What's being acked, e.g. data

            // When acking data
            dataLength: 7, // + much more
            dataStreamIdx: 6,
            dataAcks: 7
            /* Format of dataAcks:
             * Two netints representing the range (lower-bound inclusive,
             * upper-bound exclusive) of packets being acked or nacked. Then, a
             * bitarray of 1=ack 0=nack for that range. */
        },

        /* ping:
         * c->c: Determine latency with this client.
         */
        ping: {
            length: 12,
            timestamp: 4 // float64
        },

        /* pong:
         * c->c: Reply to ping.
         */
        pong: {
            length: 12,
            timestamp: 4 // float64, from ping
        },

        /* rping:
         * c->s, s->c, c->c: Determine reliability with this peer.
         */
        rping: {
            length: 8,
            id: 4 // uint32
        },

        /* rpong:
         * c->s, s->c, c->c: Reply to rping.
         */
        rpong: {
            length: 8,
            id: 4 // uint32
        },

        /* login:
         * c->s: Log in with the given JSON credentials
         */
        login: {
            length: 4, // + the actual data
            data: 4
        },

        /* formats:
         * c->s: Inform the server of a change in supported formats
         * s->c: Inform the client of the list of supported formats
         */
        formats: {
            length: 4, // + the actual data
            data: 4
        },

        /* rtc:
         * c->s, s->c, c->s->c: RTC negotiation
         */
        rtc: {
            length: 4, // + the actual data
            data: 4
        },

        /* peer:
         * s->c: Inform the client of the status of a peer
         * c->s: Inform the server of the status of the P2P connection between
         *       this client and another client. `data` unused.
         */
        peer: {
            length: 5, // + data
            status: 4, // uint8, 1 for connected
            data: 5 // JSON
        },

        /* stream:
         * c->s, s->c, c->s->c: Inform fellow clients of the formats and ID of
         *       a stream being sent.
         */
        stream: {
            length: 5, // + data
            id: 4, // only bits in 0x70 used
            data: 5
        },

        /* info:
         * c->s, s->c, c->s->c, c->c: Other metadata info not covered by
         *       anything else, in JSON.
         */
        info: {
            length: 4, // + data
            data: 4
        },

        /* data:
         * c->c: Send encoded data.
         */
        data: {
            length: 5, // + data
            info: 4, // key, stream idx, track idx
            data: 5
            /* Format of data:
             * index: network integer
             * gop index: network integer
             * part: network integer
             * part count: network integer
             * data:
             *   timestamp: network integer
             *   frame data: ... */
        },

        /* relay:
         * c->s->c: Relay encoded data. Includes a *complete* data packet.
         */
        relay: {
            length: 4, // + targets, data
            data: 4
            /* Format of data:
             * Target byte ct: uint8, how many bytes are used to describe all
             *                 targets
             * Target bytes: One byte per 8 targets, 1<<peer set if we should
             *               relay to that target.
             * data: A complete data packet.
             */
        }
    }
};
