import { describe, expect, test } from "bun:test"
import { WriteLimiter } from "../../src/core/policy"
import { CalendarApiError } from "../../src/google/calendar"
import type { AuditLog, LogEntry } from "../../src/logger"
import type { Registry } from "../../src/principals"
import { createCalendarService, type CalendarPort } from "../../src/service/calendar-service"
import { ApiError } from "../../src/service/errors"
import type { CalendarEntry, GoogleEvent, Principal } from "../../src/types"

// A fixed clock, so the date guard and the write caps are deterministic.
const NOW = Date.parse("2026-10-01T09:00:00Z")

const CALENDARS: CalendarEntry[] = [
  { alias: "ana", id: "ana@example.com", access: "details" },
  { alias: "bruno", id: "bruno@example.com", access: "details" },
  { alias: "carla", id: "carla@example.com", access: "busy_only" },
]

const WRITER: Principal = { name: "writer", role: "write", calendars: ["ana", "bruno", "carla"] }
const READER: Principal = { name: "reader", role: "read", calendars: ["ana"] }

function registry(): Registry {
  return {
    calendars: new Map(CALENDARS.map((c) => [c.alias, c])),
    principals: new Map([WRITER, READER].map((p) => [p.name, p])),
    byKeyHash: new Map(),
    errors: [],
  }
}

/**
 * Google in memory: events per calendar id, with the one behavior the service
 * leans on — a second insert with the same id answers 409.
 */
class FakeGoogle implements CalendarPort {
  events = new Map<string, GoogleEvent[]>()
  inserts: Array<{ calendarId: string; eventId: string }> = []
  patches: Array<{ calendarId: string; eventId: string; patch: GoogleEvent }> = []
  /** Calendar ids whose writes fail, to simulate a share revoked mid-fan-out. */
  failingWrites = new Set<string>()

  seed(calendarId: string, event: GoogleEvent) {
    this.events.set(calendarId, [...(this.events.get(calendarId) ?? []), event])
  }

  async listEvents(calendarId: string, opts: { timeMin: string; timeMax: string }) {
    const min = Date.parse(opts.timeMin)
    const max = Date.parse(opts.timeMax)
    return (this.events.get(calendarId) ?? []).filter((e) => {
      const s = Date.parse(e.start?.dateTime ?? e.start?.date ?? "")
      const t = Date.parse(e.end?.dateTime ?? e.end?.date ?? "")
      return s < max && t > min
    })
  }

  async freeBusy(opts: { calendarIds: string[] }) {
    return Object.fromEntries(opts.calendarIds.map((id) => [id, { busy: [] }]))
  }

  async insertEvent(calendarId: string, eventId: string, event: GoogleEvent) {
    if (this.failingWrites.has(calendarId)) throw new CalendarApiError(403, "forbidden", calendarId)
    if ((this.events.get(calendarId) ?? []).some((e) => e.id === eventId)) {
      throw new CalendarApiError(409, "duplicate", calendarId)
    }
    this.inserts.push({ calendarId, eventId })
    const stored = { ...event, id: eventId }
    this.seed(calendarId, stored)
    return stored
  }

  async patchEvent(calendarId: string, eventId: string, patch: GoogleEvent) {
    this.patches.push({ calendarId, eventId, patch })
    const list = this.events.get(calendarId) ?? []
    const i = list.findIndex((e) => e.id === eventId)
    list[i] = { ...list[i], ...patch }
    return list[i]!
  }

  async findByGroupId(calendarId: string, groupId: string) {
    return (this.events.get(calendarId) ?? []).filter(
      (e) => e.extendedProperties?.private?.group_id === groupId
    )
  }
}

function setup(opts: { maxPerMin?: number } = {}) {
  const google = new FakeGoogle()
  const entries: LogEntry[] = []
  const notices: string[] = []
  const audit: AuditLog = { append: async (e) => void entries.push(e) }
  const limiter = new WriteLimiter(opts.maxPerMin ?? 10, 50)
  const service = createCalendarService({
    config: { defaultTimezone: "Europe/Lisbon", maxPastHours: 24, maxFutureDays: 730 },
    calendar: google,
    registry,
    limiter,
    audit,
    alerts: { notify: async (m) => void notices.push(m) },
    now: () => NOW,
  })
  return { service, google, entries, notices, limiter }
}

const MEETING = {
  summary: "Planning",
  start: "2026-10-05T10:00:00+01:00",
  end: "2026-10-05T11:00:00+01:00",
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error("expected the call to be rejected")
}

describe("create_event", () => {
  test("fans out one copy per calendar, linked by one group_id", async () => {
    const { service, google } = setup()
    const result = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    expect(result.ok).toBe(true)
    expect(google.inserts.map((i) => i.calendarId)).toEqual(["ana@example.com", "bruno@example.com"])
    const groups = [...google.events.values()].flat().map((e) => e.extendedProperties?.private?.group_id)
    expect(new Set(groups)).toEqual(new Set([result.group_id]))
  })

  test("a denied calendar aborts before any copy is written", async () => {
    const { service, google, entries } = setup()
    const err = await rejection(service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "stranger"] }))

    expect(err.code).toBe("CALENDAR_DENIED")
    expect(google.inserts).toEqual([])
    expect(entries.at(-1)).toMatchObject({ outcome: "denied", reason: "CALENDAR_DENIED", status: 403 })
  })

  test("a busy_only calendar is never written to, and nothing else is either", async () => {
    const { service, google } = setup()
    const err = await rejection(service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "carla"] }))

    expect(err.status).toBe(403)
    expect(google.inserts).toEqual([])
  })

  test("a read principal cannot create", async () => {
    const { service, google } = setup()
    const err = await rejection(service.createEvent(READER, { ...MEETING, calendar_ids: ["ana"] }))

    expect(err.code).toBe("READ_ONLY_PRINCIPAL")
    expect(google.inserts).toEqual([])
  })

  test("a retry with the same idempotency_key answers created: false instead of duplicating", async () => {
    const { service, google } = setup()
    const body = { ...MEETING, calendar_ids: ["ana"], idempotency_key: "k-1" }

    const first = (await service.createEvent(WRITER, body)) as any
    const second = (await service.createEvent(WRITER, body)) as any

    expect(first.results[0].created).toBe(true)
    expect(second.results[0].created).toBe(false)
    expect(second.group_id).toBe(first.group_id)
    expect(google.events.get("ana@example.com")).toHaveLength(1)
  })

  test("an overlap is refused with 409 and audited once, with the group", async () => {
    const { service, google, entries } = setup()
    google.seed("ana@example.com", {
      id: "existing",
      summary: "Dentist",
      start: { dateTime: "2026-10-05T10:30:00+01:00" },
      end: { dateTime: "2026-10-05T11:30:00+01:00" },
    })

    const err = await rejection(service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"] }))

    expect(err.status).toBe(409)
    expect(google.inserts).toEqual([])
    const denials = entries.filter((e) => e.reason === "CONFLICT")
    expect(denials).toHaveLength(1)
    expect(denials[0]!.group_id).toBeString()
  })

  test("allow_conflict schedules over the overlap and reports it", async () => {
    const { service, google } = setup()
    google.seed("ana@example.com", {
      id: "existing",
      summary: "Dentist",
      start: { dateTime: "2026-10-05T10:30:00+01:00" },
      end: { dateTime: "2026-10-05T11:30:00+01:00" },
    })

    const result = (await service.createEvent(WRITER, {
      ...MEETING,
      calendar_ids: ["ana"],
      allow_conflict: true,
    })) as any

    expect(result.ok).toBe(true)
    expect(google.inserts).toHaveLength(1)
  })

  test("a partial failure answers 207 and refunds the write that did not happen", async () => {
    const { service, google, limiter } = setup({ maxPerMin: 2 })
    google.failingWrites.add("bruno@example.com")

    const result = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any
    expect(result.status).toBe(207)
    expect(result.ok).toBe(false)

    // One write was spent and one refunded, so exactly one more fits the cap.
    expect(limiter.consume(1, NOW).allowed).toBe(true)
    expect(limiter.consume(1, NOW).allowed).toBe(false)
  })

  test("the write cap counts every copy and alerts once per breach", async () => {
    const { service, google, notices } = setup({ maxPerMin: 1 })

    const err = await rejection(service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] }))
    await rejection(service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] }))

    expect(err.status).toBe(429)
    expect(google.inserts).toEqual([])
    expect(notices).toHaveLength(1)
  })

  test("dry_run writes nothing and spends nothing", async () => {
    const { service, google, limiter } = setup({ maxPerMin: 1 })

    const result = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"], dry_run: true })) as any

    expect(result.dry_run).toBe(true)
    expect(google.inserts).toEqual([])
    expect(limiter.consume(1, NOW).allowed).toBe(true)
  })

  test("a start in the far past is refused by the date guard", async () => {
    const { service, google } = setup()
    const err = await rejection(
      service.createEvent(WRITER, {
        ...MEETING,
        start: "2025-10-05T10:00:00+01:00",
        end: "2025-10-05T11:00:00+01:00",
        calendar_ids: ["ana"],
      })
    )

    expect(err.status).toBe(400)
    expect(google.inserts).toEqual([])
  })
})

describe("update_event", () => {
  test("patches every copy of the group", async () => {
    const { service, google } = setup()
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    const result = (await service.updateEvent(WRITER, { group_id: created.group_id, summary: "Renamed" })) as any

    expect(result.ok).toBe(true)
    expect(google.patches.map((p) => p.calendarId).sort()).toEqual(["ana@example.com", "bruno@example.com"])
    expect(google.patches.every((p) => p.patch.summary === "Renamed")).toBe(true)
  })

  test("an unknown group is a 404, not a silent success", async () => {
    const { service, google } = setup()
    const err = await rejection(service.updateEvent(WRITER, { group_id: "nope", summary: "x" }))

    expect(err.code).toBe("GROUP_NOT_FOUND")
    expect(google.patches).toEqual([])
  })

  test("moving onto an occupied slot is refused, ignoring the event's own copies", async () => {
    const { service, google } = setup()
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"] })) as any
    google.seed("ana@example.com", {
      id: "other",
      summary: "Lunch",
      start: { dateTime: "2026-10-05T13:00:00+01:00" },
      end: { dateTime: "2026-10-05T14:00:00+01:00" },
    })

    // Shifting by 30 minutes overlaps only itself: allowed.
    await service.updateEvent(WRITER, {
      group_id: created.group_id,
      start: "2026-10-05T10:30:00+01:00",
      end: "2026-10-05T11:30:00+01:00",
    })

    const err = await rejection(
      service.updateEvent(WRITER, {
        group_id: created.group_id,
        start: "2026-10-05T13:30:00+01:00",
        end: "2026-10-05T14:30:00+01:00",
      })
    )
    expect(err.status).toBe(409)
  })

  test("a free event moves without a conflict check", async () => {
    const { service, google } = setup()
    const created = (await service.createEvent(WRITER, {
      ...MEETING,
      calendar_ids: ["ana"],
      show_as: "free",
    })) as any
    google.seed("ana@example.com", {
      id: "other",
      summary: "Lunch",
      start: { dateTime: "2026-10-05T13:00:00+01:00" },
      end: { dateTime: "2026-10-05T14:00:00+01:00" },
    })

    const result = (await service.updateEvent(WRITER, {
      group_id: created.group_id,
      start: "2026-10-05T13:00:00+01:00",
      end: "2026-10-05T14:00:00+01:00",
    })) as any

    expect(result.ok).toBe(true)
  })

  test("full success answers 200, one failed copy 207, every copy failed 502; failures are refunded", async () => {
    const { service, google, limiter } = setup({ maxPerMin: 10 })
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    const ok = (await service.updateEvent(WRITER, { group_id: created.group_id, summary: "A" })) as any
    expect(ok.status).toBe(200)

    const realPatch = google.patchEvent.bind(google)
    google.patchEvent = async (calendarId, eventId, patch) => {
      if (calendarId === "bruno@example.com") throw new CalendarApiError(403, "forbidden")
      return realPatch(calendarId, eventId, patch)
    }
    const partial = (await service.updateEvent(WRITER, { group_id: created.group_id, summary: "B" })) as any
    expect(partial.status).toBe(207)
    expect(partial.ok).toBe(false)

    google.patchEvent = async () => {
      throw new CalendarApiError(403, "forbidden")
    }
    const failed = (await service.updateEvent(WRITER, { group_id: created.group_id, summary: "C" })) as any
    expect(failed.status).toBe(502)

    // 2 creates + 2 + (2 - 1 refunded) + (2 - 2 refunded) = 5 of 10 spent.
    expect(limiter.consume(5, NOW).allowed).toBe(true)
    expect(limiter.consume(1, NOW).allowed).toBe(false)
  })

  test("the write cap counts every copy found, and nothing is patched past it", async () => {
    const { service, google, entries, notices } = setup({ maxPerMin: 3 })
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    const err = await rejection(service.updateEvent(WRITER, { group_id: created.group_id, summary: "x" }))

    expect(err.status).toBe(429)
    expect(google.patches).toEqual([])
    expect(notices).toHaveLength(1)
    expect(entries.filter((e) => e.status === 429)).toEqual([
      expect.objectContaining({ operation: "update_event", group_id: created.group_id }),
    ])
  })

  test("dry_run shows the patch, writes nothing and spends nothing", async () => {
    const { service, google, limiter } = setup({ maxPerMin: 5 })
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    const result = (await service.updateEvent(WRITER, {
      group_id: created.group_id,
      summary: "x",
      dry_run: true,
    })) as any

    expect(result.would_update).toHaveLength(2)
    expect(result.patch.summary).toBe("x")
    expect(google.patches).toEqual([])
    expect(limiter.consume(3, NOW).allowed).toBe(true)
  })

  test("a dry run still needs room under the cap: it is charged, then refunded", async () => {
    const { service } = setup({ maxPerMin: 3 })
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    const err = await rejection(
      service.updateEvent(WRITER, { group_id: created.group_id, summary: "x", dry_run: true })
    )
    expect(err.status).toBe(429)
  })

  test("an update with nothing to change is refused", async () => {
    const { service } = setup()
    const created = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"] })) as any

    const err = await rejection(service.updateEvent(WRITER, { group_id: created.group_id }))
    expect(err.code).toBe("INVALID_INPUT")
  })
})

describe("create_event audit", () => {
  test("a success is audited with the calendars, group and event ids", async () => {
    const { service, entries } = setup()
    const result = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana", "bruno"] })) as any

    expect(entries.at(-1)).toMatchObject({
      operation: "create_event",
      outcome: "ok",
      calendars: ["ana", "bruno"],
      group_id: result.group_id,
    })
    expect(entries.at(-1)!.event_ids).toHaveLength(2)
  })

  test("a dry run is audited as dry_run", async () => {
    const { service, entries } = setup()
    await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"], dry_run: true })

    expect(entries.at(-1)).toMatchObject({ operation: "create_event", outcome: "dry_run", status: 200 })
  })

  test("an unreadable calendar during the conflict check blocks the write unless partial_ok", async () => {
    const { service, google } = setup()
    google.listEvents = async () => {
      throw new CalendarApiError(500, "boom")
    }

    const err = await rejection(service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"] }))
    expect(err.code).toBe("CALENDAR_UNREADABLE")
    expect(google.inserts).toEqual([])

    const result = (await service.createEvent(WRITER, { ...MEETING, calendar_ids: ["ana"], partial_ok: true })) as any
    expect(result.ok).toBe(true)
  })
})

describe("reads", () => {
  test("list_calendars answers only this principal's calendars", async () => {
    const { service } = setup()
    const result = JSON.stringify(await service.listCalendars(READER))

    expect(result).toContain("ana")
    expect(result).not.toContain("bruno")
  })

  test("check_conflicts reports a busy_only calendar without asking for titles", async () => {
    const { service } = setup()
    const result = (await service.checkConflicts(WRITER, {
      calendar_ids: ["carla"],
      start: MEETING.start,
      end: MEETING.end,
    })) as any

    expect(result.conflict).toBe(false)
    expect(result.calendars_checked).toEqual([{ alias: "carla", detail: "busy_only" }])
  })
})
