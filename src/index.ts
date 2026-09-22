import { createSignalingServer } from './server.js';
import { parseAllowedOrigins } from './validation.js';

const PORT = Number(process.env.PORT) || 8080;
const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const maxPeersPerRoom = Number(process.env.MAX_PEERS_PER_ROOM) || undefined;

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
