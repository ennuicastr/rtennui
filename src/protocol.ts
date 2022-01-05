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

export const protocol = {
    ids: {
        // Good and evil
        ack: 0x00,
        nack: 0x01,
        ping: 0x02,
        pong: 0x03,

        // Basic negotiation
        login: 0x10,
        formats: 0x11,
        rtc: 0x12,

        // Peer and stream info
        peer: 0x20,
        stream: 0x21,

        // Actual streaming data, sent via multiple channels
        data: 0x30
    },

    parts: {
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

        /* data:
         * c->s->c, c->c: Send encoded data.
         */
        data: {
            length: 5, // + data
            info: 4, // key, stream idx, track idx
            data: 5
            /* Format of data:
             * index: network integer
             * part: network integer
             * part count: network integer
             * data: ... */
        }
    }
};
