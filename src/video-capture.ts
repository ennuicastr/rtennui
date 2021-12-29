// SPDX-License-Identifier: ISC
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

import * as events from "./events";

import type * as wcp from "libavjs-webcodecs-polyfill";

/**
 * General interface for any video capture subsystem, user-implementable.
 *
 * Events:
 * * data(VideoFrame): A video frame is available.
 */
export abstract class VideoCapture extends events.EventEmitter {
    constructor() {
        super();
        this.VideoFrame = null;
    }

    /**
     * Stop this video capture and remove any underlying data.
     */
    abstract close(): void;

    /**
     * "Tee" this capture into the number of receivers specified.
     * @param ct  Number of duplicates to make.
     */
    tee(ct: number): VideoCapture[] {
        if (!this.VideoFrame) {
            // This needs to be set first
            throw new Error("VideoFrame must be set before tee");
        }

        let closeCt = 0;

        const onclose = () => {
            if (++closeCt === ct)
                this.close();
        };

        const ret = Array(ct).fill(null).map(() =>
            new VideoCaptureTee(this));

        for (const tee of ret) {
            tee.VideoFrame = this.VideoFrame;
            tee.onclose = onclose;
        }

        this.on("data", data => {
            for (let i = 0; i < ct - 1; i++) {
                const tee = ret[i];
                tee.emitEvent("data", data.clone());
            }
            const tee = ret[ct - 1];
            tee.emitEvent("data", data);
        });

        return ret;
    }

    /**
     * Get the width of video frames from this capture.
     */
    abstract getWidth(): number;

    /**
     * Get the height of video frames from this capture.
     */
    abstract getHeight(): number;

    /**
     * Get the framerate of this capture.
     */
    abstract getFramerate(): number;

    /**
     * VideoFrame type to be used by captured frame, set by the user, but
     * restricted by certain capture types.
     */
    VideoFrame?: typeof wcp.VideoFrame;
}

/**
 * Tee'd video capture.
 */
export class VideoCaptureTee extends VideoCapture {
    constructor(private _base: VideoCapture) {
        super();
    }

    override close() {
        if (this.onclose)
            this.onclose();
    }

    override getWidth() {
        return this._base.getWidth();
    }

    override getHeight() {
        return this._base.getHeight();
    }

    override getFramerate() {
        return this._base.getFramerate();
    }

    onclose?: () => void;
}

/**
 * Video capture using canvas painting.
 */
export class VideoCaptureCanvas extends VideoCapture {
    constructor(
        /**
         * The underlying video source.
         */
        public source: MediaStream
    ) {
        super();

        // The actual video stream in the source
        const srcVideo = source.getVideoTracks()[0];
        const settings = srcVideo.getSettings();
        const w = this._width = settings.width;
        const h = this._height = settings.height;
        const fr = this._framerate = settings.frameRate;

        // Create the <video> that will play the source
        const video = this._video = document.createElement("video");
        video.width = w;
        video.height = h;
        video.style.display = "none";
        document.body.appendChild(video);

        // Play the video
        video.defaultMuted = video.muted = true;
        video.srcObject = source;
        video.play().catch(console.error);

        // Timestamp management
        let ts = 0;
        const tsStep = Math.round(1000000 / fr);

        // Start our capture
        this._interval = setInterval(() => {
            if (!this.VideoFrame)
                return;

            let frame: wcp.VideoFrame = null;
            try {
                frame = new this.VideoFrame(video, {
                    timestamp: ts
                });
            } catch (ex) {}
            if (!frame)
                return;
            ts += tsStep;
            this.emitEvent("data", frame);
        }, ~~(1000 / fr));
    }

    close() {
        if (this._video) {
            try {
                this._video.pause();
            } catch (ex) {}
            try {
                this._video.parentNode.removeChild(this._video);
            } catch (ex) {}
            this._video = null;
        }

        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    getWidth() { return this._width; }
    getHeight() { return this._height; }
    getFramerate() { return this._framerate; }

    /**
     * Width of the captured video.
     */
    private _width: number;

    /**
     * Height of the captured video.
     */
    private _height: number;

    /**
     * Framerate of the captured video.
     */
    private _framerate: number;

    /**
     * The <video> element for the video being played.
     */
    private _video: HTMLVideoElement;

    /**
     * The interval used for capturing.
     */
    private _interval: number;
}

/**
 * Create an appropriate video capture from a MediaStream.
 */
export async function createVideoCapture(
    ms: MediaStream
): Promise<VideoCapture> {
    // For the time being, only VideoCaptureCanvas
    return new VideoCaptureCanvas(ms);
}
