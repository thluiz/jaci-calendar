import { describe, expect, test } from "bun:test"
import {
  busyFromEvents,
  busyFromFreeBusy,
  conflictsIn,
  eventSpan,
  findFreeSlots,
  isBlocking,
  mergeSpans,
  overlaps,
  subtractSpans,
  toSpan,
} from "./conflicts"
import type { BusyBlock, GoogleEvent } from "./types"

const TZ = "America/Sao_Paulo"

function span(start: string, end: string) {
  return { startMs: Date.parse(start), endMs: Date.parse(end) }
}

function timed(start: string, end: string, extra: Partial<GoogleEvent> = {}): GoogleEvent {
  return { id: "e1", summary: "Meeting", start: { dateTime: start }, end: { dateTime: end }, ...extra }
}

describe("overlaps", () => {
  const base = span("2026-08-30T14:00:00-03:00", "2026-08-30T15:00:00-03:00")

  test("partial overlap on either side", () => {
    expect(overlaps(base, span("2026-08-30T14:30:00-03:00", "2026-08-30T15:30:00-03:00"))).toBe(true)
    expect(overlaps(base, span("2026-08-30T13:30:00-03:00", "2026-08-30T14:30:00-03:00"))).toBe(true)
  })

  test("contained and containing", () => {
    expect(overlaps(base, span("2026-08-30T14:10:00-03:00", "2026-08-30T14:20:00-03:00"))).toBe(true)
    expect(overlaps(base, span("2026-08-30T10:00:00-03:00", "2026-08-30T20:00:00-03:00"))).toBe(true)
  })

  test("touching is not a conflict", () => {
    expect(overlaps(base, span("2026-08-30T15:00:00-03:00", "2026-08-30T16:00:00-03:00"))).toBe(false)
    expect(overlaps(base, span("2026-08-30T13:00:00-03:00", "2026-08-30T14:00:00-03:00"))).toBe(false)
  })

  test("compares instants, not wall clocks", () => {
    // Same instant written in two zones must still collide.
    expect(overlaps(base, span("2026-08-30T17:30:00+00:00", "2026-08-30T18:30:00+00:00"))).toBe(true)
  })
})

describe("eventSpan", () => {
  test("all-day end date is exclusive", () => {
    const s = eventSpan({ start: { date: "2026-08-30" }, end: { date: "2026-08-31" } }, TZ)!
    expect(s.endMs - s.startMs).toBe(24 * 60 * 60 * 1000)
  })

  test("returns null for a malformed event", () => {
    expect(eventSpan({ start: { dateTime: "nope" }, end: { dateTime: "nope" } }, TZ)).toBeNull()
    expect(eventSpan({ start: {} , end: {} }, TZ)).toBeNull()
  })
})

describe("isBlocking", () => {
  test("drops cancelled, transparent and declined", () => {
    expect(isBlocking(timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", { status: "cancelled" }))).toBe(false)
    expect(isBlocking(timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", { transparency: "transparent" }))).toBe(false)
    expect(
      isBlocking(
        timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", {
          attendees: [{ self: true, responseStatus: "declined" }],
        })
      )
    ).toBe(false)
  })

  test("drops the event types Google injects", () => {
    for (const eventType of ["workingLocation", "birthday", "fromGmail", "focusTime"]) {
      expect(isBlocking(timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", { eventType }))).toBe(false)
    }
  })

  test("keeps a plain accepted event", () => {
    expect(isBlocking(timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z"))).toBe(true)
    expect(
      isBlocking(
        timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", {
          attendees: [{ self: true, responseStatus: "accepted" }],
        })
      )
    ).toBe(true)
  })

  test("ignore_event_id keeps a move from colliding with itself", () => {
    const e = timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", { id: "abc" })
    expect(isBlocking(e, { ignoreEventId: "abc" })).toBe(false)
    expect(isBlocking(e, { ignoreEventId: "other" })).toBe(true)
  })

  test("ignore_group_id skips every copy of the same fan-out", () => {
    const e = timed("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z", {
      id: "copy-on-another-calendar",
      extendedProperties: { private: { group_id: "g1" } },
    })
    expect(isBlocking(e, { ignoreGroupId: "g1" })).toBe(false)
  })
})

describe("busyFromEvents", () => {
  test("keeps titles, marks all-day, sorts by start", () => {
    const blocks = busyFromEvents(
      [
        timed("2026-08-30T16:00:00-03:00", "2026-08-30T17:00:00-03:00", { id: "b", summary: "Later" }),
        { id: "a", summary: "All day", start: { date: "2026-08-30" }, end: { date: "2026-08-31" } },
        timed("2026-08-30T14:00:00-03:00", "2026-08-30T15:00:00-03:00", { id: "c", summary: "Earlier", transparency: "transparent" }),
      ],
      "thiago",
      TZ
    )
    expect(blocks.map((b) => b.event_id)).toEqual(["a", "b"])
    expect(blocks[0]!.all_day).toBe(true)
    expect(blocks[1]!.summary).toBe("Later")
    expect(blocks.every((b) => b.detail === "details")).toBe(true)
  })
})

describe("busyFromFreeBusy", () => {
  test("carries no title and is marked busy_only", () => {
    const blocks = busyFromFreeBusy(
      [{ start: "2026-08-30T17:00:00Z", end: "2026-08-30T18:00:00Z" }],
      "thilia",
      TZ
    )
    expect(blocks[0]!.detail).toBe("busy_only")
    expect(blocks[0]!.summary).toBeUndefined()
    expect(blocks[0]!.start).toBe("2026-08-30T14:00:00-03:00")
  })
})

describe("conflictsIn", () => {
  test("returns only the overlapping blocks", () => {
    const blocks: BusyBlock[] = [
      { calendar: "a", detail: "details", start: "2026-08-30T09:00:00-03:00", end: "2026-08-30T10:00:00-03:00" },
      { calendar: "a", detail: "details", start: "2026-08-30T14:00:00-03:00", end: "2026-08-30T15:00:00-03:00" },
    ]
    const hits = conflictsIn(blocks, span("2026-08-30T14:30:00-03:00", "2026-08-30T16:00:00-03:00"))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.start).toBe("2026-08-30T14:00:00-03:00")
  })
})

describe("mergeSpans / subtractSpans", () => {
  test("merges touching and overlapping, drops empty", () => {
    const merged = mergeSpans([
      span("2026-08-30T09:00:00Z", "2026-08-30T10:00:00Z"),
      span("2026-08-30T10:00:00Z", "2026-08-30T11:00:00Z"),
      span("2026-08-30T12:00:00Z", "2026-08-30T12:00:00Z"),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.endMs).toBe(Date.parse("2026-08-30T11:00:00Z"))
  })

  test("subtract leaves the gaps around busy time", () => {
    const free = subtractSpans(span("2026-08-30T09:00:00Z", "2026-08-30T18:00:00Z"), [
      span("2026-08-30T10:00:00Z", "2026-08-30T11:00:00Z"),
      span("2026-08-30T14:00:00Z", "2026-08-30T15:00:00Z"),
    ])
    expect(free).toHaveLength(3)
    expect(free[0]!.endMs).toBe(Date.parse("2026-08-30T10:00:00Z"))
    expect(free[2]!.startMs).toBe(Date.parse("2026-08-30T15:00:00Z"))
  })

  test("a busy block covering the window leaves nothing", () => {
    const free = subtractSpans(span("2026-08-30T09:00:00Z", "2026-08-30T18:00:00Z"), [
      span("2026-08-30T08:00:00Z", "2026-08-30T19:00:00Z"),
    ])
    expect(free).toHaveLength(0)
  })
})

describe("findFreeSlots", () => {
  const busy = (start: string, end: string): BusyBlock => ({
    calendar: "thiago",
    detail: "details",
    start,
    end,
  })

  test("splits a working day around a meeting", () => {
    // 2026-09-03 is a Thursday.
    const slots = findFreeSlots([busy("2026-09-03T14:00:00-03:00", "2026-09-03T15:00:00-03:00")], {
      windowStart: "2026-09-03T00:00:00-03:00",
      windowEnd: "2026-09-04T00:00:00-03:00",
      durationMinutes: 60,
      timezone: TZ,
    })
    expect(slots).toHaveLength(2)
    expect(slots[0]!.start).toBe("2026-09-03T09:00:00-03:00")
    expect(slots[0]!.end).toBe("2026-09-03T14:00:00-03:00")
    expect(slots[1]!.start).toBe("2026-09-03T15:00:00-03:00")
    expect(slots[1]!.duration_minutes).toBe(180)
  })

  test("drops gaps shorter than the requested duration", () => {
    const slots = findFreeSlots(
      [
        busy("2026-09-03T09:00:00-03:00", "2026-09-03T13:30:00-03:00"),
        busy("2026-09-03T14:00:00-03:00", "2026-09-03T18:00:00-03:00"),
      ],
      {
        windowStart: "2026-09-03T00:00:00-03:00",
        windowEnd: "2026-09-04T00:00:00-03:00",
        durationMinutes: 60,
        timezone: TZ,
      }
    )
    expect(slots).toHaveLength(0)
  })

  test("skips weekends by default and honours an explicit weekday list", () => {
    // 2026-09-05 is a Saturday, 2026-09-06 a Sunday.
    const weekend = {
      windowStart: "2026-09-05T00:00:00-03:00",
      windowEnd: "2026-09-07T00:00:00-03:00",
      durationMinutes: 60,
      timezone: TZ,
    }
    expect(findFreeSlots([], weekend)).toHaveLength(0)
    expect(findFreeSlots([], { ...weekend, weekdays: [0, 6] })).toHaveLength(2)
  })

  test("honours business hours", () => {
    const slots = findFreeSlots([], {
      windowStart: "2026-09-03T00:00:00-03:00",
      windowEnd: "2026-09-04T00:00:00-03:00",
      durationMinutes: 30,
      timezone: TZ,
      businessStart: "08:00",
      businessEnd: "10:00",
    })
    expect(slots).toEqual([
      { start: "2026-09-03T08:00:00-03:00", end: "2026-09-03T10:00:00-03:00", duration_minutes: 120 },
    ])
  })

  test("never proposes a slot in the past", () => {
    const slots = findFreeSlots([], {
      windowStart: "2026-09-03T00:00:00-03:00",
      windowEnd: "2026-09-04T00:00:00-03:00",
      durationMinutes: 30,
      timezone: TZ,
      now: Date.parse("2026-09-03T16:00:00-03:00"),
    })
    expect(slots).toEqual([
      { start: "2026-09-03T16:00:00-03:00", end: "2026-09-03T18:00:00-03:00", duration_minutes: 120 },
    ])
  })

  test("an all-day busy block swallows the whole day", () => {
    const slots = findFreeSlots(
      [busy("2026-09-03T00:00:00-03:00", "2026-09-04T00:00:00-03:00")],
      {
        windowStart: "2026-09-03T00:00:00-03:00",
        windowEnd: "2026-09-05T00:00:00-03:00",
        durationMinutes: 60,
        timezone: TZ,
      }
    )
    expect(slots.map((s) => s.start)).toEqual(["2026-09-04T09:00:00-03:00"])
  })

  test("crosses a DST boundary in a zone that has one, without drifting", () => {
    // Europe/Lisbon falls back on 2026-10-25. The working window must stay
    // 09:00-18:00 wall clock on both sides of the transition.
    const slots = findFreeSlots([], {
      windowStart: "2026-10-23T00:00:00+01:00",
      windowEnd: "2026-10-27T00:00:00+00:00",
      durationMinutes: 60,
      timezone: "Europe/Lisbon",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    })
    expect(slots.map((s) => s.start)).toEqual([
      "2026-10-23T09:00:00+01:00",
      "2026-10-24T09:00:00+01:00",
      // A zero offset is written "Z", the canonical RFC3339 form Google itself
      // returns. Lisbon is on it after the fall-back.
      "2026-10-25T09:00:00Z",
      "2026-10-26T09:00:00Z",
    ])
  })

  test("returns nothing for an inverted window", () => {
    expect(
      findFreeSlots([], {
        windowStart: "2026-09-04T00:00:00-03:00",
        windowEnd: "2026-09-03T00:00:00-03:00",
        durationMinutes: 60,
        timezone: TZ,
      })
    ).toHaveLength(0)
  })
})

describe("toSpan", () => {
  test("round-trips an RFC3339 block", () => {
    const s = toSpan({ start: "2026-08-30T14:00:00-03:00", end: "2026-08-30T15:00:00-03:00" })
    expect(s.endMs - s.startMs).toBe(3600_000)
  })
})
