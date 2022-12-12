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

import * as audioBidir from "./audio-bidir";
import * as audioCapture from "./audio-capture";
import * as audioPlayback from "./audio-playback";
import * as net from "./net";
import * as outgoingAudioStream from "./outgoing-audio-stream";
import * as peer from "./peer";
import {protocol as prot} from "./protocol";
import * as room from "./room";
import * as util from "./util";
import * as videoCapture from "./video-capture";

export async function load() {
    await peer.load();
}

export type AudioCapture = audioCapture.AudioCapture;
export const AudioCapture = audioCapture.AudioCapture;
export type AudioCaptureOptions = audioCapture.AudioCaptureOptions;
export const createAudioCapture = audioBidir.createAudioCapture;

export type AudioPlayback = audioPlayback.AudioPlayback;
export const AudioPlayback = audioPlayback.AudioPlayback;
export type AudioPlaybackOptions = audioPlayback.AudioPlaybackOptions;
export const createAudioPlayback = audioBidir.createAudioPlayback;

export const audioCapturePlaybackShared = audioBidir.audioCapturePlaybackShared;

export type Reliability = net.Reliability;
export const Reliability = net.Reliability;

export type ReliabilityProber = net.ReliabilityProber;
export const ReliabilityProber = net.ReliabilityProber;

export type OutgoingAudioStreamOptions =
    outgoingAudioStream.OutgoingAudioStreamOptions;

export type Connection = room.Connection;
export const Connection = room.Connection;

export const protocol = prot;

export const netIntBytes = util.netIntBytes;
export const encodeNetInt = util.encodeNetInt;
export const decodeNetInt = util.decodeNetInt;

export type VideoCapture = videoCapture.VideoCapture;
export const VideoCapture = videoCapture.VideoCapture;
export const createVideoCapture = videoCapture.createVideoCapture;
