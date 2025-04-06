// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2024 Yahweasel
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

import * as net from "./net";
import {protocol as prot} from "./protocol";

const pingTime = 30000;
const missedPongsLimit = 0;

export class PingingSocket {
    constructor(
        public socket: WebSocket | RTCDataChannel,
        private _pingTime = pingTime,
        private _missedPongsLimit = missedPongsLimit
    ) {
        socket.onmessage = this._onmessage.bind(this);
        socket.onclose = this._onclose.bind(this);
        socket.onerror = this._onerror.bind(this);
        this.close = socket.close.bind(socket);
        this.addEventListener = socket.addEventListener.bind(socket);
        this.removeEventListener = socket.removeEventListener.bind(socket);
        this._interval = null;
        this._resetInterval();
    }

    /**
     * Send this message on the socket.
     */
    send(msg: ArrayBuffer) {
        return this.socket.send(msg);
    }

    /**
     * Get the buffered amount (if possible).
     */
    bufferedAmount() {
        return this.socket.bufferedAmount;
    }

    /**
     * @private
     * Reset the ping interval.
     */
    private _resetInterval() {
        if (this._interval)
            clearInterval(this._interval);
        this._interval = setInterval(this._ping.bind(this), this._pingTime);
    }

    /**
     * @private
     * Receive a message.
     */
    private _onmessage(ev: MessageEvent) {
        const msg = new DataView(ev.data);
        if (msg.byteLength >= 4) {
            const cmd = msg.getUint16(2, true);
            if (cmd === prot.ids.pong)
                this._missedPongs = 0;
        }

        this._resetInterval();
        if (this.onmessage)
            this.onmessage(ev);
    }

    private _onclose(ev: CloseEvent) {
        if (this._interval)
            clearInterval(this._interval);
        this._interval = null;
        if (this.onclose)
            this.onclose(ev);
    }

    private _onerror(ev: Event) {
        if (this._interval)
            clearInterval(this._interval);
        this._interval = null;
        if (this.onerror)
            this.onerror(ev);
    }

    /**
     * @private
     * Perform a ping.
     */
    private _ping() {
        if (this._missedPongs > this._missedPongsLimit) {
            let close = true;
            if (this.onmissedpong)
                close = !this.onmissedpong(this._missedPongs);
            if (close) {
                this.close();
                return;
            }
        }
        this._missedPongs++;

        const p = prot.parts.ping;
        const msg = net.createPacket(
            p.length, 65535,
            prot.ids.ping,
            []
        );
        this.socket.send(msg);
    }

    close: () => void;
    addEventListener: typeof EventTarget.prototype.addEventListener;
    removeEventListener: typeof EventTarget.prototype.removeEventListener;
    onmessage?: (ev: MessageEvent) => void;
    onclose?: (ev: CloseEvent) => void;
    onerror?: (ev: Event) => void;
    onmissedpong?: (ct: number) => boolean | undefined;

    private _missedPongs = 0;
    private _interval: number | null;
}
