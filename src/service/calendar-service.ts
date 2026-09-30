/**
 * service/calendar-service.ts — the business rules of calendar-gate.
 *
 * Every operation both transports offer lives here, and only here: the REST
 * routes and the MCP tools call the same functions, so the two can never drift
 * apart. Nothing in this module reads the environment, opens a socket or
 * touches the clock directly — all of it arrives through `deps`, which is what
 * lets the tests drive a full create or update against a fake Google.
 */

import {
  busyFromEvents,
  busyFromFreeBusy,
  conflictsIn,
  eventWindow,
  findFreeSlots,
  toSpan,
} from "../core/conflicts"
import { buildEventBody, buildPatchBody, planFanout, summarizeFanout, transparencyFor } from "../core/fanout"
import { randomIdempotencyKey } from "../core/idempotency"
import {
  checkDateGuard,
  checkWritableAccess,
  isViolation,
  parseTimestamp,
  validateEventInput,
  type WriteLimiter,
} from "../core/policy"
import { isValidTimezone } from "../core/timezone"
import type { Config } from "../config"
import { AuthError } from "../google/auth"
import { CalendarApiError, type CalendarClient } from "../google/calendar"
import type { AuditLog } from "../logger"
import { calendarsOf, canWrite, describePrincipal, resolveCalendar, type Registry } from "../principals"
import type { BusyBlock, CalendarEntry, EventInput, FanoutResult, Principal } from "../types"
import type { Alerts } from "./alerts"
import { ApiError } from "./errors"

type Args = Record<string, unknown>

/** What the transports call. One method per MCP tool / REST route. */
export interface Handlers {
  listCalendars(principal: Principal): Promise<unknown>
  searchEvents(principal: Principal, args: Args): Promise<unknown>
  checkConflicts(principal: Principal, args: Args): Promise<unknown>
  findFreeSlots(principal: Principal, args: Args): Promise<unknown>
  createEvent(principal: Principal, args: Args): Promise<unknown>
  updateEvent(principal: Principal, args: Args): Promise<unknown>
}

/** The slice of the Google client the rules use. A test hands in a fake. */
export type CalendarPort = Pick<
  CalendarClient,
  "listEvents" | "freeBusy" | "insertEvent" | "patchEvent" | "findByGroupId"
>

export interface ServiceDeps {
  config: Pick<Config, "defaultTimezone" | "maxPastHours" | "maxFutureDays">
  calendar: CalendarPort
  /** A getter, not a value: SIGHUP swaps the registry under a running service. */
  registry: () => Registry
  limiter: WriteLimiter
  audit: AuditLog
  alerts: Pick<Alerts, "notify">
  now?: () => number
}

export function createCalendarService(deps: ServiceDeps): Handlers {
  const now = deps.now ?? Date.now

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
      return calendarsOf(deps.registry(), principal)
    }
    if (!Array.isArray(refs) || refs.length === 0) {
      throw new ApiError("INVALID_INPUT", "calendar_ids must be a non-empty array", 400)
    }

    const out: CalendarEntry[] = []
    for (const ref of refs) {
      const cal = typeof ref === "string" ? resolveCalendar(deps.registry(), principal, ref) : null
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

  function requireWindow(body: Args): { timeMin: string; timeMax: string } {
    const min = parseTimestamp(body.time_min, "time_min")
    if (isViolation(min)) throw ApiError.from(min)
    const max = parseTimestamp(body.time_max, "time_max")
    if (isViolation(max)) throw ApiError.from(max)
    if (max.ms <= min.ms) throw new ApiError("INVALID_INPUT", "time_max must be after time_min", 400)
    if (max.ms - min.ms > 366 * 24 * 60 * 60 * 1000) {
      throw new ApiError("INVALID_INPUT", "the window is longer than a year", 400)
    }
    return { timeMin: String(body.time_min), timeMax: String(body.time_max) }
  }

  function timezoneOf(body: Args): string {
    const tz = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : deps.config.defaultTimezone
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
    opts: { ignoreEventId?: string; ignoreGroupId?: string; query?: string; includeFree?: boolean } = {}
  ): Promise<{ blocks: BusyBlock[]; errors: Array<{ calendar: string; error: string }> }> {
    const blocks: BusyBlock[] = []
    const errors: Array<{ calendar: string; error: string }> = []

    const detailed = calendars.filter((c) => c.access === "details")
    const busyOnly = calendars.filter((c) => c.access === "busy_only")

    await Promise.all(
      detailed.map(async (cal) => {
        try {
          const events = await deps.calendar.listEvents(cal.id, {
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
        const result = await deps.calendar.freeBusy({
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
    body: Args
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

  // ───────────────────────────────────────────────────────────────── operations

  async function opListCalendars(principal: Principal) {
    // Answered from local config on purpose: no calendarList call, so this never
    // reveals a calendar shared with the service account for someone else's use.
    return describePrincipal(deps.registry(), principal)
  }

  async function opSearchEvents(principal: Principal, body: Args) {
    const calendars = resolveAll(principal, body.calendar_ids, { required: false })
    const window = requireWindow(body)
    const timezone = timezoneOf(body)
    const query = typeof body.query === "string" && body.query.trim() ? body.query.trim() : undefined

    const { blocks, errors } = await collectBusy(calendars, window, timezone, { query, includeFree: true })
    return {
      time_min: window.timeMin,
      time_max: window.timeMax,
      timezone,
      events: blocks,
      ...(errors.length ? { calendar_errors: errors } : {}),
    }
  }

  async function opCheckConflicts(principal: Principal, body: Args) {
    const calendars = resolveAll(principal, body.calendar_ids, { required: false })
    const timezone = timezoneOf(body)

    const start = parseTimestamp(body.start, "start")
    if (isViolation(start)) throw ApiError.from(start)
    const end = parseTimestamp(body.end, "end")
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

  async function opFindFreeSlots(principal: Principal, body: Args) {
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

    const { blocks: allBlocks, errors } = await collectBusy(calendars, window, timezone)
    assertComplete(errors, body)

    // An all-day event marked busy takes out every working hour it touches. That
    // is right for a holiday and wrong for a fair someone just wanted on the
    // calendar, and only the person can tell which: so name those events in the
    // answer instead of returning a bare empty list, and let the agent resend
    // with ignore_all_day once the person says they do not block anything.
    const ignoreAllDay = body.ignore_all_day === true
    const allDayBlocks = allBlocks.filter((b) => b.all_day)
    const blocks = ignoreAllDay ? allBlocks.filter((b) => !b.all_day) : allBlocks

    const slots = findFreeSlots(blocks, {
      windowStart: window.timeMin,
      windowEnd: window.timeMax,
      durationMinutes: duration,
      timezone,
      businessStart: typeof body.business_start === "string" ? body.business_start : undefined,
      businessEnd: typeof body.business_end === "string" ? body.business_end : undefined,
      weekdays,
      now: now(),
      maxResults: Number(body.max_results ?? 20),
    })

    return {
      timezone,
      duration_minutes: duration,
      calendars_checked: calendars.map((c) => c.alias),
      slots,
      ...(allDayBlocks.length
        ? {
            all_day_blocks: allDayBlocks,
            note: ignoreAllDay
              ? "all-day events were ignored as requested; the slots above disregard them."
              : "these all-day events are marked busy and were treated as blocking every working hour of their days. " +
                "If one does not actually keep the person from meeting (a fair, a trip of someone else, a reminder), " +
                "ask them, and resend with ignore_all_day: true.",
          }
        : {}),
      ...(errors.length ? { calendar_errors: errors } : {}),
    }
  }

  // ─────────────────────────────────────────────────────────────── write steps
  //
  // create_event and update_event run the same gauntlet — date guard, conflict
  // check, write cap, fan-out with refunds — and each step lives once, here.

  type AuditExtra = { calendars?: string[]; group_id?: string }

  /**
   * Audits a refusal with the context only a write path has (the calendars, the
   * group), then marks it so run() does not log it a second time.
   */
  async function refuse(principal: Principal, operation: string, error: ApiError, extra: AuditExtra): Promise<never> {
    await audit(principal, operation, "denied", error.status, { ...extra, reason: error.code })
    error.audited = true
    throw error
  }

  function guardDate(start: string, body: Args): void {
    const denied = checkDateGuard(start, {
      maxPastHours: deps.config.maxPastHours,
      maxFutureDays: deps.config.maxFutureDays,
      allowPast: body.allow_past === true,
      now: now(),
    })
    if (denied) throw ApiError.from(denied)
  }

  /**
   * Refuses with 409 when the event would overlap something. Checked against
   * the same calendars the event lands on, ignoring the event's own copies, so
   * a retry or a small shift does not collide with itself.
   */
  async function refuseConflicts(
    principal: Principal,
    operation: string,
    calendars: CalendarEntry[],
    input: EventInput,
    opts: { groupId: string; body: Args; audit: AuditExtra; message: string }
  ): Promise<void> {
    const window = eventWindow(input)
    const { blocks, errors } = await collectBusy(calendars, window, input.timezone, { ignoreGroupId: opts.groupId })
    // Writing after a failed conflict check would be scheduling blind.
    assertComplete(errors, opts.body)
    const conflicts = conflictsIn(blocks, toSpan({ start: window.timeMin, end: window.timeMax }))
    if (conflicts.length) {
      await refuse(principal, operation, new ApiError("CONFLICT", opts.message, 409, { conflicts }), opts.audit)
    }
  }

  /** Charges the write cap. A fan-out costs one write per copy. */
  async function chargeWrites(principal: Principal, operation: string, cost: number, extra: AuditExtra): Promise<void> {
    const decision = deps.limiter.consume(cost, now())
    if (decision.allowed) return
    if (decision.firstBreach) {
      void deps.alerts.notify(
        `calendar-gate: write limit hit by "${principal.name}" on ${operation} (${decision.violation?.code}). ` +
          "Nothing was written. An agent may be looping."
      )
    }
    await refuse(principal, operation, ApiError.from(decision.violation!), extra)
  }

  /**
   * One write per copy, in order, each failure caught and reported rather than
   * aborting the rest. The copies that failed wrote nothing, so they go back to
   * the cap.
   */
  async function writeEach<T>(items: T[], write: (item: T) => Promise<FanoutResult>): Promise<FanoutResult[]> {
    const results: FanoutResult[] = []
    for (const item of items) results.push(await write(item))
    const failed = results.filter((r) => !r.ok).length
    if (failed) deps.limiter.refund(failed)
    return results
  }

  // ─────────────────────────────────────────────────────────── write operations

  async function opCreateEvent(principal: Principal, body: Args) {
    requireWrite(principal)

    // Every calendar is resolved and checked before a single copy is written.
    const calendars = resolveAll(principal, body.calendar_ids, { required: true })
    for (const cal of calendars) {
      const denied = checkWritableAccess(cal.alias, cal.access)
      if (denied) throw ApiError.from(denied)
    }

    const input = validateEventInput(body, { timezone: deps.config.defaultTimezone })
    if (isViolation(input)) throw ApiError.from(input)
    if (!isValidTimezone(input.timezone)) {
      throw new ApiError("INVALID_INPUT", `unknown timezone "${input.timezone}"`, 400)
    }
    guardDate(input.start, body)

    const idempotencyKey =
      typeof body.idempotency_key === "string" && body.idempotency_key.trim()
        ? body.idempotency_key.trim()
        : randomIdempotencyKey()
    const plan = planFanout(calendars, idempotencyKey)
    const auditExtra = { calendars: calendars.map((c) => c.alias), group_id: plan.groupId }

    // An event shown as free takes nobody's time, so it is not checked at all.
    if (body.allow_conflict !== true && transparencyFor(input) === "opaque") {
      await refuseConflicts(principal, "create_event", calendars, input, {
        groupId: plan.groupId,
        body,
        audit: auditExtra,
        message: "the requested time overlaps existing events. Send allow_conflict: true to schedule anyway.",
      })
    }

    await chargeWrites(principal, "create_event", plan.targets.length, auditExtra)

    if (body.dry_run === true) {
      deps.limiter.refund(plan.targets.length)
      await audit(principal, "create_event", "dry_run", 200, auditExtra)
      return {
        dry_run: true,
        group_id: plan.groupId,
        idempotency_key: idempotencyKey,
        would_create: plan.targets.map((t) => ({ calendar: t.alias, event_id: t.eventId })),
        event: buildEventBody(input, plan.groupId),
      }
    }

    const eventBody = buildEventBody(input, plan.groupId, { created_by: principal.name })
    const results = await writeEach(plan.targets, async (target) => {
      const where = { calendar: target.alias, calendar_id: target.calendarId }
      try {
        const created = await deps.calendar.insertEvent(target.calendarId, target.eventId, eventBody)
        return {
          ...where,
          ok: true,
          created: true,
          event_id: created.id ?? target.eventId,
          ...(created.htmlLink ? { html_link: created.htmlLink } : {}),
        }
      } catch (e) {
        // The retry case: the id is derived from the idempotency key, so a 409
        // is our own earlier write, not someone else's event.
        if (e instanceof CalendarApiError && e.isAlreadyExists) {
          return { ...where, ok: true, created: false, event_id: target.eventId }
        }
        const cal: CalendarEntry = { alias: target.alias, id: target.calendarId, access: "details" }
        return { ...where, ok: false, error: describeCalendarError(e, cal) }
      }
    })

    const summary = summarizeFanout(plan.groupId, results)
    await audit(principal, "create_event", summary.ok ? "ok" : "error", summary.status, {
      ...auditExtra,
      event_ids: results.filter((r) => r.event_id).map((r) => r.event_id!),
    })

    return { ...summary, idempotency_key: idempotencyKey }
  }

  async function opUpdateEvent(principal: Principal, groupId: string, body: Args) {
    requireWrite(principal)
    if (!groupId.trim()) throw new ApiError("INVALID_INPUT", "group_id is required", 400)

    const calendars = resolveAll(principal, body.calendar_ids, { required: false }).filter(
      (c) => c.access === "details"
    )
    if (!calendars.length) {
      throw new ApiError("NO_WRITABLE_CALENDAR", "this principal reaches no writable calendar", 403)
    }

    const input = validateEventInput(body, { timezone: deps.config.defaultTimezone }, { requireTimes: false })
    if (isViolation(input)) throw ApiError.from(input)

    const movingTimes = Boolean(input.start && input.end)
    if (movingTimes) guardDate(input.start, body)

    // Locate the copies first: an update that matches nothing is a 404, not a
    // silent success.
    const found: Array<{ cal: CalendarEntry; eventId: string; free: boolean }> = []
    const errors: Array<{ calendar: string; error: string }> = []
    await Promise.all(
      calendars.map(async (cal) => {
        try {
          for (const event of await deps.calendar.findByGroupId(cal.id, groupId)) {
            if (event.id) found.push({ cal, eventId: event.id, free: event.transparency === "transparent" })
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

    // Free after the update, whether asked now or already so: nothing to collide.
    const staysFree = input.show_as ? input.show_as === "free" : found.every((f) => f.free)
    if (movingTimes && body.allow_conflict !== true && !staysFree) {
      await refuseConflicts(principal, "update_event", calendars, input, {
        groupId,
        body,
        audit: { group_id: groupId },
        message: "the new time overlaps existing events. Send allow_conflict: true to move it anyway.",
      })
    }

    const patch = buildPatchBody(input)
    if (!Object.keys(patch).length) {
      throw new ApiError("INVALID_INPUT", "nothing to update: send summary, description, location, show_as or start+end", 400)
    }

    await chargeWrites(principal, "update_event", found.length, { group_id: groupId })

    if (body.dry_run === true) {
      deps.limiter.refund(found.length)
      return {
        dry_run: true,
        group_id: groupId,
        would_update: found.map((f) => ({ calendar: f.cal.alias, event_id: f.eventId })),
        patch,
      }
    }

    const results = await writeEach(found, async ({ cal, eventId }) => {
      const where = { calendar: cal.alias, calendar_id: cal.id, event_id: eventId }
      try {
        const updated = await deps.calendar.patchEvent(cal.id, eventId, patch)
        return { ...where, ok: true, updated: true, ...(updated.htmlLink ? { html_link: updated.htmlLink } : {}) }
      } catch (e) {
        return { ...where, ok: false, error: describeCalendarError(e, cal) }
      }
    })

    // A full success answers 200 here, where create answers 201.
    const summary = summarizeFanout(groupId, results)
    const status = summary.ok ? 200 : summary.status
    await audit(principal, "update_event", summary.ok ? "ok" : "error", status, {
      calendars: [...new Set(results.map((r) => r.calendar))],
      group_id: groupId,
      event_ids: results.map((r) => r.event_id!).filter(Boolean),
    })

    return { ...summary, status, ...(errors.length ? { calendar_errors: errors } : {}) }
  }

  async function audit(
    principal: Principal,
    operation: string,
    outcome: "ok" | "denied" | "error" | "dry_run",
    status: number,
    extra: { calendars?: string[]; group_id?: string; event_ids?: string[]; reason?: string } = {}
  ): Promise<void> {
    await deps.audit.append({
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

  return {
    listCalendars: (p) => run(p, "list_calendars", () => opListCalendars(p)),
    searchEvents: (p, args) => run(p, "search_events", () => opSearchEvents(p, args)),
    checkConflicts: (p, args) => run(p, "check_conflicts", () => opCheckConflicts(p, args)),
    findFreeSlots: (p, args) => run(p, "find_free_slots", () => opFindFreeSlots(p, args)),
    createEvent: (p, args) => run(p, "create_event", () => opCreateEvent(p, args)),
    updateEvent: (p, args) =>
      run(p, "update_event", () => opUpdateEvent(p, String(args.group_id ?? ""), args)),
  }
}
