import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { createSignalingServer, type SignalingServer } from './server.js';
import type { ClientMessage, ServerMessage } from './types.js';

/**
 * A test client that buffers every server message, so a test can await the next message of a
 * given type without racing the socket.
 */
class TestClient {
  private readonly received: ServerMessage[] = [];
  private readonly waiters: { type: ServerMessage['type']; resolve: (message: ServerMessage) => void }[] = [];
  private readonly socket: WebSocket;

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type);

      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.resolve(message);
        return;
      }

      this.received.push(message);
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const client = new TestClient(url);
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
    });
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Sends bytes verbatim, for exercising the server's parse and shape guards. */
  sendRaw(payload: string): void {
    this.socket.send(payload);
  }

  /** Resolves with the first buffered or subsequently received message of `type`. */
  next<T extends ServerMessage['type']>(type: T, timeoutMs = 2000): Promise<Extract<ServerMessage, { type: T }>> {
    const bufferedIndex = this.received.findIndex((message) => message.type === type);
    if (bufferedIndex >= 0) {
      const [message] = this.received.splice(bufferedIndex, 1);
      return Promise.resolve(message as Extract<ServerMessage, { type: T }>);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for a "${type}" message`));
      }, timeoutMs);

      this.waiters.push({
        type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  /** True when no message of `type` shows up within `windowMs`. */
  async receivedNothing(type: ServerMessage['type'], windowMs = 150): Promise<boolean> {
    try {
      await this.next(type, windowMs);
      return false;
    } catch {
      return true;
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

describe('signaling server', () => {
  let server: SignalingServer;
  let url: string;
  const clients: TestClient[] = [];

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(url);
    clients.push(client);
    return client;
  }

  before(async () => {
    server = createSignalingServer({ maxPeersPerRoom: 3, heartbeatIntervalMs: 60_000 });
    const port = await server.listen(0);
    url = `ws://127.0.0.1:${port}`;
  });

  after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
  });

  it('serves health with peer and room counts', async () => {
    const response = await fetch(url.replace('ws://', 'http://') + '/health');
    const body = (await response.json()) as { status: string; peers: number; rooms: number };

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.peers, 'number');
    assert.equal(typeof body.rooms, 'number');
  });

  it('still supports the original register/signal flow between roomless peers', async () => {
    const a = await connect();
    const b = await connect();

    a.send({ type: 'register', id: 'legacy-a' });
    b.send({ type: 'register', id: 'legacy-b' });

    assert.equal((await a.next('registered')).id, 'legacy-a');
    assert.equal((await b.next('registered')).id, 'legacy-b');

    a.send({ type: 'signal', target: 'legacy-b', data: { sdp: 'offer' } });
    const relayed = await b.next('signal');

    assert.equal(relayed.from, 'legacy-a');
    assert.deepEqual(relayed.data, { sdp: 'offer' });

    await a.close();
    assert.equal((await b.next('peer-disconnected')).id, 'legacy-a');
    b.send({ type: 'leave' });
  });

  it('generates an id when the requested one is taken', async () => {
    const a = await connect();
    const b = await connect();

    a.send({ type: 'register', id: 'contested' });
    assert.equal((await a.next('registered')).id, 'contested');

    b.send({ type: 'register', id: 'contested' });
    const assigned = (await b.next('registered')).id;

    assert.notEqual(assigned, 'contested');
    assert.match(assigned, /^[0-9a-f-]{36}$/);

    await a.close();
    await b.close();
  });

  it('gives a joiner the existing roster and announces it to the room', async () => {
    const a = await connect();
    const b = await connect();

    a.send({ type: 'join', room: 'Teal-Otter', name: 'Ada' });
    const joinedA = await a.next('joined');

    assert.equal(joinedA.room, 'teal-otter', 'room codes are normalized to lowercase');
    assert.equal(joinedA.name, 'Ada');
    assert.deepEqual(joinedA.peers, [], 'the first joiner sees an empty roster');

    b.send({ type: 'join', room: 'teal-otter', name: '  Bob  ' });
    const joinedB = await b.next('joined');

    assert.deepEqual(joinedB.peers, [{ id: joinedA.id, name: 'Ada' }]);

    const announced = await a.next('peer-joined');
    assert.equal(announced.id, joinedB.id);
    assert.equal(announced.name, 'Bob');

    await a.close();
    await b.close();
  });

  it('scopes peer-left to the room and leaves other rooms untouched', async () => {
    const a = await connect();
    const b = await connect();
    const outsider = await connect();

    a.send({ type: 'join', room: 'room-one', name: 'Ada' });
    b.send({ type: 'join', room: 'room-one', name: 'Bob' });
    outsider.send({ type: 'join', room: 'room-two', name: 'Cy' });

    const joinedA = await a.next('joined');
    await b.next('joined');
    await outsider.next('joined');
    // Only the peer that was already in the room is told about the joiner.
    await a.next('peer-joined');
    assert.equal(await outsider.receivedNothing('peer-joined'), true);

    await a.close();

    assert.equal((await b.next('peer-left')).id, joinedA.id);
    assert.equal(await outsider.receivedNothing('peer-left'), true);

    await b.close();
    await outsider.close();
  });

  it('refuses to relay a signal to a peer in another room', async () => {
    const a = await connect();
    const outsider = await connect();

    a.send({ type: 'join', room: 'room-alpha', name: 'Ada' });
    outsider.send({ type: 'join', room: 'room-beta', name: 'Cy' });

    await a.next('joined');
    const joinedOutsider = await outsider.next('joined');

    a.send({ type: 'signal', target: joinedOutsider.id, data: { sdp: 'offer' } });

    assert.equal((await a.next('error')).code, 'target-not-in-room');
    assert.equal(await outsider.receivedNothing('signal'), true);

    await a.close();
    await outsider.close();
  });

  it('relays signals between peers in the same room', async () => {
    const a = await connect();
    const b = await connect();

    a.send({ type: 'join', room: 'room-relay', name: 'Ada' });
    b.send({ type: 'join', room: 'room-relay', name: 'Bob' });

    const joinedA = await a.next('joined');
    const joinedB = await b.next('joined');

    b.send({ type: 'signal', target: joinedA.id, data: { candidate: 'host' } });
    const relayed = await a.next('signal');

    assert.equal(relayed.from, joinedB.id);
    assert.deepEqual(relayed.data, { candidate: 'host' });

    await a.close();
    await b.close();
  });

  it('rejects unusable room codes', async () => {
    const client = await connect();

    for (const room of ['ab', 'has spaces', 'slash/es', '-leading']) {
      client.send({ type: 'join', room, name: 'Ada' });
      assert.equal((await client.next('error')).code, 'invalid-room', `expected ${room} to be rejected`);
    }

    await client.close();
  });

  it('turns away a joiner once the room is full', async () => {
    const members = [await connect(), await connect(), await connect()];
    for (const [index, member] of members.entries()) {
      member.send({ type: 'join', room: 'room-full-test', name: `Peer ${index}` });
      await member.next('joined');
    }

    const extra = await connect();
    extra.send({ type: 'join', room: 'room-full-test', name: 'Late' });

    assert.equal((await extra.next('error')).code, 'room-full');

    await Promise.all([...members, extra].map((client) => client.close()));
  });

  it('lets a peer re-join the room it already occupies even at capacity', async () => {
    const members = [await connect(), await connect(), await connect()];
    for (const [index, member] of members.entries()) {
      member.send({ type: 'join', room: 'room-rejoin', name: `Peer ${index}` });
      await member.next('joined');
    }

    const [first] = members;
    first.send({ type: 'join', room: 'room-rejoin', name: 'Renamed' });
    const rejoined = await first.next('joined');

    assert.equal(rejoined.room, 'room-rejoin');
    assert.equal(rejoined.name, 'Renamed');

    await Promise.all(members.map((client) => client.close()));
  });

  it('requires registration before signaling', async () => {
    const client = await connect();
    client.send({ type: 'signal', target: 'anyone', data: null });

    assert.equal((await client.next('error')).code, 'not-registered');

    await client.close();
  });

  it('reports unknown targets, bad payloads, and unknown message types', async () => {
    const client = await connect();
    client.send({ type: 'join', room: 'room-errors', name: 'Ada' });
    await client.next('joined');

    client.send({ type: 'signal', target: 'ghost-peer', data: null });
    assert.equal((await client.next('error')).code, 'target-not-found');

    client.send({ type: 'signal' } as unknown as ClientMessage);
    assert.equal((await client.next('error')).code, 'invalid-message');

    client.send({ type: 'nonsense' } as unknown as ClientMessage);
    assert.equal((await client.next('error')).code, 'invalid-message');

    await client.close();
  });

  it('rejects malformed JSON and non-object payloads', async () => {
    const client = await connect();

    client.sendRaw('not json');
    assert.equal((await client.next('error')).code, 'invalid-json');

    client.sendRaw('[1,2,3]');
    assert.equal((await client.next('error')).code, 'invalid-message');

    client.sendRaw('"a bare string"');
    assert.equal((await client.next('error')).code, 'invalid-message');

    await client.close();
  });

  it('drops the room entry when a peer leaves explicitly', async () => {
    const a = await connect();
    const b = await connect();

    a.send({ type: 'join', room: 'room-explicit-leave', name: 'Ada' });
    b.send({ type: 'join', room: 'room-explicit-leave', name: 'Bob' });

    const joinedA = await a.next('joined');
    await b.next('joined');
    await a.next('peer-joined');

    a.send({ type: 'leave' });
    assert.equal((await b.next('peer-left')).id, joinedA.id);

    // A left peer is no longer a signaling target for anyone.
    b.send({ type: 'signal', target: joinedA.id, data: null });
    assert.equal((await b.next('error')).code, 'target-not-found');

    await a.close();
    await b.close();
  });

  it('rate limits a client that floods the connection', async () => {
    const limited = createSignalingServer({
      messageLimit: 3,
      messageLimitWindowMs: 60_000,
      heartbeatIntervalMs: 60_000,
    });
    const port = await limited.listen(0);
    const client = await TestClient.connect(`ws://127.0.0.1:${port}`);

    try {
      for (let index = 0; index < 4; index += 1) {
        client.send({ type: 'register' });
      }

      assert.equal((await client.next('error')).code, 'rate-limited');
    } finally {
      await client.close();
      await limited.close();
    }
  });

  it('rejects a browser origin that is not on the allow list', async () => {
    const restricted = createSignalingServer({
      allowedOrigins: ['https://allowed.example'],
      heartbeatIntervalMs: 60_000,
    });
    const port = await restricted.listen(0);

    try {
      const blocked = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://blocked.example' });
      const error = await new Promise<Error>((resolve) => {
        blocked.once('error', resolve);
        blocked.once('open', () => resolve(new Error('unexpectedly connected')));
      });
      assert.match(error.message, /401|Unexpected server response/);

      const permitted = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://allowed.example' });
      await new Promise<void>((resolve, reject) => {
        permitted.once('open', resolve);
        permitted.once('error', reject);
      });
      permitted.close();
    } finally {
      await restricted.close();
    }
  });
});
