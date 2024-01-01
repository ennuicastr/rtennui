// SPDX-License-Identifier: ISC
/*
 * Copyright (c) 2021-2024 Yahweasel
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

import * as events from "./events";

/**
 * The shared room functionality needed by both the room itself and peers (here
 * to avoid circular dependencies). Note that these methods are named with _
 * because they're internal to RTEnnui (and should not be called by external
 * users), but they are public.
 * @private
 */
export abstract class AbstractRoom extends events.EventEmitter {
    /**
     * Get *our* ID in this room.
     * @private
     */
    abstract _getOwnId(): number;

    /**
     * Get the current outgoing stream ID.
     * @private
     */
    abstract _getStreamId(): number;

    /**
     * Get the next outgoing packet index.
     * @private
     */
    abstract _getPacketIdx(): number;

    /**
     * Send a message to the server.
     * @private
     */
    abstract _sendServer(msg: ArrayBuffer): void;

    /**
     * Relay a message to a specific list of users.
     * @param msg  Message to relay
     * @param targets  User IDs to relay it to
     * @private
     */
    abstract _relayMessage(
        msg: ArrayBuffer, targets: number[], opts?: {
            reliability?: number
        }
    ): void;

    /**
     * Attempt to (de)grade bitrate by adjusting video tracks.
     * @private
     */
    abstract _grade(by: number): boolean;
}
