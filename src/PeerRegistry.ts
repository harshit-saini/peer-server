import type { WebSocket } from 'ws';

export class PeerRegistry {
  private readonly peers = new Map<string, WebSocket>();

  register(id: string, socket: WebSocket): void {
    this.peers.set(id, socket);
  }

  unregister(id: string): void {
    this.peers.delete(id);
  }

  get(id: string): WebSocket | undefined {
    return this.peers.get(id);
  }

  has(id: string): boolean {
    return this.peers.has(id);
  }

  all(): IterableIterator<WebSocket> {
    return this.peers.values();
  }

  get size(): number {
    return this.peers.size;
  }
}
