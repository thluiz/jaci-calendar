/**
 * idempotency.ts — deterministic event ids.
 *
 * Google lets the client choose the event id, and rejects a second insert with
 * the same id (409). That is the whole retry story: the same idempotency_key on
 * the same calendar always maps to the same id, so an agent that retries after
 * a timeout gets `created: false` instead of a duplicate event.
 *
 * Id rules from the Calendar API: base32hex alphabet (a-v and 0-9), length 5 to
 * 1024. Pure module — no clock, no network, no state.
 */

import { createHash } from "crypto"

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv"

/** Length in characters of a generated id. 32 chars = 160 bits of the digest. */
const ID_LENGTH = 32

/** Separator that cannot appear in a key or a calendar id. */
const SEP = "\u0000"

export function base32hexEncode(bytes: Uint8Array): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32HEX[(buffer >> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32HEX[(buffer << (5 - bits)) & 31]
  return out
}

function digest(...parts: string[]): Uint8Array {
  const h = createHash("sha256")
  // Joined on NUL so ("ab", "c") and ("a", "bc") cannot collide.
  h.update(parts.join(SEP))
  return new Uint8Array(h.digest())
}

/**
 * Event id for one copy of a fan-out. The calendar id is part of the input, so
 * the same key on two calendars yields two distinct ids — Google requires ids
 * to be unique per calendar, and sharing one id across calendars breaks the
 * copy that is created second.
 */
export function eventIdFor(idempotencyKey: string, calendarId: string): string {
  return base32hexEncode(digest("event", idempotencyKey, calendarId)).slice(0, ID_LENGTH)
}

/**
 * The group id tying the copies of one logical event together. Derived from the
 * idempotency key alone, so a retry lands on the same group.
 */
export function groupIdFor(idempotencyKey: string): string {
  return base32hexEncode(digest("group", idempotencyKey)).slice(0, ID_LENGTH)
}

const VALID_ID = /^[a-v0-9]{5,1024}$/

export function isValidEventId(id: string): boolean {
  return VALID_ID.test(id)
}

/** Fallback key for callers that did not send one. Not deterministic by design. */
export function randomIdempotencyKey(): string {
  return `auto-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
