import { describe, expect, test } from "bun:test"
import { buildEventBody, buildPatchBody, planFanout, summarizeFanout } from "./fanout"
import { eventIdFor, groupIdFor, isValidEventId } from "./idempotency"
import type { CalendarEntry, EventInput, FanoutResult } from "./types"

const THIAGO: CalendarEntry = { alias: "thiago", id: "thiago@example.com", access: "details" }
const THILIA: CalendarEntry = { alias: "thilia", id: "thilia@example.com", access: "details" }

const INPUT: EventInput = {
  summary: "Jantar",
  start: "2026-09-03T20:00:00-03:00",
  end: "2026-09-03T22:00:00-03:00",
  timezone: "America/Sao_Paulo",
  all_day: false,
}

describe("planFanout", () => {
  test("every copy shares the group id and has its own event id", () => {
    const plan = planFanout([THIAGO, THILIA], "k1")
    expect(plan.groupId).toBe(groupIdFor("k1"))
    expect(plan.targets.map((t) => t.alias)).toEqual(["thiago", "thilia"])
    expect(plan.targets[0]!.eventId).not.toBe(plan.targets[1]!.eventId)
    expect(plan.targets.every((t) => isValidEventId(t.eventId))).toBe(true)
  })

  test("is stable across retries of the same key", () => {
    const a = planFanout([THIAGO, THILIA], "k1")
    const b = planFanout([THIAGO, THILIA], "k1")
    expect(b).toEqual(a)
  })

  test("a different key produces a different group and different ids", () => {
    const a = planFanout([THIAGO], "k1")
    const b = planFanout([THIAGO], "k2")
    expect(b.groupId).not.toBe(a.groupId)
    expect(b.targets[0]!.eventId).not.toBe(a.targets[0]!.eventId)
  })

  test("a calendar listed twice is planned once", () => {
    const plan = planFanout([THIAGO, { ...THIAGO, alias: "eu" }], "k1")
    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0]!.eventId).toBe(eventIdFor("k1", THIAGO.id))
  })

  test("an empty calendar list plans nothing", () => {
    expect(planFanout([], "k1").targets).toHaveLength(0)
  })
})

describe("buildEventBody", () => {
  test("timed events carry dateTime and timeZone", () => {
    const body = buildEventBody(INPUT, "g1")
    expect(body.start?.dateTime).toBe(INPUT.start)
    expect(body.start?.timeZone).toBe("America/Sao_Paulo")
    expect(body.extendedProperties?.private?.group_id).toBe("g1")
  })

  test("all-day events carry date and no timeZone", () => {
    const body = buildEventBody({ ...INPUT, all_day: true, start: "2026-09-03", end: "2026-09-04" }, "g1")
    expect(body.start?.date).toBe("2026-09-03")
    expect(body.start?.dateTime).toBeUndefined()
    expect(body.start?.timeZone).toBeUndefined()
  })

  test("never emits attendees, whatever came in", () => {
    const body = buildEventBody({ ...INPUT, description: "com a Thilia" }, "g1")
    expect(JSON.stringify(body)).not.toContain("attendees")
  })

  test("optional fields stay out when absent", () => {
    const body = buildEventBody(INPUT, "g1")
    expect("description" in body).toBe(false)
    expect("location" in body).toBe(false)
  })

  test("extra private properties ride along with the group id", () => {
    const body = buildEventBody(INPUT, "g1", { created_by: "claude-code-thiago" })
    expect(body.extendedProperties?.private).toEqual({
      group_id: "g1",
      created_by: "claude-code-thiago",
    })
  })
})

describe("buildPatchBody", () => {
  test("only the fields the caller sent", () => {
    expect(buildPatchBody({ summary: "Novo título" })).toEqual({ summary: "Novo título" })
  })

  test("times move together or not at all", () => {
    expect(buildPatchBody({ start: "2026-09-03T21:00:00-03:00" }).start).toBeUndefined()
    const patch = buildPatchBody({
      start: "2026-09-03T21:00:00-03:00",
      end: "2026-09-03T23:00:00-03:00",
      timezone: "America/Sao_Paulo",
    })
    expect(patch.start?.dateTime).toBe("2026-09-03T21:00:00-03:00")
  })

  test("an empty description clears it instead of being dropped", () => {
    expect(buildPatchBody({ description: "" })).toEqual({ description: "" })
  })
})

describe("summarizeFanout", () => {
  const ok = (alias: string): FanoutResult => ({
    calendar: alias,
    calendar_id: `${alias}@example.com`,
    ok: true,
    created: true,
    event_id: "abc",
  })
  const fail = (alias: string): FanoutResult => ({
    calendar: alias,
    calendar_id: `${alias}@example.com`,
    ok: false,
    error: "500 from Google",
  })

  test("all created is 201", () => {
    expect(summarizeFanout("g1", [ok("thiago"), ok("thilia")]).status).toBe(201)
  })

  test("an idempotent replay is 200, not 201", () => {
    const replay: FanoutResult = { ...ok("thiago"), created: false }
    expect(summarizeFanout("g1", [replay]).status).toBe(200)
  })

  test("a partial failure is 207 and names both sides", () => {
    const summary = summarizeFanout("g1", [ok("thiago"), fail("thilia")])
    expect(summary.status).toBe(207)
    expect(summary.ok).toBe(false)
    expect(summary.results.find((r) => r.calendar === "thilia")?.error).toContain("Google")
    expect(summary.results.find((r) => r.calendar === "thiago")?.event_id).toBe("abc")
  })

  test("everything failing is 502, never a truthful-looking 200", () => {
    expect(summarizeFanout("g1", [fail("thiago"), fail("thilia")]).status).toBe(502)
  })
})
