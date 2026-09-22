/** Room codes are case-insensitive; they are normalized to lowercase before use as a map key. */
const ROOM_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const MAX_DISPLAY_NAME_LENGTH = 48;
export const DEFAULT_DISPLAY_NAME = 'Guest';

/**
 * Peer ids are echoed to every other member of a room and used as map keys, so they are restricted
 * to characters that survive a trip through a URL, a JSON round-trip, and a client-side Map.
 */
const PEER_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Returns a usable peer id, or null meaning "assign a fresh UUID instead".
 *
 * Without this a client can register under a number or an object: the value lands in the registry
 * key and in every peer's roster, but those peers stringify ids (URL params, React keys, Map
 * lookups) and can then never signal it - a participant visible to everyone and reachable by
 * no one. Treating a malformed id as absent keeps the documented "generated UUID if
 * omitted/taken" behaviour.
 */
export function normalizePeerId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return PEER_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Room capacity, clamped into a range that makes sense for a full mesh. Without clamping, a typo
 * in the env var silently means either the default or (for a negative value) a server that
 * rejects every join.
 */
export function normalizeRoomCapacity(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.max(2, Math.min(32, Math.floor(parsed)));
}

/**
 * Returns the canonical form of a room code, or null if it is not a usable code. Rejecting
 * anything outside `[a-z0-9-]{3,64}` keeps codes safe to use as map keys, log values, and URL
 * query parameters.
 */
export function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Control characters (Cc), format characters (Cf - zero-width spaces, bidi overrides, BOM), and
 * line/paragraph separators (Zl/Zp). Each of these can hide or visually reorder the text around
 * it, which is why a name coming from another peer is scrubbed of them before any UI renders it.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Display names come from another peer and are rendered in every participant's UI, so they are
 * scrubbed of the characters above, collapsed to single spaces, and length-capped. Empty results
 * fall back to a placeholder instead of being rejected.
 */
export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_DISPLAY_NAME;
  }

  const stripped = value.replace(UNSAFE_NAME_CHARS, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();

  if (collapsed.length === 0) {
    return DEFAULT_DISPLAY_NAME;
  }

  return collapsed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/**
 * Fixed-window message counter, one per connection. A window that only advances when a message
 * arrives keeps this allocation-free and good enough to stop a runaway client loop, which is all
 * a small signaling server needs.
 */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a message and returns false once the caller has exceeded `limit` in `windowMs`. */
  accept(now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }

    this.count += 1;
    return this.count <= this.limit;
  }
}

/**
 * Parses the `ALLOWED_ORIGINS` env var (comma-separated). An empty/unset value means "allow any
 * origin", which is the right default for a signaling server run locally during development.
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0);
}

export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return true;
  }

  if (!origin) {
    // Non-browser clients (tests, CLI tools) send no Origin header; browsers always do.
    return false;
  }

  return allowed.includes(origin.replace(/\/+$/, ''));
}
