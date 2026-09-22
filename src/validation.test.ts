import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DISPLAY_NAME,
  MAX_DISPLAY_NAME_LENGTH,
  RateLimiter,
  isOriginAllowed,
  normalizeDisplayName,
  normalizeRoomCode,
  parseAllowedOrigins,
} from './validation.js';

/** Built via char codes so the literal (invisible) characters never appear in this source. */
function chars(...codes: number[]): string {
  return String.fromCharCode(...codes);
}

const NUL = 0x00;
const ESC = 0x1b;
const ZERO_WIDTH_SPACE = 0x200b;
const RIGHT_TO_LEFT_OVERRIDE = 0x202e;
const BYTE_ORDER_MARK = 0xfeff;

describe('normalizeRoomCode', () => {
  it('lowercases and trims usable codes', () => {
    assert.equal(normalizeRoomCode('  Teal-Otter-4821 '), 'teal-otter-4821');
    assert.equal(normalizeRoomCode('ABC'), 'abc');
  });

  it('rejects codes that are too short, too long, or contain unsafe characters', () => {
    assert.equal(normalizeRoomCode('ab'), null);
    assert.equal(normalizeRoomCode('a'.repeat(65)), null);
    assert.equal(normalizeRoomCode('room code'), null);
    assert.equal(normalizeRoomCode('room/code'), null);
    assert.equal(normalizeRoomCode('-leading-hyphen'), null);
    assert.equal(normalizeRoomCode(''), null);
  });

  it('accepts the longest allowed code', () => {
    const code = 'a'.repeat(64);
    assert.equal(normalizeRoomCode(code), code);
  });

  it('rejects non-string input', () => {
    assert.equal(normalizeRoomCode(undefined), null);
    assert.equal(normalizeRoomCode(42), null);
    assert.equal(normalizeRoomCode({ room: 'abc' }), null);
  });
});

describe('normalizeDisplayName', () => {
  it('collapses whitespace and trims', () => {
    assert.equal(normalizeDisplayName('  Ada   Lovelace  '), 'Ada Lovelace');
  });

  it('strips control, zero-width, and bidi characters that could spoof surrounding text', () => {
    assert.equal(normalizeDisplayName('Ada' + chars(NUL, ESC) + 'Lovelace'), 'Ada Lovelace');
    assert.equal(normalizeDisplayName('Ada' + chars(RIGHT_TO_LEFT_OVERRIDE) + 'Lovelace'), 'Ada Lovelace');
    assert.equal(normalizeDisplayName('Ada' + chars(ZERO_WIDTH_SPACE) + 'Lovelace'), 'Ada Lovelace');
    assert.equal(normalizeDisplayName(chars(BYTE_ORDER_MARK) + 'Ada'), 'Ada');
    assert.equal(normalizeDisplayName('multi\nline\tname'), 'multi line name');
  });

  it('falls back to a placeholder for empty or non-string names', () => {
    assert.equal(normalizeDisplayName(''), DEFAULT_DISPLAY_NAME);
    assert.equal(normalizeDisplayName('   '), DEFAULT_DISPLAY_NAME);
    assert.equal(normalizeDisplayName(undefined), DEFAULT_DISPLAY_NAME);
    assert.equal(normalizeDisplayName(123), DEFAULT_DISPLAY_NAME);
  });

  it('caps the length', () => {
    const name = normalizeDisplayName('x'.repeat(200));
    assert.equal(name.length, MAX_DISPLAY_NAME_LENGTH);
  });
});

describe('RateLimiter', () => {
  it('accepts up to the limit inside one window', () => {
    const limiter = new RateLimiter(3, 1000);
    assert.equal(limiter.accept(0), true);
    assert.equal(limiter.accept(10), true);
    assert.equal(limiter.accept(20), true);
    assert.equal(limiter.accept(30), false);
  });

  it('resets once the window elapses', () => {
    const limiter = new RateLimiter(2, 1000);
    assert.equal(limiter.accept(0), true);
    assert.equal(limiter.accept(1), true);
    assert.equal(limiter.accept(2), false);
    assert.equal(limiter.accept(1000), true);
  });
});

describe('origin allow list', () => {
  it('treats an unset list as allow-all', () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.equal(isOriginAllowed('https://example.com', []), true);
    assert.equal(isOriginAllowed(undefined, []), true);
  });

  it('parses a comma separated list and ignores trailing slashes', () => {
    const allowed = parseAllowedOrigins('https://a.example , https://b.example/');
    assert.deepEqual(allowed, ['https://a.example', 'https://b.example']);
    assert.equal(isOriginAllowed('https://b.example', allowed), true);
    assert.equal(isOriginAllowed('https://b.example/', allowed), true);
  });

  it('rejects unlisted and missing origins when a list is configured', () => {
    const allowed = parseAllowedOrigins('https://a.example');
    assert.equal(isOriginAllowed('https://evil.example', allowed), false);
    assert.equal(isOriginAllowed(undefined, allowed), false);
  });
});
