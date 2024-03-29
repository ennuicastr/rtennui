# RTEnnui

RTEnnui is a replacement for the live audiovisual chat part of WebRTC, using
WebRTC only for data transport. The reason for RTEnnui is that the WebRTC
standard has failed in its goal of being principally a peer-to-peer system; in
practical systems, particularly if video is included, there is a central server
that shuttles data between all users. The reason for this is how WebRTC handles
negotiation: each WebRTC connection is considered independent, and performs its
own protocol and bitrate negotiation, and so starts its own encoder. This
doesn't scale.

RTEnnui performs central negotiation, but uses peer-to-peer data transfer
whenever possible. It is designed to degrade from purely peer-to-peer to
centralized to limit bandwidth when needed, and to decrease bandwidth by
decreasing bitrate as needed. To achieve this, it does all its own encoding and
decoding, using [libav.js](https://github.com/Yahweasel/libav.js),
[libavjs-webcodecs-polyfill](https://github.com/ennuicastr/libavjs-webcodecs-polyfill),
and [WebCodecs](https://www.w3.org/TR/webcodecs/).

This repository is for the RTEnnui client. See the
[rtennui-server](https://github.com/ennuicastr/rtennui-server) repository for
the server.


## Protocol

RTEnnui peers connect to a central server via a WebSocket, and use that central
connection to negotiate everything else. It also establishes an unreliable,
WebRTC data channel to the server, which it uses exclusively for relaying AV
data that doesn't require a reliable connection, and only if a direct connection
to a user cannot be established.

Many parts of the protocol use so-called “extensible naturals”. The high-order
bit of each byte of an extensible natural informs the reader of whether there
are further bytes to be read. For instance, `1000 0100  0010 1010` encodes
`000 0100   010 1010`. Extensible naturals (and all integers in the protocol)
are little-endian, so this encodes the number `1010100000100`, or 5,380.

All protocol messages start with a 16-bit peer ID, little-endian. Whether this
refers to the receiver or sender depends on the context: in client-to-server
communication, it refers to the receiver; in server-to-client communication, it
refers to the sender; in client-to-client communication, it refers to the
sender. The maximum integer value is reserved to mean “all peers”, “all relevant
peers”, or “the server”, depending on context.

After the peer ID is a 16-bit command, and after that is the command payload,
the format of which varies based on the command. The command IDs and payloads
are documented in [protocol.js](protocol.js).

To log in, a client must have a JSON object that allows their login. Exactly
what this is depends on the user and is considered outside the protocol, but it
typically consists of a room ID and key. Also on login, the client provides a
list of formats it can *transmit*, and a list of formats it can *receive*.
Formats are named with a single character indicating the type (`v` for video,
`a` for audio) followed by some usual name for the codec. Where possible, these
formats follow the WebCodecs registry, so, for instance, VP9 is `vvp09`
(followed by a dot and a long sequence of VP9-specific restrictions). There is
also one pseudo-codec, `vvp8lo`, which means VP8, but with the caveat that some
clients might be using software decoding, so low-resolution streams should be
used. The server replies with a list of formats that everyone can receive—this
message is resent every time that list changes—as well as the list of peers. At
this point, the client should negotiate a WebRTC data channel to the server
itself, to establish an unreliable data link with the server.

There are five types of connection a peer can have to another peer: bridged
reliable, bridged unreliable, P2P reliable, P2P semireliable, and P2P
unreliable. “Bridged” really means “relayed via the server”, of course, so all
peers have at least a bridged reliable connection to every other peer, since all
peers have a server connection. Generally, video I-frames are always sent via a
reliable connection, audio is sent via the P2P semireliable connection, and all
other live chat data is sent via an unreliable connection. When the right
combination of bridge and reliability is not available, it is preferable to send
in the correct reliability rather than the correct bridge. The bridged reliable
connection is the WebSocket necessary for all negotiation, so it should always
be available as a fallback when neither part of the combination is available.

A stream consists of a header followed by packets. The header is always sent
via the bridged reliable connection, and consists simply of a JSON array of
stream information. The information in each array element depends on the format
support, but must be a JSON object in which the `codec` field is a string, and
the `frameDuration` field is a number (the duration of each frame in
microseconds). The clients use the stream header to determine the tracks. Each
stream has a unique ID per client, so that other clients don't try to mix data
from different streams, but a client can only send one stream at a time. The
possibility of mixing data from different streams arises from data arriving out
of order.

When a client receives a header, it should discard any live streams it has from
the sending client and start a new one. To start a stream, the client must
create decoders for each track. Whenever it receives a frame, it sends it to
the appropriate decoder. The resulting data is played live, with some caveats
to balance liveness and smoothness.

Due to WebRTC data channel limitations, each frame is broken into small (<64KiB)
parts, and send as a sequence of chunks. For audio data, typically there is only
one chunk per part, but for video data, splitting is usually necessary. Each
frame includes its stream, track, index (i.e., sequence number), and “GOP
offset”, i.e., the number of frames since the last I-frame (the index into the
group of pictures). With this data, clients can avoid skipping keyframes and
keep the rate of playback consistent and low-latency.
