# peer-server

A minimal WebSocket signaling server for establishing direct WebRTC connections
between machines. It only relays SDP offers/answers and ICE candidates between
peers — no media, file, or document data ever passes through this server. What
the connected peers do with their WebRTC connection (file transfer, video
calls, collaborative editing) is up to the applications built on top.

## Running

```bash
npm install
npm run dev      # dev server with auto-reload
npm run build    # compile TypeScript to dist/
npm start        # run compiled server
npm test         # unit + protocol tests
npm run typecheck
```

### Configuration

| Variable            | Default    | Purpose                                                           |
| ------------------- | ---------- | ----------------------------------------------------------------- |
| `PORT`              | `8080`     | Port to listen on.                                                |
| `ALLOWED_ORIGINS`   | *(unset)*  | Comma-separated browser origins allowed to open a WebSocket. Unset means any origin, which is convenient for local development and should be set in production. |
| `MAX_PEERS_PER_ROOM`| `8`        | Room capacity. A full mesh needs O(n²) connections, so keep it small. |

`GET /health` returns `{ status, peers, rooms, uptimeSeconds }`.

The server also enforces a 256 KB maximum WebSocket payload and a per-connection
limit of 240 messages per 10 seconds. A client over that limit is told once per
window and then ignored, and is disconnected after three consecutive windows -
answering every frame would amplify a runaway client rather than slow it down.

Re-sending `join` for the room a connection is already in is idempotent: the
peer keeps its id and the other members are not notified, so a reconnect does
not make every peer tear down and rebuild its connection.

## Protocol

Clients connect over `ws://host:port` and exchange JSON messages. There are two
ways to find a peer:

- **Rooms** (recommended) — peers `join` a shared room code and the server tells
  each joiner who is already there.
- **Flat ids** (original protocol) — peers `register` an id and signal each other
  by that id, having exchanged it out of band.

### Client -> Server

- `{ "type": "join", "room": string, "name"?: string, "id"?: string }`
  Joins `room` (case-insensitive, 3–64 characters of letters, digits, and
  hyphens) under the optional display `name`. Replaces any room the connection
  had previously joined.
- `{ "type": "register", "id"?: string }`
  Registers the connection under `id`, or a generated UUID if omitted, taken, or
  not of the form `[A-Za-z0-9._:-]{8,64}`. A peer id is echoed to every other
  member of a room and used as a map key, so anything outside that shape is
  treated as absent rather than stored.
- `{ "type": "signal", "target": string, "data": unknown }`
  Relays `data` (an SDP offer/answer or ICE candidate) to the peer with id
  `target`. The target must be in the same room as the sender.
- `{ "type": "leave" }`
  Explicitly unregisters the peer and leaves its room.

### Server -> Client

- `{ "type": "joined", "id": string, "room": string, "name": string, "peers": { "id": string, "name": string }[] }`
  Confirms a room join. `room` and `name` are the normalized values the server
  actually stored, and `peers` lists the members that were *already* in the room.
- `{ "type": "peer-joined", "id": string, "name": string }`
  Sent to the existing members of a room when someone joins.
- `{ "type": "peer-left", "id": string }`
  Sent to the remaining members of a room when someone leaves or disconnects.
- `{ "type": "registered", "id": string }`
  Confirms a flat registration and returns the assigned peer id.
- `{ "type": "signal", "from": string, "data": unknown }`
  Delivers signaling data forwarded from another peer.
- `{ "type": "peer-disconnected", "id": string }`
  Sent to peers that registered without a room when another *roomless* peer
  disconnects. Departures from a room are reported only to that room, as
  `peer-left`, so room membership never leaks to clients outside it.
- `{ "type": "error", "code": string, "message": string }`
  Sent when a request is invalid. `code` is one of `invalid-json`,
  `invalid-message`, `invalid-room`, `not-registered`, `room-full`,
  `target-not-found`, `target-not-in-room`, or `rate-limited`.

### Typical room flow

1. Peer A sends `join` with a room code and receives `joined` with an empty
   `peers` list.
2. Peer B sends `join` with the same code and receives `joined` with `peers: [A]`.
   Peer A receives `peer-joined` for B.
3. **The joiner sends the offers.** Peer B creates an SDP offer for every peer in
   its `peers` list and sends each via `signal`; the peers already in the room
   only ever answer. This makes the initiator deterministic, so two peers can
   never offer each other at the same time (no glare, no rollback needed).
4. Both sides exchange ICE candidates via further `signal` messages.
5. Once ICE negotiation completes the connection is direct peer-to-peer and this
   server is no longer involved.
6. On disconnect, the remaining members receive `peer-left` and tear down that
   peer's connection.

## Design notes

- `PeerRegistry` keeps a primary map of peer id to record plus a secondary index
  of room membership, so rosters and room broadcasts cost O(room size) rather
  than O(all peers).
- Room membership is stored in join order, which gives every peer the same
  stable view of who joined first.
- Display names are scrubbed of control, zero-width, and bidi characters before
  they are stored, because every other participant's UI renders them.
- The server never inspects `signal.data`; it is opaque relay payload.
