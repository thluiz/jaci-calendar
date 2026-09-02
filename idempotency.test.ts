import { describe, expect, test } from "bun:test"
import {
  base32hexEncode,
  eventIdFor,
  groupIdFor,
  isValidEventId,
  randomIdempotencyKey,
} from "./idempotency"

describe("base32hexEncode", () => {
  test("matches RFC 4648 base32hex vectors (without padding)", () => {
    const enc = (s: string) => base32hexEncode(new TextEncoder().encode(s))
    expect(enc("f")).toBe("co")
    expect(enc("fo")).toBe("cpng")
    expect(enc("foo")).toBe("cpnmu")
    expect(enc("foobar")).toBe("cpnmuoj1e8")
  })

  test("only emits alphabet characters", () => {
    const out = base32hexEncode(new Uint8Array([0, 255, 128, 7, 63, 200]))
    expect(out).toMatch(/^[a-v0-9]+$/)
  })
})

describe("eventIdFor", () => {
  test("is a valid Google event id", () => {
    const id = eventIdFor("k1", "thiago@gmail.com")
    expect(isValidEventId(id)).toBe(true)
    expect(id.length).toBe(32)
  })

  test("is deterministic", () => {
    expect(eventIdFor("k1", "a@b.com")).toBe(eventIdFor("k1", "a@b.com"))
  })

  test("differs per calendar for the same key", () => {
    // Google requires ids unique per calendar; reusing one id across calendars
    // would make the second copy fail with 409 against an unrelated event.
    expect(eventIdFor("k1", "a@b.com")).not.toBe(eventIdFor("k1", "c@d.com"))
  })

  test("differs per key on the same calendar", () => {
    expect(eventIdFor("k1", "a@b.com")).not.toBe(eventIdFor("k2", "a@b.com"))
  })

  test("separator prevents boundary collisions", () => {
    expect(eventIdFor("ab", "c")).not.toBe(eventIdFor("a", "bc"))
  })
})

describe("groupIdFor", () => {
  test("is stable for the same key and valid as an id", () => {
    const g = groupIdFor("k1")
    expect(g).toBe(groupIdFor("k1"))
    expect(isValidEventId(g)).toBe(true)
  })

  test("is not the event id of the same key", () => {
    expect(groupIdFor("k1")).not.toBe(eventIdFor("k1", "a@b.com"))
  })
})

describe("isValidEventId", () => {
  test("rejects uppercase, w-z and short ids", () => {
    expect(isValidEventId("ABCDE")).toBe(false)
    expect(isValidEventId("abcdz")).toBe(false)
    expect(isValidEventId("abcd")).toBe(false)
  })
})

test("randomIdempotencyKey is unique enough to not collide back to back", () => {
  expect(randomIdempotencyKey()).not.toBe(randomIdempotencyKey())
})
