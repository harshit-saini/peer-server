import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { PeerRegistry } from './PeerRegistry.js';
import type { ClientMessage, ServerMessage } from './types.js';

interface PeerSocket extends WebSocket {
  peerId?: string;
  isAlive?: boolean;
}

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_INTERVAL_MS = 30_000;

const registry = new PeerRegistry();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', peers: registry.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function removePeer(socket: PeerSocket): void {
  if (!socket.peerId) return;
  registry.unregister(socket.peerId);
  const disconnected: ServerMessage = { type: 'peer-disconnected', id: socket.peerId };
  for (const peer of registry.all()) {
    send(peer, disconnected);
  }
  socket.peerId = undefined;
}

wss.on('connection', (socket: PeerSocket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (message.type) {
      case 'register': {
        const id = message.id && !registry.has(message.id) ? message.id : randomUUID();
        socket.peerId = id;
        registry.register(id, socket);
        send(socket, { type: 'registered', id });
        break;
      }
      case 'signal': {
        if (!socket.peerId) {
          send(socket, { type: 'error', message: 'Register before signaling' });
          return;
        }
        const target = registry.get(message.target);
        if (!target) {
          send(socket, { type: 'error', message: `Peer ${message.target} not found` });
          return;
        }
        send(target, { type: 'signal', from: socket.peerId, data: message.data });
        break;
      }
      case 'leave': {
        removePeer(socket);
        break;
      }
      default:
        send(socket, { type: 'error', message: 'Unknown message type' });
    }
  });

  socket.on('close', () => removePeer(socket));
  socket.on('error', () => removePeer(socket));
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
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Peer signaling server listening on port ${PORT}`);
});
