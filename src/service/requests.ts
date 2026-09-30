/**
 * service/requests.ts — raw JSON arguments to typed requests.
 *
 * Each operation receives an untyped object from REST or MCP. It is parsed
 * here, once, into a request whose fields are already the right type, so the
 * operations never reach back into the raw body to ask whether a flag is
 * `=== true` or a string is a string.
 *
 * Deliberately not here: calendar_ids and group_id. Resolving calendars is
 * authorization, not parsing, and it runs before these parsers so that a
 * denied calendar is reported as a denial even when the rest of the request is
 * also wrong. Pure module: no clock, no network.
 */

import { isViolation, parseTimestamp, validateEventInput } from "../core/policy"
import { isValidTimezone } from "../core/timezone"
import type { EventInput } from "../types"
import { ApiError } from "./errors"

export type Args = Record<string, unknown>

export interface Defaults {
  timezone: string
}

export interface Window {
  timeMin: string
  timeMax: string
}

export interface SearchRequest {
  window: Window
  timezone: string
  query?: string
}

export interface ConflictRequest {
  start: string
  end: string
  startMs: number
  endMs: number
  timezone: string
  ignoreEventId?: string
  ignoreGroupId?: string
  partialOk: boolean
}

export interface FreeSlotsRequest {
  window: Window
  timezone: string
  durationMinutes: number
  weekdays?: number[]
  businessStart?: string
  businessEnd?: string
  maxResults: number
  ignoreAllDay: boolean
  partialOk: boolean
}

/** What both write operations share besides the event itself. */
export interface WriteFlags {
  allowPast: boolean
  allowConflict: boolean
  dryRun: boolean
  partialOk: boolean
}

export interface CreateRequest extends WriteFlags {
  event: EventInput
  /** Absent when the caller sent none; the operation then makes one up. */
  idempotencyKey?: string
}

export interface UpdateRequest extends WriteFlags {
  /** start and end are empty when the update does not move the event. */
  event: EventInput
}

const YEAR_MS = 366 * 24 * 60 * 60 * 1000

/** A trimmed non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Only a literal `true` counts: a flag that says "yes" must not be a typo away. */
const flag = (value: unknown): boolean => value === true

function writeFlags(body: Args): WriteFlags {
  return {
    allowPast: flag(body.allow_past),
    allowConflict: flag(body.allow_conflict),
    dryRun: flag(body.dry_run),
    partialOk: flag(body.partial_ok),
  }
}

function checkedTimezone(tz: string): string {
  if (!isValidTimezone(tz)) throw new ApiError("INVALID_INPUT", `unknown timezone "${tz}"`, 400)
  return tz
}

export function parseTimezone(body: Args, defaults: Defaults): string {
  return checkedTimezone(text(body.timezone) ?? defaults.timezone)
}

export function parseWindow(body: Args): Window {
  const min = parseTimestamp(body.time_min, "time_min")
  if (isViolation(min)) throw ApiError.from(min)
  const max = parseTimestamp(body.time_max, "time_max")
  if (isViolation(max)) throw ApiError.from(max)
  if (max.ms <= min.ms) throw new ApiError("INVALID_INPUT", "time_max must be after time_min", 400)
  if (max.ms - min.ms > YEAR_MS) throw new ApiError("INVALID_INPUT", "the window is longer than a year", 400)
  return { timeMin: String(body.time_min), timeMax: String(body.time_max) }
}

export function parseSearch(body: Args, defaults: Defaults): SearchRequest {
  const window = parseWindow(body)
  return { window, timezone: parseTimezone(body, defaults), query: text(body.query) }
}

export function parseConflictCheck(body: Args, defaults: Defaults): ConflictRequest {
  const timezone = parseTimezone(body, defaults)
  const start = parseTimestamp(body.start, "start")
  if (isViolation(start)) throw ApiError.from(start)
  const end = parseTimestamp(body.end, "end")
  if (isViolation(end)) throw ApiError.from(end)
  if (end.ms <= start.ms) throw new ApiError("INVALID_INPUT", "end must be after start", 400)

  return {
    start: String(body.start),
    end: String(body.end),
    startMs: start.ms,
    endMs: end.ms,
    timezone,
    ignoreEventId: typeof body.ignore_event_id === "string" ? body.ignore_event_id : undefined,
    ignoreGroupId: typeof body.ignore_group_id === "string" ? body.ignore_group_id : undefined,
    partialOk: flag(body.partial_ok),
  }
}

export function parseFreeSlots(body: Args, defaults: Defaults): FreeSlotsRequest {
  const window = parseWindow(body)
  const timezone = parseTimezone(body, defaults)

  const durationMinutes = Number(body.duration_minutes ?? 60)
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 24 * 60) {
    throw new ApiError("INVALID_INPUT", "duration_minutes must be between 1 and 1440", 400)
  }

  return {
    window,
    timezone,
    durationMinutes,
    weekdays: Array.isArray(body.weekdays)
      ? body.weekdays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      : undefined,
    businessStart: typeof body.business_start === "string" ? body.business_start : undefined,
    businessEnd: typeof body.business_end === "string" ? body.business_end : undefined,
    maxResults: Number(body.max_results ?? 20),
    ignoreAllDay: flag(body.ignore_all_day),
    partialOk: flag(body.partial_ok),
  }
}

export function parseCreate(body: Args, defaults: Defaults): CreateRequest {
  const event = validateEventInput(body, defaults)
  if (isViolation(event)) throw ApiError.from(event)
  checkedTimezone(event.timezone)
  return { event, idempotencyKey: text(body.idempotency_key), ...writeFlags(body) }
}

export function parseUpdate(body: Args, defaults: Defaults): UpdateRequest {
  const event = validateEventInput(body, defaults, { requireTimes: false })
  if (isViolation(event)) throw ApiError.from(event)
  checkedTimezone(event.timezone)
  return { event, ...writeFlags(body) }
}
