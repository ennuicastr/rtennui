# RTEnnui

RTEnnui is a replacement for the media component of WebRTC. Its goals are
portability, low latency, and control.

WebRTC's support for client-to-client data connections is good, but its media
support suffers from design by committee. It's extremely opaque, has
unpredictable latency and performance, and has requirements that are quite
onerous in terms of patents.

RTEnnui fixes this by doing the media component in software, and using WebRTC
only for the peer-to-peer connection. This gives us direct control over things
like buffering and encoding.

You can find information on the design in [DESIGN.md](DESIGN.md). The server
component is at https://github.com/ennuicastr/rtennui-server .


## Status

RTEnnui is usable for both video and audio on Chrome, Chromium-based browsers,
Safari, and Firefox. Video on Firefox is noticeably degraded, and if a
Firefox-based browser connects to a session, video will be degraded for *all*
users. This is because Firefox does not support WebCodecs (yet?), so it has to
do its decoding in software.

There is a reason that this is a 0-dot release of RTEnnui. It's good enough that
its author uses it in real-life situations, but it's far from perfect.


## Usage

The API is documented with TypeDoc at
https://ennuicastr.github.io/doc/rtennui/modules/main.html . Note that the
`main` module (linked) is exposed when you import or require RTEnnui, or you
can include `rtennui.min.js` as a script, in which case the `main` module is
exposed as `RTEnnui`.

RTEnnui requires that you load [libav.js](https://github.com/Yahweasel/libav.js)
with support for at least demuxing MOV/MP4 and Matroska/WebM files, and
en/decoding VP8, e.g., the `webcodecs` variant.

You can find a complete (if simple) example of using RTEnnui in the server
repository, in `samples/basic-server`.
