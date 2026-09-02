import { describe, expect, test } from "bun:test"
import {
  checkDateGuard,
  checkWritableAccess,
  DAY_MS,
  HOUR_MS,
  isViolation,
  parseInstant,
  validateEventInput,
  WriteLimiter,
} from "./policy"

const DEFAULTS = { timezone: "America/Sao_Paulo" }
const NOW = Date.parse("2026-08-30T12:00:00-03:00")

describe("validateEventInput", () => {
  const good = {
    summary: "Meeting",
    start: "2026-08-30T14:00:00-03:00",
    end: "2026-08-30T15:00:00-03:00",
  }

  test("accepts a well-formed timed event", () => {
    const out = validateEventInput(good, DEFAULTS)
    expect(isViolation(out)).toBe(false)
    if (isViolation(out)) return
    expect(out.all_day).toBe(false)
    expect(out.timezone).toBe("America/Sao_Paulo")
  })

  test("rejects attendees, and says what to do instead", () => {
    const out = validateEventInput({ ...good, attendees: ["thilia@example.com"] }, DEFAULTS)
    expect(isViolation(out)).toBe(true)
    if (!isViolation(out)) return
    expect(out.code).toBe("ATTENDEES_NOT_SUPPORTED")
    expect(out.status).toBe(400)
    expect(out.message).toContain("calendar_ids")
  })

  test("rejects the guests spelling too", () => {
    expect(isViolation(validateEventInput({ ...good, guests: [] }, DEFAULTS))).toBe(true)
  })

  test("requires an explicit offset", () => {
    const out = validateEventInput({ ...good, start: "2026-08-30T14:00:00" }, DEFAULTS)
    expect(isViolation(out)).toBe(true)
    if (!isViolation(out)) return
    expect(out.message).toContain("explicit offset")
  })

  test("accepts an all-day event when both ends are plain dates", () => {
    const out = validateEventInput({ summary: "Trip", start: "2026-08-30", end: "2026-09-02" }, DEFAULTS)
    expect(isViolation(out)).toBe(false)
    if (isViolation(out)) return
    expect(out.all_day).toBe(true)
  })

  test("rejects mixing a plain date with a timestamp", () => {
    const out = validateEventInput(
      { summary: "Trip", start: "2026-08-30", end: "2026-08-30T15:00:00-03:00" },
      DEFAULTS
    )
    expect(isViolation(out)).toBe(true)
  })

  test("rejects an end at or before the start", () => {
    expect(isViolation(validateEventInput({ ...good, end: good.start }, DEFAULTS))).toBe(true)
    expect(
      isViolation(validateEventInput({ ...good, end: "2026-08-30T13:00:00-03:00" }, DEFAULTS))
    ).toBe(true)
  })

  test("rejects a missing summary and an absurdly long one", () => {
    expect(isViolation(validateEventInput({ ...good, summary: "  " }, DEFAULTS))).toBe(true)
    expect(isViolation(validateEventInput({ ...good, summary: "x".repeat(1025) }, DEFAULTS))).toBe(true)
  })

  test("rejects an event longer than 30 days", () => {
    const out = validateEventInput(
      { summary: "Sabbatical", start: "2026-01-01", end: "2026-03-01" },
      DEFAULTS
    )
    expect(isViolation(out)).toBe(true)
  })

  test("a patch may carry no times at all", () => {
    const out = validateEventInput({ summary: "New title" }, DEFAULTS, { requireTimes: false })
    expect(isViolation(out)).toBe(false)
    if (isViolation(out)) return
    expect(out.start).toBe("")
  })

  test("a patch carrying attendees is still rejected", () => {
    expect(
      isViolation(validateEventInput({ attendees: [] }, DEFAULTS, { requireTimes: false }))
    ).toBe(true)
  })
})

describe("checkDateGuard", () => {
  const opts = { maxPastHours: 24, maxFutureDays: 730, now: NOW }

  test("allows the near past and the near future", () => {
    expect(checkDateGuard("2026-08-30T09:00:00-03:00", opts)).toBeNull()
    expect(checkDateGuard("2026-08-29T13:00:00-03:00", opts)).toBeNull()
    expect(checkDateGuard("2027-01-01T09:00:00-03:00", opts)).toBeNull()
  })

  test("rejects deep past unless allow_past", () => {
    const start = new Date(NOW - 5 * DAY_MS).toISOString().replace("Z", "+00:00")
    const denied = checkDateGuard(start, opts)
    expect(denied?.code).toBe("START_IN_PAST")
    expect(denied?.message).toContain("allow_past")
    expect(checkDateGuard(start, { ...opts, allowPast: true })).toBeNull()
  })

  test("rejects the year typo", () => {
    // 2062 instead of 2026 — the classic transposition.
    expect(checkDateGuard("2062-08-30T14:00:00-03:00", opts)?.code).toBe("START_TOO_FAR")
  })

  test("allow_past does not lift the future cap", () => {
    expect(checkDateGuard("2062-08-30T14:00:00-03:00", { ...opts, allowPast: true })?.code).toBe(
      "START_TOO_FAR"
    )
  })

  test("the boundary itself is allowed", () => {
    const edge = new Date(NOW - 24 * HOUR_MS + 1000).toISOString()
    expect(checkDateGuard(edge, opts)).toBeNull()
  })

  test("an unparseable start is an input error, not a guard error", () => {
    expect(checkDateGuard("tomorrow", opts)?.code).toBe("INVALID_INPUT")
  })
})

describe("WriteLimiter", () => {
  test("counts a fan-out as N writes, not one", () => {
    const limiter = new WriteLimiter(10, 50)
    expect(limiter.consume(3, NOW).allowed).toBe(true)
    expect(limiter.snapshot(NOW).used_last_minute).toBe(3)
  })

  test("denies the whole batch rather than half of it", () => {
    const limiter = new WriteLimiter(5, 50)
    limiter.consume(4, NOW)
    const decision = limiter.consume(3, NOW)
    expect(decision.allowed).toBe(false)
    expect(decision.violation?.status).toBe(429)
    // Nothing was reserved, so a smaller batch still fits.
    expect(limiter.consume(1, NOW).allowed).toBe(true)
  })

  test("the minute window slides", () => {
    const limiter = new WriteLimiter(2, 50)
    expect(limiter.consume(2, NOW).allowed).toBe(true)
    expect(limiter.consume(1, NOW + 30_000).allowed).toBe(false)
    expect(limiter.consume(1, NOW + 61_000).allowed).toBe(true)
  })

  test("the daily cap holds even when the minute window is empty", () => {
    const limiter = new WriteLimiter(10, 5)
    limiter.consume(5, NOW)
    const decision = limiter.consume(1, NOW + 10 * HOUR_MS)
    expect(decision.allowed).toBe(false)
    expect(decision.violation?.code).toBe("DAILY_LIMIT")
    expect(limiter.consume(1, NOW + 25 * HOUR_MS).allowed).toBe(true)
  })

  test("alerts once per breach, not on every denied call", () => {
    const limiter = new WriteLimiter(1, 50)
    limiter.consume(1, NOW)
    expect(limiter.consume(1, NOW).firstBreach).toBe(true)
    expect(limiter.consume(1, NOW).firstBreach).toBe(false)
    // A successful write re-arms the alert for the next breach.
    limiter.consume(1, NOW + 61_000)
    expect(limiter.consume(1, NOW + 61_000).firstBreach).toBe(true)
  })

  test("refund gives back writes that never happened", () => {
    const limiter = new WriteLimiter(3, 50)
    limiter.consume(3, NOW)
    limiter.refund(3)
    expect(limiter.snapshot(NOW).used_today).toBe(0)
    expect(limiter.consume(3, NOW).allowed).toBe(true)
  })
})

describe("checkWritableAccess", () => {
  test("a busy_only calendar cannot be written to", () => {
    const denied = checkWritableAccess("thilia", "busy_only")
    expect(denied?.status).toBe(403)
    expect(denied?.message).toContain("availability only")
    expect(checkWritableAccess("thiago", "details")).toBeNull()
  })
})

describe("parseInstant", () => {
  test("accepts Z, an offset, and a plain date", () => {
    expect(isViolation(parseInstant("2026-08-30T14:00:00Z", "start"))).toBe(false)
    expect(isViolation(parseInstant("2026-08-30T14:00-03:00", "start"))).toBe(false)
    expect(isViolation(parseInstant("2026-08-30", "start"))).toBe(false)
  })

  test("rejects empty and non-string input", () => {
    expect(isViolation(parseInstant("", "start"))).toBe(true)
    expect(isViolation(parseInstant(undefined, "start"))).toBe(true)
    expect(isViolation(parseInstant(1756567200000, "start"))).toBe(true)
  })
})
