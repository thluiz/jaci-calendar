import { describe, expect, test } from "bun:test"
import { ApiError } from "../../src/service/errors"
import {
  parseConflictCheck,
  parseCreate,
  parseFreeSlots,
  parseSearch,
  parseUpdate,
  parseWindow,
} from "../../src/service/requests"

const DEFAULTS = { timezone: "Europe/Lisbon" }

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) return e.code
    throw e
  }
  throw new Error("expected a rejection")
}

const WINDOW = { time_min: "2026-10-05T00:00:00+01:00", time_max: "2026-10-06T00:00:00+01:00" }
const EVENT = { summary: "x", start: "2026-10-05T10:00:00+01:00", end: "2026-10-05T11:00:00+01:00" }

describe("parseWindow", () => {
  test("keeps the timestamps as sent", () => {
    expect(parseWindow(WINDOW)).toEqual({ timeMin: WINDOW.time_min, timeMax: WINDOW.time_max })
  })

  test("refuses an empty, inverted or over-long window", () => {
    expect(codeOf(() => parseWindow({ ...WINDOW, time_max: WINDOW.time_min }))).toBe("INVALID_INPUT")
    expect(codeOf(() => parseWindow({ ...WINDOW, time_max: "2028-01-01T00:00:00Z" }))).toBe("INVALID_INPUT")
  })
})

describe("parseSearch", () => {
  test("falls back to the default timezone and trims the query", () => {
    expect(parseSearch({ ...WINDOW, query: "  dentist " }, DEFAULTS)).toMatchObject({
      timezone: "Europe/Lisbon",
      query: "dentist",
    })
  })

  test("treats a blank query as none", () => {
    expect(parseSearch({ ...WINDOW, query: "  " }, DEFAULTS).query).toBeUndefined()
  })

  test("refuses an unknown timezone", () => {
    expect(codeOf(() => parseSearch({ ...WINDOW, timezone: "Mars/Olympus" }, DEFAULTS))).toBe("INVALID_INPUT")
  })
})

describe("parseConflictCheck", () => {
  test("carries both the text and the instant of each bound", () => {
    const req = parseConflictCheck({ start: EVENT.start, end: EVENT.end }, DEFAULTS)
    expect(req.start).toBe(EVENT.start)
    expect(req.endMs - req.startMs).toBe(60 * 60 * 1000)
    expect(req.partialOk).toBe(false)
  })

  test("refuses an end before the start", () => {
    expect(codeOf(() => parseConflictCheck({ start: EVENT.end, end: EVENT.start }, DEFAULTS))).toBe("INVALID_INPUT")
  })
})

describe("parseFreeSlots", () => {
  test("defaults to an hour and twenty results", () => {
    expect(parseFreeSlots(WINDOW, DEFAULTS)).toMatchObject({ durationMinutes: 60, maxResults: 20 })
  })

  test("keeps only valid weekdays", () => {
    expect(parseFreeSlots({ ...WINDOW, weekdays: [1, "2", 7, -1, 3.5] }, DEFAULTS).weekdays).toEqual([1, 2])
  })

  test("refuses a duration outside 1..1440", () => {
    expect(codeOf(() => parseFreeSlots({ ...WINDOW, duration_minutes: 0 }, DEFAULTS))).toBe("INVALID_INPUT")
    expect(codeOf(() => parseFreeSlots({ ...WINDOW, duration_minutes: 1441 }, DEFAULTS))).toBe("INVALID_INPUT")
  })
})

describe("write requests", () => {
  test("only a literal true turns a flag on", () => {
    const req = parseCreate(
      { ...EVENT, allow_past: "true", allow_conflict: 1, dry_run: true, partial_ok: "yes" },
      DEFAULTS
    )
    expect(req).toMatchObject({ allowPast: false, allowConflict: false, dryRun: true, partialOk: false })
  })

  test("a blank idempotency key is no key", () => {
    expect(parseCreate({ ...EVENT, idempotency_key: " " }, DEFAULTS).idempotencyKey).toBeUndefined()
    expect(parseCreate({ ...EVENT, idempotency_key: " k1 " }, DEFAULTS).idempotencyKey).toBe("k1")
  })

  test("create refuses attendees and an unknown timezone", () => {
    expect(codeOf(() => parseCreate({ ...EVENT, attendees: ["a@b.c"] }, DEFAULTS))).toBe("ATTENDEES_NOT_SUPPORTED")
    expect(codeOf(() => parseCreate({ ...EVENT, timezone: "Mars/Olympus" }, DEFAULTS))).toBe("INVALID_INPUT")
  })

  test("update does not require times", () => {
    const req = parseUpdate({ summary: "renamed" }, DEFAULTS)
    expect(req.event.summary).toBe("renamed")
    expect(Boolean(req.event.start && req.event.end)).toBe(false)
  })
})
