/**
 * calendar-gate — headless multi-user Google Calendar gateway for agents.
 *
 * Three requirements shape this service, and none of them is a feature:
 * it runs headless (a service account JWT, never a browser), it serves several
 * people through one credential (each principal reaches only its own
 * calendars), and it is built so that an agent hallucinating in a loop cannot
 * do damage (write caps, date guards, conflict checks, no delete at all).
 *
 * Business rules live here; mcp.ts is a thin layer that calls the same
 * functions the REST routes call, so the two can never drift apart.
 */

import { loadConfig } from "./config"
import { appendLog, log } from "./logger"
import { ServiceAccountAuth, AuthError } from "./google/auth"
import { CalendarApiError, CalendarClient } from "./google/calendar"
import {
  calendarsOf,
  canWrite,
  describePrincipal,
  loadRegistry,
  resolveCalendar,
  resolvePrincipal,
  type Registry,
} from "./principals"
import {
  checkDateGuard,
  checkWritableAccess,
  isViolation,
  parseInstant,
  validateEventInput,
  WriteLimiter,
  type PolicyViolation,
} from "./policy"
import {
  busyFromEvents,
  busyFromFreeBusy,
  conflictsIn,
  findFreeSlots,
  toSpan,
} from "./conflicts"
import { buildEventBody, buildPatchBody, planFanout, summarizeFanout } from "./fanout"
import { randomIdempotencyKey } from "./idempotency"
import { isValidTimezone } from "./timezone"
import { handleMCP, type Handlers } from "./mcp"
import type { BusyBlock, CalendarEntry, FanoutResult, Principal } from "./types"

const config = loadConfig()
const auth = new ServiceAccountAuth(config.saKeyFile)
const client = new CalendarClient(auth)
const limiter = new WriteLimiter(config.maxWritesPerMin, config.maxWritesPerDay)

let registry: Registry = loadRegistry(config)
for (const problem of registry.errors) log("registry problem", { problem })

// ───────────────────────────────────────────────────────────────────── errors

class ApiError extends Error {
  /**
   * Set by the handlers that already wrote a richer audit line (with the group
   * id and the calendars). Everything else is audited centrally, so a denial
   * cannot be lost just because it was raised early.
   */
  audited = false

  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly extra?: unknown
  ) {
    super(message)
  }

  static from(v: PolicyViolation): ApiError {
    return new ApiError(v.code, v.message, v.status)
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

// ──────────────────────────────────────────────────────────────────── alerting

let lastAuthAlert = 0

async function notify(message: string): Promise<void> {
  if (!config.gossipApiKey) return
  try {
    await fetch(config.gossipUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": config.gossipApiKey },
      body: JSON.stringify({ message }),
    })
  } catch (e) {
    log("gossip-gate notification failed", { error: String(e) })
  }
}

/**
 * A credential failure would otherwise stay invisible until an agent happened
 * to try something. Throttled to one alert an hour so a broken key does not
 * turn into a message storm.
 */
async function alertAuthFailure(e: AuthError): Promise<void> {
  const now = Date.now()
  if (now - lastAuthAlert < 60 * 60 * 1000) return
  lastAuthAlert = now
  await notify(`calendar-gate: Google credential is failing.\n${e.message}\n\n${e.actionable}`)
}

// ────────────────────────────────────────────────────────────── shared helpers

function requireWrite(principal: Principal): void {
  if (!canWrite(principal)) {
    throw new ApiError(
      "READ_ONLY_PRINCIPAL",
      `principal "${principal.name}" has role read and cannot modify calendars`,
      403
    )
  }
}

/**
 * Resolves the requested calendars against the principal's set. Resolving every
 * one before doing anything is what keeps a denied calendar from leaving a
 * half-finished fan-out behind.
 */
function resolveAll(principal: Principal, refs: unknown, opts: { required: boolean }): CalendarEntry[] {
  if (refs === undefined || refs === null) {
    if (opts.required) {
      throw new ApiError("INVALID_INPUT", "calendar_ids is required and must be a non-empty array", 400)
    }
    return calendarsOf(registry, principal)
  }
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new ApiError("INVALID_INPUT", "calendar_ids must be a non-empty array", 400)
  }

  const out: CalendarEntry[] = []
  for (const ref of refs) {
    const cal = typeof ref === "string" ? resolveCalendar(registry, principal, ref) : null
    if (!cal) {
      // Deliberately the same answer whether the calendar is unknown or merely
      // out of reach: the error must not be a directory of what exists.
      throw new ApiError(
        "CALENDAR_DENIED",
        `calendar "${String(ref)}" is not available to principal "${principal.name}"`,
        403,
        { allowed: principal.calendars }
      )
    }
    out.push(cal)
  }
  return out
}

function requireWindow(body: Record<string, unknown>): { timeMin: string; timeMax: string } {
  const min = parseInstant(body.time_min, "time_min")
  if (isViolation(min)) throw ApiError.from(min)
  const max = parseInstant(body.time_max, "time_max")
  if (isViolation(max)) throw ApiError.from(max)
  if (max.ms <= min.ms) throw new ApiError("INVALID_INPUT", "time_max must be after time_min", 400)
  if (max.ms - min.ms > 366 * 24 * 60 * 60 * 1000) {
    throw new ApiError("INVALID_INPUT", "the window is longer than a year", 400)
  }
  return { timeMin: String(body.time_min), timeMax: String(body.time_max) }
}

function timezoneOf(body: Record<string, unknown>): string {
  const tz = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : config.defaultTimezone
  if (!isValidTimezone(tz)) throw new ApiError("INVALID_INPUT", `unknown timezone "${tz}"`, 400)
  return tz
}

/**
 * Busy blocks for a set of calendars. The share level decides the source:
 * a calendar shared with full detail goes through events.list and keeps its
 * titles; one shared as availability goes through freeBusy and comes back as
 * bare intervals, marked so the agent knows there is no title to report.
 */
async function collectBusy(
  calendars: CalendarEntry[],
  window: { timeMin: string; timeMax: string },
  timezone: string,
  opts: { ignoreEventId?: string; ignoreGroupId?: string; query?: string } = {}
): Promise<{ blocks: BusyBlock[]; errors: Array<{ calendar: string; error: string }> }> {
  const blocks: BusyBlock[] = []
  const errors: Array<{ calendar: string; error: string }> = []

  const detailed = calendars.filter((c) => c.access === "details")
  const busyOnly = calendars.filter((c) => c.access === "busy_only")

  await Promise.all(
    detailed.map(async (cal) => {
      try {
        const events = await client.listEvents(cal.id, {
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          q: opts.query,
        })
        blocks.push(...busyFromEvents(events, cal.alias, timezone, opts))
      } catch (e) {
        // A broken credential is not a per-calendar problem: it fails every
        // read, and reporting it as one unreadable calendar would bury it.
        if (e instanceof AuthError) throw e
        errors.push({ calendar: cal.alias, error: describeCalendarError(e, cal) })
      }
    })
  )

  if (busyOnly.length) {
    try {
      const result = await client.freeBusy({
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        calendarIds: busyOnly.map((c) => c.id),
        timeZone: timezone,
      })
      for (const cal of busyOnly) {
        const entry = result[cal.id]
        if (!entry) {
          errors.push({ calendar: cal.alias, error: "no availability returned" })
          continue
        }
        if (entry.errors?.length) {
          errors.push({ calendar: cal.alias, error: entry.errors.map((x) => x.reason).join(", ") })
          continue
        }
        blocks.push(...busyFromFreeBusy(entry.busy, cal.alias, timezone))
      }
    } catch (e) {
      if (e instanceof AuthError) throw e
      for (const cal of busyOnly) errors.push({ calendar: cal.alias, error: describeCalendarError(e, cal) })
    }
  }

  blocks.sort((a, b) => a.start.localeCompare(b.start))
  return { blocks, errors }
}

/**
 * Fails closed on an unreadable calendar. An availability answer is an
 * assertion that nothing is there, and a calendar that could not be read makes
 * that assertion unfounded: "the whole day is free" because Google was
 * unreachable is a worse answer than an error. The caller can accept the gap
 * explicitly with partial_ok.
 */
function assertComplete(
  errors: Array<{ calendar: string; error: string }>,
  body: Record<string, unknown>
): void {
  if (!errors.length || body.partial_ok === true) return
  throw new ApiError(
    "CALENDAR_UNREADABLE",
    `could not read ${errors.map((e) => `"${e.calendar}"`).join(", ")}, so availability cannot be asserted. ` +
      "Fix the sharing or send partial_ok: true to accept an answer that ignores those calendars.",
    502,
    { calendar_errors: errors }
  )
}

function describeCalendarError(e: unknown, cal: CalendarEntry): string {
  if (e instanceof CalendarApiError) {
    if (e.isForbidden) {
      return `not shared with the service account, or shared at a lower level than "${cal.access}"`
    }
    if (e.isNotFound) return "calendar id not found at Google"
    return `Google returned ${e.status}`
  }
  return String((e as Error)?.message ?? e)
}

/** Auth failures deserve a 503 with something to act on, not a generic 500. */
function toResponseError(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof ApiError) {
    return {
      status: e.status,
      body: { error: e.code, message: e.message, ...(e.extra ? { detail: e.extra } : {}) },
    }
  }
  if (e instanceof AuthError) {
    void alertAuthFailure(e)
    return {
      status: 503,
      body: { error: "GOOGLE_AUTH_FAILED", message: e.message, next_step: e.actionable },
    }
  }
  if (e instanceof CalendarApiError) {
    return { status: e.status === 403 ? 403 : 502, body: { error: "GOOGLE_API_ERROR", message: e.message } }
  }
  return { status: 500, body: { error: "INTERNAL", message: String((e as Error)?.message ?? e) } }
}

// ───────────────────────────────────────────────────────────────── operations

async function opListCalendars(principal: Principal) {
  // Answered from local config on purpose: no calendarList call, so this never
  // reveals a calendar shared with the service account for someone else's use.
  return describePrincipal(registry, principal)
}

async function opSearchEvents(principal: Principal, body: Record<string, unknown>) {
  const calendars = resolveAll(principal, body.calendar_ids, { required: false })
  const window = requireWindow(body)
  const timezone = timezoneOf(body)
  const query = typeof body.query === "string" && body.query.trim() ? body.query.trim() : undefined

  const { blocks, errors } = await collectBusy(calendars, window, timezone, { query })
  return {
    time_min: window.timeMin,
    time_max: window.timeMax,
    timezone,
    events: blocks,
    ...(errors.length ? { calendar_errors: errors } : {}),
  }
}

async function opCheckConflicts(principal: Principal, body: Record<string, unknown>) {
  const calendars = resolveAll(principal, body.calendar_ids, { required: false })
  const timezone = timezoneOf(body)

  const start = parseInstant(body.start, "start")
  if (isViolation(start)) throw ApiError.from(start)
  const end = parseInstant(body.end, "end")
  if (isViolation(end)) throw ApiError.from(end)
  if (end.ms <= start.ms) throw new ApiError("INVALID_INPUT", "end must be after start", 400)

  const { blocks, errors } = await collectBusy(
    calendars,
    { timeMin: String(body.start), timeMax: String(body.end) },
    timezone,
    {
      ignoreEventId: typeof body.ignore_event_id === "string" ? body.ignore_event_id : undefined,
      ignoreGroupId: typeof body.ignore_group_id === "string" ? body.ignore_group_id : undefined,
    }
  )

  assertComplete(errors, body)

  const hits = conflictsIn(blocks, { startMs: start.ms, endMs: end.ms })
  return {
    start: String(body.start),
    end: String(body.end),
    timezone,
    conflict: hits.length > 0,
    conflicts: hits,
    calendars_checked: calendars.map((c) => ({ alias: c.alias, detail: c.access })),
    ...(errors.length ? { calendar_errors: errors } : {}),
  }
}

async function opFindFreeSlots(principal: Principal, body: Record<string, unknown>) {
  const calendars = resolveAll(principal, body.calendar_ids, { required: false })
  const window = requireWindow(body)
  const timezone = timezoneOf(body)

  const duration = Number(body.duration_minutes ?? 60)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60) {
    throw new ApiError("INVALID_INPUT", "duration_minutes must be between 1 and 1440", 400)
  }

  const weekdays = Array.isArray(body.weekdays)
    ? body.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : undefined

  const { blocks, errors } = await collectBusy(calendars, window, timezone)
  assertComplete(errors, body)

  const slots = findFreeSlots(blocks, {
    windowStart: window.timeMin,
    windowEnd: window.timeMax,
    durationMinutes: duration,
    timezone,
    businessStart: typeof body.business_start === "string" ? body.business_start : undefined,
    businessEnd: typeof body.business_end === "string" ? body.business_end : undefined,
    weekdays,
    now: Date.now(),
    maxResults: Number(body.max_results ?? 20),
  })

  return {
    timezone,
    duration_minutes: duration,
    calendars_checked: calendars.map((c) => c.alias),
    slots,
    ...(errors.length ? { calendar_errors: errors } : {}),
  }
}

async function opCreateEvent(principal: Principal, body: Record<string, unknown>) {
  requireWrite(principal)

  // Every calendar is resolved and checked before a single copy is written.
  const calendars = resolveAll(principal, body.calendar_ids, { required: true })
  for (const cal of calendars) {
    const denied = checkWritableAccess(cal.alias, cal.access)
    if (denied) throw ApiError.from(denied)
  }

  const input = validateEventInput(body, { timezone: config.defaultTimezone })
  if (isViolation(input)) throw ApiError.from(input)
  if (!isValidTimezone(input.timezone)) {
    throw new ApiError("INVALID_INPUT", `unknown timezone "${input.timezone}"`, 400)
  }

  const dateDenied = checkDateGuard(input.start, {
    maxPastHours: config.maxPastHours,
    maxFutureDays: config.maxFutureDays,
    allowPast: body.allow_past === true,
    now: Date.now(),
  })
  if (dateDenied) throw ApiError.from(dateDenied)

  const idempotencyKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : randomIdempotencyKey()
  const plan = planFanout(calendars, idempotencyKey)

  // Conflicts are checked against the same calendars the event would land on,
  // ignoring this event's own copies so that a retry does not collide with what
  // it already created.
  let conflicts: BusyBlock[] = []
  if (body.allow_conflict !== true) {
    const { blocks, errors } = await collectBusy(
      calendars,
      { timeMin: input.start, timeMax: input.end },
      input.timezone,
      { ignoreGroupId: plan.groupId }
    )
    // Writing after a failed conflict check would be scheduling blind.
    assertComplete(errors, body)
    conflicts = conflictsIn(blocks, toSpan({ start: input.start, end: input.end }))
    if (conflicts.length) {
      await audit(principal, "create_event", "denied", 409, {
        calendars: calendars.map((c) => c.alias),
        group_id: plan.groupId,
        reason: "CONFLICT",
      })
      const conflictError = new ApiError(
        "CONFLICT",
        "the requested time overlaps existing events. Send allow_conflict: true to schedule anyway.",
        409,
        { conflicts }
      )
      conflictError.audited = true
      throw conflictError
    }
  }

  const dryRun = body.dry_run === true
  const decision = limiter.consume(plan.targets.length, Date.now())
  if (!decision.allowed) {
    if (decision.firstBreach) {
      void notify(
        `calendar-gate: write limit hit by "${principal.name}" (${decision.violation?.code}). ` +
          "Nothing was written. An agent may be looping."
      )
    }
    await audit(principal, "create_event", "denied", 429, {
      calendars: calendars.map((c) => c.alias),
      reason: decision.violation?.code,
    })
    const limitError = ApiError.from(decision.violation!)
    limitError.audited = true
    throw limitError
  }

  if (dryRun) {
    limiter.refund(plan.targets.length)
    await audit(principal, "create_event", "dry_run", 200, {
      calendars: calendars.map((c) => c.alias),
      group_id: plan.groupId,
    })
    return {
      dry_run: true,
      group_id: plan.groupId,
      idempotency_key: idempotencyKey,
      would_create: plan.targets.map((t) => ({ calendar: t.alias, event_id: t.eventId })),
      event: buildEventBody(input, plan.groupId),
    }
  }

  const eventBody = buildEventBody(input, plan.groupId, { created_by: principal.name })
  const results: FanoutResult[] = []

  for (const target of plan.targets) {
    try {
      const created = await client.insertEvent(target.calendarId, target.eventId, eventBody)
      results.push({
        calendar: target.alias,
        calendar_id: target.calendarId,
        ok: true,
        created: true,
        event_id: created.id ?? target.eventId,
        ...(created.htmlLink ? { html_link: created.htmlLink } : {}),
      })
    } catch (e) {
      if (e instanceof CalendarApiError && e.isAlreadyExists) {
        // The retry case: the id is derived from the idempotency key, so this
        // is our own earlier write, not someone else's event.
        results.push({
          calendar: target.alias,
          calendar_id: target.calendarId,
          ok: true,
          created: false,
          event_id: target.eventId,
        })
        continue
      }
      results.push({
        calendar: target.alias,
        calendar_id: target.calendarId,
        ok: false,
        error: describeCalendarError(e, { alias: target.alias, id: target.calendarId, access: "details" }),
      })
    }
  }

  const summary = summarizeFanout(plan.groupId, results)
  const failed = results.filter((r) => !r.ok).length
  if (failed) limiter.refund(failed)

  await audit(principal, "create_event", summary.ok ? "ok" : "error", summary.status, {
    calendars: calendars.map((c) => c.alias),
    group_id: plan.groupId,
    event_ids: results.filter((r) => r.event_id).map((r) => r.event_id!),
  })

  return {
    ...summary,
    idempotency_key: idempotencyKey,
    ...(conflicts.length ? { scheduled_over: conflicts } : {}),
  }
}

async function opUpdateEvent(principal: Principal, groupId: string, body: Record<string, unknown>) {
  requireWrite(principal)
  if (!groupId.trim()) throw new ApiError("INVALID_INPUT", "group_id is required", 400)

  const calendars = resolveAll(principal, body.calendar_ids, { required: false }).filter(
    (c) => c.access === "details"
  )
  if (!calendars.length) {
    throw new ApiError("NO_WRITABLE_CALENDAR", "this principal reaches no writable calendar", 403)
  }

  const input = validateEventInput(body, { timezone: config.defaultTimezone }, { requireTimes: false })
  if (isViolation(input)) throw ApiError.from(input)

  const movingTimes = Boolean(input.start && input.end)
  if (movingTimes) {
    const dateDenied = checkDateGuard(input.start, {
      maxPastHours: config.maxPastHours,
      maxFutureDays: config.maxFutureDays,
      allowPast: body.allow_past === true,
      now: Date.now(),
    })
    if (dateDenied) throw ApiError.from(dateDenied)
  }

  // Locate the copies first: an update that matches nothing is a 404, not a
  // silent success.
  const found: Array<{ cal: CalendarEntry; eventId: string }> = []
  const errors: Array<{ calendar: string; error: string }> = []
  await Promise.all(
    calendars.map(async (cal) => {
      try {
        for (const event of await client.findByGroupId(cal.id, groupId)) {
          if (event.id) found.push({ cal, eventId: event.id })
        }
      } catch (e) {
        errors.push({ calendar: cal.alias, error: describeCalendarError(e, cal) })
      }
    })
  )

  if (!found.length) {
    throw new ApiError(
      "GROUP_NOT_FOUND",
      `no event with group_id "${groupId}" on the calendars this principal reaches`,
      404,
      errors.length ? { calendar_errors: errors } : undefined
    )
  }

  if (movingTimes && body.allow_conflict !== true) {
    const { blocks, errors: readErrors } = await collectBusy(
      calendars,
      { timeMin: input.start, timeMax: input.end },
      input.timezone,
      { ignoreGroupId: groupId }
    )
    assertComplete(readErrors, body)
    const hits = conflictsIn(blocks, toSpan({ start: input.start, end: input.end }))
    if (hits.length) {
      await audit(principal, "update_event", "denied", 409, { group_id: groupId, reason: "CONFLICT" })
      const conflictError = new ApiError(
        "CONFLICT",
        "the new time overlaps existing events. Send allow_conflict: true to move it anyway.",
        409,
        { conflicts: hits }
      )
      conflictError.audited = true
      throw conflictError
    }
  }

  const patch = buildPatchBody(input)
  if (!Object.keys(patch).length) {
    throw new ApiError("INVALID_INPUT", "nothing to update: send summary, description, location or start+end", 400)
  }

  const decision = limiter.consume(found.length, Date.now())
  if (!decision.allowed) {
    if (decision.firstBreach) {
      void notify(`calendar-gate: write limit hit by "${principal.name}" on update. Nothing was written.`)
    }
    await audit(principal, "update_event", "denied", 429, { group_id: groupId, reason: decision.violation?.code })
    const limitError = ApiError.from(decision.violation!)
    limitError.audited = true
    throw limitError
  }

  if (body.dry_run === true) {
    limiter.refund(found.length)
    return {
      dry_run: true,
      group_id: groupId,
      would_update: found.map((f) => ({ calendar: f.cal.alias, event_id: f.eventId })),
      patch,
    }
  }

  const results: FanoutResult[] = []
  for (const { cal, eventId } of found) {
    try {
      const updated = await client.patchEvent(cal.id, eventId, patch)
      results.push({
        calendar: cal.alias,
        calendar_id: cal.id,
        ok: true,
        updated: true,
        event_id: eventId,
        ...(updated.htmlLink ? { html_link: updated.htmlLink } : {}),
      })
    } catch (e) {
      results.push({
        calendar: cal.alias,
        calendar_id: cal.id,
        ok: false,
        event_id: eventId,
        error: describeCalendarError(e, cal),
      })
    }
  }

  const failed = results.filter((r) => !r.ok).length
  if (failed) limiter.refund(failed)

  const summary = summarizeFanout(groupId, results)
  await audit(principal, "update_event", summary.ok ? "ok" : "error", summary.ok ? 200 : summary.status, {
    calendars: [...new Set(results.map((r) => r.calendar))],
    group_id: groupId,
    event_ids: results.map((r) => r.event_id!).filter(Boolean),
  })

  return {
    ...summary,
    status: summary.ok ? 200 : summary.status,
    ...(errors.length ? { calendar_errors: errors } : {}),
  }
}

async function audit(
  principal: Principal,
  operation: string,
  outcome: "ok" | "denied" | "error" | "dry_run",
  status: number,
  extra: { calendars?: string[]; group_id?: string; event_ids?: string[]; reason?: string } = {}
): Promise<void> {
  await appendLog({
    ts: new Date().toISOString(),
    principal: principal.name,
    operation,
    outcome,
    status,
    ...extra,
  })
}

/**
 * Single choke point for both transports. Every refusal is logged here, which
 * is the point of the audit trail: a run of CALENDAR_DENIED is what an agent in
 * a loop, or someone probing the allowlist, looks like, and those are raised
 * early — before the handlers that write their own richer line.
 *
 * REST and MCP both go through it, so a denial cannot be recorded on one
 * transport and lost on the other.
 */
async function run<T>(principal: Principal, operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiError) {
      if (!e.audited) {
        e.audited = true
        await audit(principal, operation, e.status < 500 ? "denied" : "error", e.status, { reason: e.code })
      }
    } else if (e instanceof AuthError) {
      await audit(principal, operation, "error", 503, { reason: "GOOGLE_AUTH_FAILED" })
    } else if (e instanceof CalendarApiError) {
      await audit(principal, operation, "error", e.status, { reason: "GOOGLE_API_ERROR" })
    }
    throw e
  }
}

const handlers: Handlers = {
  listCalendars: (p) => run(p, "list_calendars", () => opListCalendars(p)),
  searchEvents: (p, args) => run(p, "search_events", () => opSearchEvents(p, args)),
  checkConflicts: (p, args) => run(p, "check_conflicts", () => opCheckConflicts(p, args)),
  findFreeSlots: (p, args) => run(p, "find_free_slots", () => opFindFreeSlots(p, args)),
  createEvent: (p, args) => run(p, "create_event", () => opCreateEvent(p, args)),
  updateEvent: (p, args) =>
    run(p, "update_event", () => opUpdateEvent(p, String(args.group_id ?? ""), args)),
}

// ─────────────────────────────────────────────────────────────────────── HTTP

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ApiError("INVALID_INPUT", "the body must be a JSON object", 400)
    }
    return parsed as Record<string, unknown>
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError("INVALID_INPUT", "the body is not valid JSON", 400)
  }
}

function authenticate(req: Request): Principal {
  const principal = resolvePrincipal(registry, req.headers.get("x-api-key"))
  if (!principal) throw new ApiError("UNAUTHORIZED", "missing or unknown X-Api-Key", 401)
  return principal
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"

    try {
      // The only unauthenticated route. It says alive and whether the Google
      // credential works, and nothing else — not the service account address,
      // not which calendars exist.
      if (path === "/health" && req.method === "GET") {
        let authenticated = false
        let detail: string | undefined
        try {
          await auth.getAccessToken()
          authenticated = true
        } catch (e) {
          detail = e instanceof AuthError ? e.actionable : "unexpected auth failure"
          if (e instanceof AuthError) void alertAuthFailure(e)
        }
        return json(
          {
            ok: true,
            service: "calendar-gate",
            google_authenticated: authenticated,
            ...(detail ? { next_step: detail } : {}),
          },
          authenticated ? 200 : 503
        )
      }

      if (path === "/mcp") {
        // Diverges from the fleet default of an open /mcp: with an open one,
        // any local process could write to anyone's calendar with no credential.
        const principal = resolvePrincipal(registry, req.headers.get("x-api-key"))
        return handleMCP(req, principal, handlers)
      }

      if (path === "/calendars" && req.method === "GET") {
        const principal = authenticate(req)
        return json(await handlers.listCalendars(principal))
      }

      if (path === "/events/search" && req.method === "POST") {
        const principal = authenticate(req)
        return json(await handlers.searchEvents(principal, await readBody(req)))
      }

      if (path === "/conflicts" && req.method === "POST") {
        const principal = authenticate(req)
        return json(await handlers.checkConflicts(principal, await readBody(req)))
      }

      if (path === "/free-slots" && req.method === "POST") {
        const principal = authenticate(req)
        return json(await handlers.findFreeSlots(principal, await readBody(req)))
      }

      if (path === "/events" && req.method === "POST") {
        const principal = authenticate(req)
        const result = await handlers.createEvent(principal, await readBody(req))
        const status = typeof (result as { status?: number }).status === "number"
          ? (result as { status: number }).status
          : 200
        return json(result, status)
      }

      const groupMatch = /^\/events\/group\/([^/]+)$/.exec(path)
      if (groupMatch && req.method === "PATCH") {
        const principal = authenticate(req)
        const body = await readBody(req)
        body.group_id = decodeURIComponent(groupMatch[1]!)
        const result = await handlers.updateEvent(principal, body)
        return json(result, (result as { status?: number }).status ?? 200)
      }

      return json({ error: "NOT_FOUND", message: `no route for ${req.method} ${path}` }, 404)
    } catch (e) {
      const { status, body } = toResponseError(e)
      if (status >= 500) log("request failed", { path, status, error: String((e as Error)?.message ?? e) })
      // A run of these is the intrusion signal, and there is no principal to
      // attribute them to — that is exactly what makes them worth keeping.
      if (status === 401) {
        await appendLog({
          ts: new Date().toISOString(),
          principal: "(unknown)",
          operation: `${req.method} ${path}`,
          outcome: "denied",
          status,
          reason: "UNAUTHORIZED",
        })
      }
      return json(body, status)
    }
  },
})

// Reload principals and calendars without a restart, so revoking an agent does
// not interrupt the others. Also drops the cached key, which is what makes a
// rotated sa-key.json take effect.
process.on("SIGHUP", () => {
  registry = loadRegistry(config)
  auth.reset()
  log("registry reloaded via SIGHUP", {
    principals: registry.principals.size,
    calendars: registry.calendars.size,
    problems: registry.errors.length,
  })
  for (const problem of registry.errors) log("registry problem", { problem })
})

log("calendar-gate listening", {
  host: config.host,
  port: server.port,
  principals: registry.principals.size,
  calendars: registry.calendars.size,
  timezone: config.defaultTimezone,
})
