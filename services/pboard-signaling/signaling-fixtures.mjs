// Synthetic negotiation only. Never substitute this for native WebRTC tests.
export const SDP=`v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\na=fingerprint:sha-256 ${Array(32).fill('11').join(':')}\r\na=setup:actpass\r\na=sctp-port:5000\r\n`;
export const ICE='candidate:1 1 UDP 2113937151 127.0.0.1 50001 typ host generation 0';
