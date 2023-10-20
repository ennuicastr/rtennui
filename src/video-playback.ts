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

import * as events from "./events";

import type * as wcp from "libavjs-webcodecs-polyfill";
declare let LibAVWebCodecs: typeof wcp;

/**
 * General interface for any video playback subsystem.
 */
export abstract class VideoPlayback extends events.EventEmitter {
    constructor() {
        super();
    }

    /**
     * Display this frame.
     * @param frame  Frame to display.
     */
    abstract display(frame: wcp.VideoFrame): Promise<void>;

    /**
     * Get the underlying HTML element.
     */
    abstract element(): HTMLElement;

    /**
     * Stop this video playback and remove any underlying data.
     */
    abstract close(): void;
}

/**
 * Playback by painting on a canvas.
 */
export class VideoPlaybackCanvas extends VideoPlayback {
    constructor() {
        super();
        const canvasBox = this._canvasBox = document.createElement("div");
        const canvas = this._canvas = document.createElement("canvas");

        Object.assign(canvasBox.style, {
            overflow: "hidden",
            position: "relative"
        });
        canvas.style.position = "absolute";
        canvasBox.appendChild(canvas);

        // Find the best context
        const ctxib = this._ctxib = canvas.getContext("bitmaprenderer");
        if (!ctxib)
            this._ctx2d = canvas.getContext("2d");

        this._iw = this._ih = this._sl = this._st = this._sw = this._sh =
            this._ow = this._oh = 0;
    }

    override async display(frame: wcp.VideoFrame) {
        const canvasBox = this._canvasBox;
        const canvas = this._canvas;

        if (!canvas.parentNode || canvasBox.offsetWidth === 0 || canvasBox.offsetHeight === 0) {
            // Not visible, don't draw
            return;
        }

        // Perhaps adjust the size
        let changedSize = false;

        if (canvasBox.offsetWidth !== this._ow ||
            canvasBox.offsetHeight !== this._oh) {
            const w = this._ow = canvasBox.offsetWidth;
            canvas.width = ~~w;
            const h = this._oh = canvasBox.offsetHeight;
            canvas.height = ~~h;
            if (this._ctx2d)
                this._ctx2d.clearRect(0, 0, w, h);
            changedSize = true;
        }

        if (frame.displayWidth !== this._iw ||
            frame.displayHeight !== this._ih) {
            this._iw = frame.displayWidth;
            this._ih = frame.displayHeight;
            changedSize = true;
        }

        if (changedSize) {
            const iw = this._iw, ih = this._ih, ow = this._ow, oh = this._oh;
            const iar = this._iw / this._ih, oar = this._ow / this._oh;

            if (iar === oar) {
                // Same aspect ratio
                this._sl = this._st = 0;
                this._sw = ow;
                this._sh = oh;

            } else if (iar > oar) {
                // Input wider. Adjust the top position.
                const sh = this._sh = Math.round(ow / iw * ih);
                this._st = ~~((oh - sh) / 2);
                this._sl = 0;
                this._sw = ow;

            } else {
                // Input taller. Adjust the left position.
                const sw = this._sw = Math.round(oh / ih * iw);
                this._sl = ~~((ow - sw) / 2);
                this._st = 0;
                this._sh = oh;

            }

            if (this._ctxib) {
                // Top/left has to be done with padding
                const st = this._st, sl = this._sl;
                canvas.style.padding = `${st}px 0px 0px ${sl}px`;
                canvas.width = this._sw;
                canvas.height = this._sh;
            }
        }

        // Convert
        const image = await LibAVWebCodecs.createImageBitmap(frame, {
            resizeWidth: this._sw,
            resizeHeight: this._sh
        });

        // And draw
        if (this._ctxib)
            this._ctxib.transferFromImageBitmap(image);
        else
            this._ctx2d.drawImage(image, this._sl, this._st);
    }

    override element() {
        return this._canvasBox;
    }

    override close() {
        // Nothing to close here
    }

    /**
     * A box to contain the canvas (the element actually given to the user).
     */
    private _canvasBox: HTMLElement;

    /**
     * The canvas used to display.
     */
    private _canvas: HTMLCanvasElement;

    /**
     * The ImageBitmap context for the canvas, if applicable.
     */
    private _ctxib: ImageBitmapRenderingContext;

    /**
     * The 2D context for the canvas.
     */
    private _ctx2d: CanvasRenderingContext2D;

    private _iw: number;
    private _ih: number;
    private _sl: number;
    private _st: number;
    private _sw: number;
    private _sh: number;
    private _ow: number;
    private _oh: number;
}

/**
 * Create a supported VideoPlayback.
 */
export async function createVideoPlayback(): Promise<VideoPlayback> {
    return new VideoPlaybackCanvas();
}
