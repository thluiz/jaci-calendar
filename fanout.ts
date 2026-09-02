/**
 * fanout.ts — one logical event, one copy per person.
 *
 * A service account cannot invite anyone (403 forbiddenForServiceAccounts
 * without Domain-Wide Delegation, which needs Workspace). So "meeting with
 * Thilia" is not one event with guests: it is the same event created on each
 * participant's own calendar, with a shared `group_id` in extendedProperties so
 * a later change reaches every copy.
 *
 * The planning is pure and lives here; the HTTP calls live in server.ts. That
 * split is what makes "a denied calendar aborts before any copy is created"
 * testable without touching Google.
 */

import { eventIdFor, groupIdFor } from "./idempotency"
import type { CalendarEntry, EventInput, FanoutResult, GoogleEvent } from "./types"

export interface FanoutTarget {
  alias: string
  calendarId: string
  eventId: string
}

export interface FanoutPlan {
  groupId: string
  targets: FanoutTarget[]
}

/**
 * Resolves the copies to create. Every calendar is resolved first and the whole
 * plan fails on the first denial: a partial fan-out would leave an event on one
 * person's calendar and not the other's, which is worse than no event at all.
 */
export function planFanout(
  calendars: CalendarEntry[],
  idempotencyKey: string
): FanoutPlan {
  const groupId = groupIdFor(idempotencyKey)
  const seen = new Set<string>()
  const targets: FanoutTarget[] = []
  for (const cal of calendars) {
    // The same calendar listed twice would try to insert the same event id
    // twice and report a spurious "already exists" on the second try.
    if (seen.has(cal.id)) continue
    seen.add(cal.id)
    targets.push({
      alias: cal.alias,
      calendarId: cal.id,
      eventId: eventIdFor(idempotencyKey, cal.id),
    })
  }
  return { groupId, targets }
}

/** The event body sent to Google, with the group marker attached. */
export function buildEventBody(
  input: EventInput,
  groupId: string,
  extra: Record<string, string> = {}
): GoogleEvent {
  const when = input.all_day
    ? { start: { date: input.start }, end: { date: input.end } }
    : {
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
      }

  return {
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...when,
    extendedProperties: { private: { group_id: groupId, ...extra } },
  }
}

/** The patch body for an update. Only the fields the caller actually sent. */
export function buildPatchBody(input: Partial<EventInput>): GoogleEvent {
  const patch: GoogleEvent = {}
  if (input.summary) patch.summary = input.summary
  if (input.description !== undefined) patch.description = input.description
  if (input.location !== undefined) patch.location = input.location
  if (input.start && input.end) {
    if (input.all_day) {
      patch.start = { date: input.start }
      patch.end = { date: input.end }
    } else {
      patch.start = { dateTime: input.start, timeZone: input.timezone }
      patch.end = { dateTime: input.end, timeZone: input.timezone }
    }
  }
  return patch
}

export interface FanoutSummary {
  status: number
  ok: boolean
  group_id: string
  results: FanoutResult[]
}

/**
 * Turns per-copy outcomes into one answer. A mixed run is 207 and never 200:
 * the agent has to be able to see which calendar got the event and which did
 * not, instead of being told everything worked.
 */
export function summarizeFanout(groupId: string, results: FanoutResult[]): FanoutSummary {
  const failures = results.filter((r) => !r.ok).length
  const created = results.some((r) => r.ok && r.created)

  let status: number
  if (failures === 0) status = created ? 201 : 200
  else if (failures === results.length) status = 502
  else status = 207

  return { status, ok: failures === 0, group_id: groupId, results }
}
