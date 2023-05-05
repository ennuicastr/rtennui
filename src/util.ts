// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2018-2023 Yahweasel
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
 * Standard ICE servers. Note that our WebSocket server will relay data if we
 * can't get a direct connection, so we have no use for TURN.
 * @private
 */
export const iceServers = [{urls: "stun:stun.l.google.com:19302"}];

/**
 * Encode this text (as UTF-8 if possible).
 * @private
 * @param text  Text to encode.
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
 * @private
 * @param text  Encoded text.
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
 * @param num  Number to encode.
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
 * @param target  Buffer to encode the number into.
 * @param offset  Offset within the buffer.
 * @param num  Number to encode.
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
 * @param source  Buffer from which to decode a number.
 * @param o  Offset, in an object to report the resulting offset.
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

/**
 * True if this browser is Chrome. Really just used by isSafari, below.
 */
export function isChrome() {
    // Edge is Chrome, Opera is Chrome, Brave is Chrome...
    return navigator.userAgent.indexOf("Chrome") >= 0;
}

/**
 * True if this browser is Safari (and NOT Chrome). Used to work around some
 * Safari-specific bugs.
 */
export function isSafari(): boolean {
    // Chrome pretends to be Safari
    return navigator.userAgent.indexOf("Safari") >= 0 && !isChrome();
}

/**
 * True if this browser is Firefox.
 */
export function isFirefox(): boolean {
    return navigator.userAgent.indexOf("Firefox") >= 0;
}

/**
 * True if this browser is on Android. Used to work around some
 * Android-Chrome-specific bugs.
 */
export function isAndroid(): boolean {
    return navigator.userAgent.indexOf("Android") >= 0;
}

/**
 * Bug workaround check: True if we need to use shared audio nodes. This used
 * to be true on Safari, because it has trouble if you use audio nodes for both
 * input and output. But, Safari can now use AudioBuffers for output, so
 * nothing needs shared nodes.
 */
export function bugNeedSharedNodes(): boolean {
    return false;
}

/**
 * Bug check: On Chrome, we prefer MediaRecorder for capture, because it works
 * better than the alternatives, except on Android, where it doesn't work at all.
 */
export function bugPreferMediaRecorder(): boolean {
    return isChrome() && !isAndroid();
}

/**
 * Connected to the above, true if we can use MediaRecorder at all.
 */
export function supportsMediaRecorder(): boolean {
    return typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported("video/x-matroska; codecs=pcm");
}

/**
 * Bug check: Don't use AudioBuffer-based playback on Firefox, because it's not
 * reliably seamless.
 */
export function bugUnreliableAudioBuffers(): boolean {
    return isFirefox();
}

/**
 * Bug check: On Chrome, ScriptProcessor is only reliable with large buffers.
 * On most Chrome, we use MediaRecorder + AudioBuffer, so this doesn't affect
 * us, but on Android, we still capture with a ScriptProcessor.
 */
export function bugNeedLargeBuffers(): boolean {
    return isChrome();
}
