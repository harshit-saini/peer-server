export type ClientMessage =
  | { type: 'register'; id?: string }
  | { type: 'join'; room: string; id?: string; name?: string }
  | { type: 'signal'; target: string; data: unknown }
  | { type: 'leave' };

/** A room member as advertised to other members. */
export type RoomPeer = { id: string; name: string };

export type ServerErrorCode =
  | 'invalid-json'
  | 'invalid-message'
  | 'invalid-room'
  | 'not-registered'
  | 'room-full'
  | 'target-not-found'
  | 'target-not-in-room'
  | 'rate-limited';

export type ServerMessage =
  | { type: 'registered'; id: string }
  | { type: 'joined'; id: string; room: string; name: string; peers: RoomPeer[] }
  | { type: 'peer-joined'; id: string; name: string }
  | { type: 'peer-left'; id: string }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'peer-disconnected'; id: string }
  | { type: 'error'; message: string; code: ServerErrorCode };
