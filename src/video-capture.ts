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

declare let VideoEncoder: any, VideoFrame: any, MediaStreamTrackProcessor: any;

/**
 * General interface for any video capture subsystem, user-implementable. Video
 * capture captures *encoded* video chunks, so is also responsible for
 * encoding.
 *
 * Events:
 * * data(EncodedVideoChunk): A video frame is available and encoded.
 */
export abstract class VideoCapture extends events.EventEmitter {
    constructor() {
        super();
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
        let closeCt = 0;

        const onclose = () => {
            if (++closeCt === ct)
                this.close();
        };

        const ret = Array(ct).fill(null).map(() =>
            new VideoCaptureTee(this));

        for (const tee of ret)
            tee.onclose = onclose;

        this.on("data", data => {
            for (const tee of ret)
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
 * Video capture using WebCodecs and MediaStreamTrackProcessor.
 */
export class VideoCaptureWebCodecs extends VideoCapture {
    constructor(
        /**
         * The input MediaStream.
         */
        private _ms: MediaStream,

        /**
         * The configuration to use.
         */
        private _config: wcp.VideoEncoderConfig
    ) {
        super();

        this._framerate = _ms.getVideoTracks()[0].getSettings().frameRate;

        this._videoEncoder = new VideoEncoder({
            output: x => this.onOutput(x),
            error: x => this.onError(x)
        });

        this._mstp = new MediaStreamTrackProcessor({
            track: _ms.getVideoTracks()[0]
        });

        this._reader = this._mstp.readable.getReader();
    }

    /**
     * A VideoCaptureWebCodecs must be initialized.
     */
    async init() {
        await this._videoEncoder.configure(this._config);

        // Shuttle frames in the background
        (async () => {
            let forceKeyframe = this._framerate * 2;
            while (true) {
                const {done, value} = await this._reader.read();
                if (done)
                    break; // FIXME
                let kf = false;
                forceKeyframe--;
                if (forceKeyframe <= 0) {
                    kf = true;
                    forceKeyframe = this._framerate * 2;
                }
                this._videoEncoder.encode(value, {keyFrame: kf});
                value.close();
            }
        })();
    }

    override close(): void {
        this._reader.cancel();
        this._videoEncoder.close();
    }

    override getWidth(): number {
        return this._ms.getVideoTracks()[0].getSettings().width;
    }

    override getHeight(): number {
        return this._ms.getVideoTracks()[0].getSettings().height;
    }

    override getFramerate(): number {
        return this._framerate;
    }

    /**
     * Called when there's output data.
     */
    onOutput(chunk: wcp.EncodedVideoChunk) {
        this.emitEvent("data", chunk);
    }

    /**
     * Called when there's an error.
     */
    onError(ex: any) {
        console.error(ex);
    }

    private _framerate: number;

    private _videoEncoder: wcp.VideoEncoder;

    private _mstp: any;

    private _reader: ReadableStreamDefaultReader<wcp.VideoFrame>;
}

/**
 * Create an appropriate video capture from a MediaStream.
 */
export async function createVideoCapture(
    ms: MediaStream, config: wcp.VideoEncoderConfig
): Promise<VideoCapture> {
    // For the time being, only VideoCaptureCanvas
    const settings = ms.getVideoTracks()[0].getSettings();
    const ret = new VideoCaptureWebCodecs(ms, config);
    await ret.init();
    return ret;
}
