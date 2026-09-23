import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { PeerRegistry } from './PeerRegistry.js';
import {
  RateLimiter,
  isOriginAllowed,
  normalizeDisplayName,
  normalizePeerId,
  normalizeRoomCode,
} from './validation.js';
import type { ClientMessage, ServerErrorCode, ServerMessage } from './types.js';

interface PeerSocket extends WebSocket {
  peerId?: string;
  isAlive?: boolean;
  rateLimiter?: RateLimiter;
  /** True while the current rate-limit window is already over budget. */
  rateLimited?: boolean;
  /** Consecutive windows this socket has blown through; used to cut off a persistent flooder. */
  rateLimitStrikes?: number;
}

export interface SignalingServerOptions {
  /** Empty means any origin is accepted, which is the right default for local development. */
  allowedOrigins?: string[];
  /** A full-mesh call is O(n^2) connections, so rooms stay small enough to remain usable. */
  maxPeersPerRoom?: number;
  /** SDP offers with many codecs run to a few KB; past this it is not signaling traffic. */
  maxPayloadBytes?: number;
  messageLimit?: number;
  messageLimitWindowMs?: number;
  heartbeatIntervalMs?: number;
}

export interface SignalingServer {
  readonly httpServer: http.Server;
  readonly wss: WebSocketServer;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  stats(): { peers: number; rooms: number };
}

/** Consecutive over-budget windows tolerated before the connection is dropped. */
const RATE_LIMIT_STRIKE_LIMIT = 3;

const DEFAULTS = {
  maxPeersPerRoom: 8,
  maxPayloadBytes: 256 * 1024,
  messageLimit: 240,
  messageLimitWindowMs: 10_000,
  heartbeatIntervalMs: 30_000,
} as const;

export function createSignalingServer(options: SignalingServerOptions = {}): SignalingServer {
  const allowedOrigins = options.allowedOrigins ?? [];
  const maxPeersPerRoom = options.maxPeersPerRoom ?? DEFAULTS.maxPeersPerRoom;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes;
  const messageLimit = options.messageLimit ?? DEFAULTS.messageLimit;
  const messageLimitWindowMs = options.messageLimitWindowMs ?? DEFAULTS.messageLimitWindowMs;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;

  const registry = new PeerRegistry<PeerSocket>();
  const startedAt = Date.now();

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // A browser fetch of /health from the app's own origin is a cross-origin request, and
        // unlike the WebSocket handshake it *is* subject to CORS. The body is only counters.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          peers: registry.size,
          rooms: registry.roomCount,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: maxPayloadBytes,
    // `origin` is typed as string but is absent for non-browser clients, which isOriginAllowed
    // handles explicitly.
    verifyClient: (info: { origin: string }) => isOriginAllowed(info.origin, allowedOrigins),
  });

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(socket: WebSocket, code: ServerErrorCode, message: string): void {
    send(socket, { type: 'error', code, message });
  }

  function broadcastToRoom(room: string, message: ServerMessage, exclude?: string): void {
    for (const peer of registry.membersOf(room)) {
      if (peer.id !== exclude) {
        send(peer.socket, message);
      }
    }
  }

  /**
   * Drops the socket's registry entry and notifies whoever was watching it: room members get a
   * room-scoped `peer-left`, while peers on the original flat protocol keep receiving the
   * documented global `peer-disconnected` broadcast.
   */
  function releasePeerId(socket: PeerSocket): void {
    if (!socket.peerId) return;

    const peerId = socket.peerId;
    socket.peerId = undefined;

    const record = registry.get(peerId);
    // Guard against removing an id that a later connection has since taken over.
    if (!record || record.socket !== socket) {
      return;
    }

    const room = record.room;
    registry.unregister(peerId);

    if (room) {
      // Strictly room-scoped: roomless peers must not learn the ids of members of a room they were
      // never part of, and backward compatibility only requires them to hear about roomless
      // departures.
      broadcastToRoom(room, { type: 'peer-left', id: peerId });
      return;
    }

    const disconnected: ServerMessage = { type: 'peer-disconnected', id: peerId };
    for (const peer of registry.roomless()) {
      send(peer.socket, disconnected);
    }
  }

  /**
   * Assigns the socket a peer id, releasing any id it already held. A requested id is honoured
   * only when free, preserving the documented "generated UUID if taken" behaviour.
   */
  function assignPeerId(socket: PeerSocket, requestedId: unknown): string {
    if (socket.peerId) {
      releasePeerId(socket);
    }

    const requested = normalizePeerId(requestedId);
    if (!requested) {
      return randomUUID();
    }

    const existing = registry.get(requested);
    if (!existing) {
      return requested;
    }

    // The id is held by a connection that is already gone - a client that reconnected faster than
    // the heartbeat noticed its old socket die. Handing it a fresh id instead would leave its
    // previous entry in the roster, so every other peer would sit trying to reach a socket that
    // will never answer until the sweep reaps it, up to HEARTBEAT_INTERVAL_MS later.
    //
    // Not covered by a test: a socket that dies without a close frame needs a real network drop,
    // and faking one in-process means detaching the server socket's handlers, which then keeps
    // the http server from closing. The path is exercised by the ordinary reconnect test, which
    // takes the `!existing` branch above.
    if (existing.socket.readyState !== WebSocket.OPEN) {
      releaseDeadPeer(requested);
      return requested;
    }

    return randomUUID();
  }

  /** Removes a peer whose socket has closed, announcing it as a normal departure. */
  function releaseDeadPeer(peerId: string): void {
    const record = registry.get(peerId);
    if (!record) {
      return;
    }

    const room = record.room;
    registry.unregister(peerId);

    if (room) {
      broadcastToRoom(room, { type: 'peer-left', id: peerId });
      return;
    }

    const disconnected: ServerMessage = { type: 'peer-disconnected', id: peerId };
    for (const peer of registry.roomless()) {
      send(peer.socket, disconnected);
    }
  }

  function handleRegister(socket: PeerSocket, message: Extract<ClientMessage, { type: 'register' }>): void {
    const id = assignPeerId(socket, message.id);
    socket.peerId = id;
    registry.register(id, socket);
    send(socket, { type: 'registered', id });
  }

  function handleJoin(socket: PeerSocket, message: Extract<ClientMessage, { type: 'join' }>): void {
    const room = normalizeRoomCode(message.room);
    if (!room) {
      sendError(socket, 'invalid-room', 'Room codes must be 3-64 characters of letters, digits, or hyphens');
      return;
    }

    const name = normalizeDisplayName(message.name);
    const current = socket.peerId ? registry.get(socket.peerId) : undefined;

    // Re-joining the room this socket already occupies is idempotent: the peer keeps its id and
    // the other members keep their connections. Without this, a reconnect or a double-invoked
    // effect in React's strict mode would look like a leave followed by a join, and every other
    // peer would tear down and rebuild its connection - dropping in-flight file transfers and
    // notepad state for no reason.
    if (current && current.room === room && current.socket === socket) {
      registry.joinRoom(current.id, room, name);
      send(socket, {
        type: 'joined',
        id: current.id,
        room,
        name,
        peers: registry.rosterOf(room, current.id),
      });
      return;
    }

    if (registry.sizeOfRoom(room) >= maxPeersPerRoom) {
      sendError(socket, 'room-full', `Room ${room} already has ${maxPeersPerRoom} peers`);
      return;
    }

    const id = assignPeerId(socket, message.id);
    socket.peerId = id;
    // The roster is captured before the joiner is added, so it holds exactly the peers this
    // client is responsible for sending offers to.
    const peers = registry.rosterOf(room);
    registry.register(id, socket, { name, room });

    send(socket, { type: 'joined', id, room, name, peers });
    broadcastToRoom(room, { type: 'peer-joined', id, name }, id);
  }

  function handleSignal(socket: PeerSocket, message: Extract<ClientMessage, { type: 'signal' }>): void {
    if (!socket.peerId) {
      sendError(socket, 'not-registered', 'Register or join before signaling');
      return;
    }

    if (typeof message.target !== 'string' || message.target.length === 0) {
      sendError(socket, 'invalid-message', 'signal requires a target peer id');
      return;
    }

    if (message.target === socket.peerId) {
      sendError(socket, 'invalid-message', 'Cannot signal yourself');
      return;
    }

    const sender = registry.get(socket.peerId);
    const target = registry.get(message.target);

    if (!sender || !target) {
      sendError(socket, 'target-not-found', `Peer ${message.target} not found`);
      return;
    }

    // Peers may only signal inside their own room. The roomless peers of the original flat
    // protocol all have `room === null`, so they can still reach each other by id.
    if (sender.room !== target.room) {
      sendError(socket, 'target-not-in-room', `Peer ${message.target} is not in your room`);
      return;
    }

    send(target.socket, { type: 'signal', from: socket.peerId, data: message.data });
  }

  wss.on('connection', (socket: PeerSocket) => {
    socket.isAlive = true;
    socket.rateLimiter = new RateLimiter(messageLimit, messageLimitWindowMs);
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw) => {
      if (socket.rateLimiter && !socket.rateLimiter.accept(Date.now())) {
        // Reply at most once per window, then drop silently. Answering every frame would give a
        // runaway client 1:1 amplification - more traffic than not rate limiting at all - and a
        // deliberate flooder would never be cut off.
        if (!socket.rateLimited) {
          socket.rateLimited = true;
          socket.rateLimitStrikes = (socket.rateLimitStrikes ?? 0) + 1;
          sendError(socket, 'rate-limited', 'Too many messages; slow down');

          if (socket.rateLimitStrikes > RATE_LIMIT_STRIKE_LIMIT) {
            socket.terminate();
          }
        }
        return;
      }

      socket.rateLimited = false;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        sendError(socket, 'invalid-json', 'Invalid JSON');
        return;
      }

      if (!isClientMessage(parsed)) {
        sendError(socket, 'invalid-message', 'Messages must be an object with a string type');
        return;
      }

      switch (parsed.type) {
        case 'register':
          handleRegister(socket, parsed);
          break;
        case 'join':
          handleJoin(socket, parsed);
          break;
        case 'signal':
          handleSignal(socket, parsed);
          break;
        case 'leave':
          releasePeerId(socket);
          break;
        default:
          sendError(socket, 'invalid-message', 'Unknown message type');
      }
    });

    socket.on('close', () => releasePeerId(socket));
    socket.on('error', () => releasePeerId(socket));
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients as Set<PeerSocket>) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, heartbeatIntervalMs);
  // Without this the interval alone keeps the event loop (and `node --test`) alive forever.
  heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));

  return {
    httpServer,
    wss,
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          httpServer.removeListener('error', reject);
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close(): Promise<void> {
      clearInterval(heartbeat);
      return new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
    stats() {
      return { peers: registry.size, rooms: registry.roomCount };
    },
  };
}

function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === 'object' && value !== null && typeof (value as ClientMessage).type === 'string';
}
