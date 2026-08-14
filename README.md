# peer-server

A minimal WebSocket signaling server for establishing direct WebRTC connections
between two machines. It only relays SDP offers/answers and ICE candidates
between peers — no media or file data ever passes through this server. What
the connected peers do with their WebRTC connection (file transfer, video
calls, etc.) is up to the applications built on top.

## Running

```bash
npm install
npm run dev     # dev server with auto-reload
npm run build   # compile TypeScript to dist/
npm start        # run compiled server
```

The server listens on `PORT` (default `8080`) and exposes a `GET /health`
endpoint for basic liveness checks.

## Protocol

Clients connect over `ws://host:port` and exchange JSON messages.

### Client -> Server

- `{ "type": "register", "id"?: string }`
  Registers the connection under `id`, or a generated UUID if omitted/taken.
- `{ "type": "signal", "target": string, "data": unknown }`
  Relays `data` (an SDP offer/answer or ICE candidate) to the peer with id
  `target`.
- `{ "type": "leave" }`
  Explicitly unregisters the peer.

### Server -> Client

- `{ "type": "registered", "id": string }`
  Confirms registration and returns the assigned peer id.
- `{ "type": "signal", "from": string, "data": unknown }`
  Delivers signaling data forwarded from another peer.
- `{ "type": "peer-disconnected", "id": string }`
  Broadcast when a peer disconnects.
- `{ "type": "error", "message": string }`
  Sent when a request is invalid (e.g. unknown target, malformed JSON).

### Typical flow

1. Both peers connect and send `register`.
2. Peer A sends `signal` with an SDP offer targeting Peer B's id.
3. Peer B receives it, creates an SDP answer, and sends it back via `signal`.
4. Both sides exchange ICE candidates via further `signal` messages.
5. Once ICE negotiation completes, the WebRTC connection is direct
   peer-to-peer and this server is no longer involved.
