export type ClientMessage =
  | { type: 'register'; id?: string }
  | { type: 'signal'; target: string; data: unknown }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'registered'; id: string }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'peer-disconnected'; id: string }
  | { type: 'error'; message: string };
