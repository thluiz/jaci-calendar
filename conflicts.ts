/**
 * conflicts.ts — overlap detection and free-slot search.
 *
 * Pure functions over lists of intervals: nothing here talks to Google, so the
 * awkward cases (touching intervals, all-day blocks, an event moved onto its
 * own slot) are covered by unit tests instead of by trial and error against a
 * real calendar.
 */

import type { Access, BusyBlock, GoogleEvent } from "./types"
import { dateOnlyToInstant, parseClock, toRfc3339, wallToInstant, zonedParts } from "./timezone"

export interface Span {
  startMs: number
  endMs: number
}

/**
 * Events Google injects that are not commitments. Left in, they would produce a
 * conflict every single day — "working location: home" collides with
 * everything, and so does a birthday.
 */
const NON_BLOCKING_EVENT_TYPES = new Set(["workingLocation", "birthday", "fromGmail", "focusTime"])

/** Touching is not overlapping: an event ending at 15:00 leaves 15:00 free. */
export function overlaps(a: Span, b: Span): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs
}

/**
 * Turns a Google event into a span. All-day events use exclusive end dates, so
 * a single-day event reads as `date: 2026-08-30` to `date: 2026-08-31`, which
 * is already the right span once both are converted in the calendar's zone.
 */
export function eventSpan(event: GoogleEvent, timeZone: string): Span | null {
  const start = event.start
  const end = event.end
  if (!start || !end) return null

  if (start.dateTime && end.dateTime) {
    const startMs = Date.parse(start.dateTime)
    const endMs = Date.parse(end.dateTime)
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
    return { startMs, endMs }
  }

  if (start.date && end.date) {
    const zone = start.timeZone || timeZone
    return { startMs: dateOnlyToInstant(start.date, zone), endMs: dateOnlyToInstant(end.date, zone) }
  }

  return null
}

export interface BusyFilterOptions {
  /** Event id to skip, so moving an event does not collide with itself. */
  ignoreEventId?: string
  /** group_id to skip, which is the same idea across the copies of a fan-out. */
  ignoreGroupId?: string
}

/** True when this event should count as busy time. */
export function isBlocking(event: GoogleEvent, opts: BusyFilterOptions = {}): boolean {
  if (event.status === "cancelled") return false
  // "transparent" is Google's word for "show me as available" — the owner said
  // it is not a commitment, and all-day events default to it.
  if (event.transparency === "transparent") return false
  if (event.eventType && NON_BLOCKING_EVENT_TYPES.has(event.eventType)) return false
  if (event.attendees?.some((a) => a.self && a.responseStatus === "declined")) return false
  if (opts.ignoreEventId && event.id === opts.ignoreEventId) return false
  if (opts.ignoreGroupId && event.extendedProperties?.private?.group_id === opts.ignoreGroupId) {
    return false
  }
  return true
}

/** Busy blocks from a detailed event list. Titles survive; that is the point. */
export function busyFromEvents(
  events: GoogleEvent[],
  calendarAlias: string,
  timeZone: string,
  opts: BusyFilterOptions = {}
): BusyBlock[] {
  const out: BusyBlock[] = []
  for (const event of events) {
    if (!isBlocking(event, opts)) continue
    const span = eventSpan(event, timeZone)
    if (!span) continue
    out.push({
      calendar: calendarAlias,
      detail: "details",
      start: toRfc3339(span.startMs, timeZone),
      end: toRfc3339(span.endMs, timeZone),
      ...(event.id ? { event_id: event.id } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.start?.date ? { all_day: true } : {}),
    })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * Busy blocks from a freeBusy response: intervals and nothing else. The
 * `detail` marker travels with them so the agent knows there is no title to
 * report and says only "busy from 14:00 to 15:00".
 */
export function busyFromFreeBusy(
  intervals: Array<{ start: string; end: string }>,
  calendarAlias: string,
  timeZone: string
): BusyBlock[] {
  return intervals
    .map((i) => ({
      calendar: calendarAlias,
      detail: "busy_only" as Access,
      start: toRfc3339(Date.parse(i.start), timeZone),
      end: toRfc3339(Date.parse(i.end), timeZone),
    }))
    .filter((b) => !b.start.includes("NaN") && !b.end.includes("NaN"))
    .sort((a, b) => a.start.localeCompare(b.start))
}

export function toSpan(block: { start: string; end: string }): Span {
  return { startMs: Date.parse(block.start), endMs: Date.parse(block.end) }
}

/** Blocks overlapping the given window. */
export function conflictsIn(blocks: BusyBlock[], window: Span): BusyBlock[] {
  return blocks.filter((b) => overlaps(toSpan(b), window))
}

export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans]
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const out: Span[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    // Touching spans merge here (>=), unlike in overlaps(): two back-to-back
    // meetings leave no usable gap between them.
    if (last && span.startMs <= last.endMs) {
      if (span.endMs > last.endMs) last.endMs = span.endMs
    } else {
      out.push({ ...span })
    }
  }
  return out
}

/** The parts of `window` not covered by `busy`. */
export function subtractSpans(window: Span, busy: Span[]): Span[] {
  const free: Span[] = []
  let cursor = window.startMs
  for (const span of mergeSpans(busy)) {
    if (span.endMs <= cursor) continue
    if (span.startMs >= window.endMs) break
    if (span.startMs > cursor) free.push({ startMs: cursor, endMs: Math.min(span.startMs, window.endMs) })
    cursor = Math.max(cursor, span.endMs)
    if (cursor >= window.endMs) break
  }
  if (cursor < window.endMs) free.push({ startMs: cursor, endMs: window.endMs })
  return free
}

export interface FreeSlotOptions {
  windowStart: string
  windowEnd: string
  durationMinutes: number
  timezone: string
  /** Wall-clock "HH:MM" bounds of the working day. */
  businessStart?: string
  businessEnd?: string
  /** 0 = Sunday. Defaults to Monday through Friday. */
  weekdays?: number[]
  /** Slots must start at least this far from `now`. */
  now?: number
  maxResults?: number
}

export interface FreeSlot {
  start: string
  end: string
  duration_minutes: number
}

/**
 * Free gaps inside the working hours of each day in the window, long enough for
 * `durationMinutes`. Returns the gaps themselves, not every possible start time
 * inside them: an agent proposing a time reads a gap better than a list of 96
 * overlapping candidates.
 */
export function findFreeSlots(busy: BusyBlock[], opts: FreeSlotOptions): FreeSlot[] {
  const tz = opts.timezone
  const windowStart = Date.parse(opts.windowStart)
  const windowEnd = Date.parse(opts.windowEnd)
  if (Number.isNaN(windowStart) || Number.isNaN(windowEnd) || windowEnd <= windowStart) return []

  const durationMs = Math.max(1, opts.durationMinutes) * 60_000
  const weekdays = opts.weekdays?.length ? opts.weekdays : [1, 2, 3, 4, 5]
  const dayStartMin = parseClock(opts.businessStart ?? "09:00") ?? 9 * 60
  const dayEndMin = parseClock(opts.businessEnd ?? "18:00") ?? 18 * 60
  const floor = Math.max(windowStart, opts.now ?? windowStart)
  const busySpans = mergeSpans(busy.map(toSpan).filter((s) => !Number.isNaN(s.startMs)))
  const maxResults = opts.maxResults ?? 50

  const slots: FreeSlot[] = []
  // Walk day by day in the calendar's zone rather than in 24h steps: a DST day
  // is 23 or 25 hours long, and stepping by 24h would drift the working window.
  let cursor = zonedParts(floor, tz)

  for (let guard = 0; guard < 400 && slots.length < maxResults; guard++) {
    const dayStart = wallToInstant(
      { year: cursor.year, month: cursor.month, day: cursor.day, hour: 0, minute: dayStartMin },
      tz
    )
    const dayEnd = wallToInstant(
      { year: cursor.year, month: cursor.month, day: cursor.day, hour: 0, minute: dayEndMin },
      tz
    )
    if (dayStart >= windowEnd) break

    if (weekdays.includes(cursor.weekday)) {
      const window: Span = {
        startMs: Math.max(dayStart, floor),
        endMs: Math.min(dayEnd, windowEnd),
      }
      if (window.endMs > window.startMs) {
        for (const gap of subtractSpans(window, busySpans)) {
          const length = gap.endMs - gap.startMs
          if (length < durationMs) continue
          slots.push({
            start: toRfc3339(gap.startMs, tz),
            end: toRfc3339(gap.endMs, tz),
            duration_minutes: Math.floor(length / 60_000),
          })
          if (slots.length >= maxResults) break
        }
      }
    }

    // Noon of the next day, then re-read the parts: noon is far from any DST
    // transition, so this never lands back on the same calendar day.
    const nextNoon = wallToInstant(
      { year: cursor.year, month: cursor.month, day: cursor.day, hour: 12 },
      tz
    ) + 24 * 60 * 60 * 1000
    cursor = zonedParts(nextNoon, tz)
  }

  return slots
}
