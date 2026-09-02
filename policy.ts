/**
 * policy.ts — the guards, isolated from transport so they can be tested without
 * a server and without Google.
 *
 * Everything here exists for one sentence in the plan: an agent that is
 * hallucinating, or someone who got into the machine, must not be able to do
 * damage. The guards are deliberately redundant with Google's own sharing
 * model; the redundancy is the point.
 */

import type { Access, EventInput } from "./types"

export interface PolicyViolation {
  code: string
  message: string
  status: number
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

// ─────────────────────────────────────────────────────────── input validation

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function parseInstant(value: unknown, field: string): { ms: number } | PolicyViolation {
  if (typeof value !== "string" || !value.trim()) {
    return { code: "INVALID_INPUT", message: `${field} is required`, status: 400 }
  }
  const raw = value.trim()
  if (!RFC3339_WITH_OFFSET.test(raw) && !DATE_ONLY.test(raw)) {
    return {
      code: "INVALID_INPUT",
      message:
        `${field} must be RFC3339 with an explicit offset (2026-08-30T14:00:00-03:00) ` +
        `or a plain date (2026-08-30) for an all-day event`,
      status: 400,
    }
  }
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) {
    return { code: "INVALID_INPUT", message: `${field} is not a valid date`, status: 400 }
  }
  return { ms }
}

export function isViolation(x: unknown): x is PolicyViolation {
  return typeof x === "object" && x !== null && "code" in x && "status" in x
}

/**
 * Validates a create/update payload. Attendees are rejected here rather than
 * being dropped: a service account without Domain-Wide Delegation gets a bare
 * 403 from Google, and an agent that is told the real rule stops retrying.
 */
export function validateEventInput(
  body: Record<string, unknown>,
  defaults: { timezone: string },
  opts: { requireTimes: boolean } = { requireTimes: true }
): EventInput | PolicyViolation {
  if ("attendees" in body || "guests" in body) {
    return {
      code: "ATTENDEES_NOT_SUPPORTED",
      message:
        "attendees are not supported: this service uses a service account, which cannot invite. " +
        "To include someone, list their calendar in calendar_ids — the event is created on each " +
        "person's own calendar and the copies stay linked by group_id. There is no RSVP.",
      status: 400,
    }
  }

  const summary = typeof body.summary === "string" ? body.summary.trim() : ""
  if (opts.requireTimes && !summary) {
    return { code: "INVALID_INPUT", message: "summary is required", status: 400 }
  }
  if (summary.length > 1024) {
    return { code: "INVALID_INPUT", message: "summary is longer than 1024 characters", status: 400 }
  }

  const startRaw = body.start
  const endRaw = body.end
  if (!opts.requireTimes && startRaw === undefined && endRaw === undefined) {
    return {
      summary,
      start: "",
      end: "",
      timezone: typeof body.timezone === "string" ? body.timezone : defaults.timezone,
      all_day: false,
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.location === "string" ? { location: body.location } : {}),
    }
  }

  const start = parseInstant(startRaw, "start")
  if (isViolation(start)) return start
  const end = parseInstant(endRaw, "end")
  if (isViolation(end)) return end

  const allDay = DATE_ONLY.test(String(startRaw).trim())
  if (allDay !== DATE_ONLY.test(String(endRaw).trim())) {
    return {
      code: "INVALID_INPUT",
      message: "start and end must both be plain dates (all-day) or both be timestamps",
      status: 400,
    }
  }

  if (end.ms <= start.ms) {
    return { code: "INVALID_INPUT", message: "end must be after start", status: 400 }
  }
  if (end.ms - start.ms > 30 * DAY_MS) {
    return { code: "INVALID_INPUT", message: "event is longer than 30 days", status: 400 }
  }

  const timezone = typeof body.timezone === "string" && body.timezone.trim()
    ? body.timezone.trim()
    : defaults.timezone

  return {
    summary,
    start: String(startRaw).trim(),
    end: String(endRaw).trim(),
    timezone,
    all_day: allDay,
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    ...(typeof body.location === "string" ? { location: body.location } : {}),
  }
}

// ────────────────────────────────────────────────────────────────── date guard

export interface DateGuardOptions {
  maxPastHours: number
  maxFutureDays: number
  allowPast?: boolean
  now: number
}

/**
 * Catches the year typo and the timezone slip: an event landing far in the past
 * is almost never intended, and one landing years ahead is almost always a
 * mis-parsed date. Both are cheap to override explicitly, and expensive to
 * discover later.
 */
export function checkDateGuard(start: string, opts: DateGuardOptions): PolicyViolation | null {
  const parsed = parseInstant(start, "start")
  if (isViolation(parsed)) return parsed

  const pastLimit = opts.now - opts.maxPastHours * HOUR_MS
  if (parsed.ms < pastLimit && !opts.allowPast) {
    return {
      code: "START_IN_PAST",
      message:
        `start is more than ${opts.maxPastHours}h in the past. ` +
        "If that is intended (backfilling a past event), send allow_past: true.",
      status: 400,
    }
  }

  const futureLimit = opts.now + opts.maxFutureDays * DAY_MS
  if (parsed.ms > futureLimit) {
    return {
      code: "START_TOO_FAR",
      message:
        `start is more than ${opts.maxFutureDays} days ahead. ` +
        "Check the year and the timezone before retrying.",
      status: 400,
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────── write limiter

export interface LimiterDecision {
  allowed: boolean
  /** Set when denied. */
  violation?: PolicyViolation
  /** True the first time a cap is crossed, so the alert fires once per window. */
  firstBreach?: boolean
  remainingMinute: number
  remainingDay: number
}

/**
 * Sliding-window cap on writes. A fan-out to three calendars costs three, not
 * one — the cap exists to bound how much an agent in a loop can do, and a loop
 * writing to three calendars does three times the damage.
 *
 * The clock is injected so the tests do not sleep.
 */
export class WriteLimiter {
  private stamps: number[] = []
  private breachedMinute = false
  private breachedDay = false

  constructor(
    private readonly perMinute: number,
    private readonly perDay: number
  ) {}

  private prune(now: number): void {
    const cutoff = now - DAY_MS
    if (this.stamps.length && this.stamps[0]! < cutoff) {
      this.stamps = this.stamps.filter((t) => t >= cutoff)
    }
  }

  private countSince(now: number, window: number): number {
    const cutoff = now - window
    let n = 0
    for (let i = this.stamps.length - 1; i >= 0; i--) {
      if (this.stamps[i]! < cutoff) break
      n++
    }
    return n
  }

  /** Reserves `cost` writes, or denies the whole batch. Never partially. */
  consume(cost: number, now: number): LimiterDecision {
    this.prune(now)
    const inMinute = this.countSince(now, 60_000)
    const inDay = this.stamps.length

    const remainingMinute = Math.max(0, this.perMinute - inMinute)
    const remainingDay = Math.max(0, this.perDay - inDay)

    if (cost > remainingDay) {
      const firstBreach = !this.breachedDay
      this.breachedDay = true
      return {
        allowed: false,
        firstBreach,
        remainingMinute,
        remainingDay,
        violation: {
          code: "DAILY_LIMIT",
          message: `daily write limit reached (${this.perDay}/day). ${inDay} used.`,
          status: 429,
        },
      }
    }

    if (cost > remainingMinute) {
      const firstBreach = !this.breachedMinute
      this.breachedMinute = true
      return {
        allowed: false,
        firstBreach,
        remainingMinute,
        remainingDay,
        violation: {
          code: "RATE_LIMIT",
          message: `write rate limit reached (${this.perMinute}/min). Retry in under a minute.`,
          status: 429,
        },
      }
    }

    for (let i = 0; i < cost; i++) this.stamps.push(now)
    this.breachedMinute = false
    if (this.stamps.length < this.perDay) this.breachedDay = false

    return {
      allowed: true,
      remainingMinute: remainingMinute - cost,
      remainingDay: remainingDay - cost,
    }
  }

  /** Gives back writes that never happened, e.g. a dry run or a failed fan-out. */
  refund(cost: number): void {
    for (let i = 0; i < cost && this.stamps.length; i++) this.stamps.pop()
  }

  snapshot(now: number): { used_last_minute: number; used_today: number } {
    this.prune(now)
    return { used_last_minute: this.countSince(now, 60_000), used_today: this.stamps.length }
  }
}

// ───────────────────────────────────────────────────────────────── access rule

/** A calendar shared as availability only can never be written to. */
export function checkWritableAccess(alias: string, access: Access): PolicyViolation | null {
  if (access === "busy_only") {
    return {
      code: "READ_ONLY_CALENDAR",
      message:
        `calendar "${alias}" was shared as availability only, so it cannot be written to. ` +
        "Its owner has to raise the share level in Google Calendar for that to change.",
      status: 403,
    }
  }
  return null
}
