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

RTEnnui is largely usable for audio, with the major hole being that you need to
“bring your own VAD”. Video support is technically functional, but suffers from
a lack of APIs to actually capture video in real time, so it is not recommended
to use it yet.


## Usage

The API is documented with TypeDoc at
https://ennuicastr.github.io/doc/rtennui/modules/main.html . Note that the
`main` module (linked) is exposed when you import or require RTEnnui, or you
can include `rtennui.min.js` as a script, in which case the `main` module is
exposed as `RTEnnui`.

You can find a complete (if simple) example of using RTEnnui in the server
repository, in `samples/basic-server`.
