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

import * as util from "./util";

/**
 * A description of a number entry.
 */
export type NumberDescr = [number, number, number];

/**
 * A description of a raw entry.
 */
export type RawDescr = [number, Uint8Array];

/**
 * A description is either.
 */
export type Descr = NumberDescr | RawDescr;

/**
 * Create an ArrayBuffer based on a description.
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

                default:
                    throw new Error("Invalid description");
            }

        } else {
            retU8.set(<Uint8Array> d[1], d[0]);

        }
    }

    return retAB;
}
