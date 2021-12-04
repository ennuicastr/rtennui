/*
 * Copyright (c) 2018-2021 Yahweasel
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

/**
 * Encode this text (as UTF-8 if possible).
 */
export function encodeText(text: string): Uint8Array {
    if (window.TextEncoder) {
        return new TextEncoder().encode(text);
    } else {
        // I don't care to do this right, ASCII only
        const ret = new Uint8Array(text.length);
        for (let ni = 0; ni < text.length; ni++) {
            let cc = text.charCodeAt(ni);
            if (cc > 127)
                cc = 95;
            ret[ni] = cc;
        }
        return ret;
    }
}

/**
 * Decode this (UTF-8) text.
 */
export function decodeText(text: ArrayBuffer): string {
    if (window.TextDecoder) {
        return new TextDecoder("utf-8").decode(text);
    } else {
        let ret = "";
        const t8 = new Uint8Array(text);
        for (let ni = 0; ni < t8.length; ni++) {
            ret += String.fromCharCode(t8[ni]);
        }
        return ret;
    }
}

/**
 * How many bytes will it take to encode this number as a network integer?
 */
export function netIntBytes(num: number) {
    if (num === 0)
        return 1;

    let ct = 0;
    while (num) {
        ct++;
        num = Math.floor(num / 0x80);
    }

    return ct;
}

/**
 * Encode this number as a network integer.
 */
export function encodeNetInt(target: Uint8Array, offset: number, num: number) {
    if (num === 0) {
        target[offset] = 0;
        return;
    }

    while (num) {
        let part = num & 0x7F;
        num = Math.floor(num / 0x80);
        if (num)
            part |= 0x80;
        target[offset++] = part;
    }
}

/**
 * Decode a net integer. Returns the number, updates offset in place.
 */
export function decodeNetInt(source: Uint8Array, o: {offset: number}) {
    let ret = 0, mul = 1;

    while (true) {
        const part = source[o.offset++];
        ret += (part & 0x7F) * mul;
        if (!(part & 0x80))
            break;
        mul *= 0x80;
    }

    return ret;
}
