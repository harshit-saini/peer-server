import { createSignalingServer } from './server.js';
import { normalizeRoomCapacity, parseAllowedOrigins } from './validation.js';

const DEFAULT_MAX_PEERS_PER_ROOM = 8;

const PORT = Number(process.env.PORT) || 8080;
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const maxPeersPerRoom = normalizeRoomCapacity(
  process.env.MAX_PEERS_PER_ROOM,
  DEFAULT_MAX_PEERS_PER_ROOM,
);

const server = createSignalingServer({ allowedOrigins, maxPeersPerRoom });

server.listen(PORT).then((port) => {
  console.log(`Peer signaling server listening on port ${port}`);
  if (allowedOrigins.length > 0) {
    console.log(`Accepting WebSocket origins: ${allowedOrigins.join(', ')}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close().then(() => process.exit(0));
  });
}
