import type { WebSocket } from 'ws';
import type { RoomPeer } from './types.js';

export interface PeerRecord<TSocket> {
  readonly id: string;
  readonly socket: TSocket;
  name: string;
  room: string | null;
}

/**
 * Tracks connected peers by id, plus a secondary index of room membership so that room rosters
 * and room-scoped broadcasts are O(room size) rather than O(all peers).
 *
 * Generic over the socket type so the room bookkeeping can be unit tested without a real
 * WebSocket; production code uses the `ws` WebSocket.
 */
export class PeerRegistry<TSocket = WebSocket> {
  private readonly peers = new Map<string, PeerRecord<TSocket>>();
  private readonly rooms = new Map<string, Set<string>>();

  /**
   * Adds (or replaces) the peer stored under `id`. Replacing an id drops the previous record from
   * its room index first, so a re-registration can never leave a stale room member behind.
   */
  register(id: string, socket: TSocket, options: { name?: string; room?: string | null } = {}): PeerRecord<TSocket> {
    this.unregister(id);

    const record: PeerRecord<TSocket> = {
      id,
      socket,
      name: options.name ?? '',
      room: options.room ?? null,
    };

    this.peers.set(id, record);
    if (record.room) {
      this.addToRoom(record.room, id);
    }

    return record;
  }

  /** Moves an already-registered peer into `room`, leaving any previous room. */
  joinRoom(id: string, room: string, name: string): PeerRecord<TSocket> | undefined {
    const record = this.peers.get(id);
    if (!record) {
      return undefined;
    }

    if (record.room && record.room !== room) {
      this.removeFromRoom(record.room, id);
    }

    record.room = room;
    record.name = name;
    this.addToRoom(room, id);

    return record;
  }

  unregister(id: string): PeerRecord<TSocket> | undefined {
    const record = this.peers.get(id);
    if (!record) {
      return undefined;
    }

    this.peers.delete(id);
    if (record.room) {
      this.removeFromRoom(record.room, id);
    }

    return record;
  }

  get(id: string): PeerRecord<TSocket> | undefined {
    return this.peers.get(id);
  }

  has(id: string): boolean {
    return this.peers.has(id);
  }

  all(): IterableIterator<PeerRecord<TSocket>> {
    return this.peers.values();
  }

  /** Members of `room`, in join order. */
  membersOf(room: string): PeerRecord<TSocket>[] {
    const ids = this.rooms.get(room);
    if (!ids) {
      return [];
    }

    const members: PeerRecord<TSocket>[] = [];
    for (const id of ids) {
      const record = this.peers.get(id);
      if (record) {
        members.push(record);
      }
    }

    return members;
  }

  /** `membersOf` reduced to the fields other peers are allowed to see. */
  rosterOf(room: string, exclude?: string): RoomPeer[] {
    return this.membersOf(room)
      .filter((record) => record.id !== exclude)
      .map((record) => ({ id: record.id, name: record.name }));
  }

  sizeOfRoom(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  /** Peers that registered without joining a room - i.e. clients of the original flat protocol. */
  roomless(): PeerRecord<TSocket>[] {
    return [...this.peers.values()].filter((record) => record.room === null);
  }

  get size(): number {
    return this.peers.size;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  private addToRoom(room: string, id: string): void {
    const members = this.rooms.get(room);
    if (members) {
      members.add(id);
      return;
    }

    this.rooms.set(room, new Set([id]));
  }

  private removeFromRoom(room: string, id: string): void {
    const members = this.rooms.get(room);
    if (!members) {
      return;
    }

    members.delete(id);
    if (members.size === 0) {
      this.rooms.delete(room);
    }
  }
}
