/**
 * types.ts — shared vocabulary of calendar-gate.
 *
 * Names are provider-neutral on purpose (`CalendarEntry`, `BusyBlock`, not
 * `GoogleCalendar...`): a future CalDAV or Graph adapter must not break the
 * contract the agents already know.
 */

/** Principal role. `read` never reaches a write route. */
export type Role = "read" | "write"

/**
 * The level this calendar was shared with the service account, in the Google
 * UI. Declared here only so the service knows which API to call and what it may
 * promise the agent; the sharing itself is what actually enforces it.
 */
export type Access = "details" | "busy_only"

export interface CalendarEntry {
  /** Short alias used by the tools and by the principal registry. */
  alias: string
  /** Google calendar id, usually an e-mail address. */
  id: string
  access: Access
  description?: string
}

export interface Principal {
  name: string
  role: Role
  /** calendars.json aliases this principal may reach. */
  calendars: string[]
  description?: string
}

/** An interval in RFC3339 with an explicit offset. */
export interface Interval {
  start: string
  end: string
}

/**
 * A busy block. `detail: "busy_only"` means the source calendar only exposed
 * availability, so there is no title to report — the agent should say just
 * "busy from 14:00 to 15:00".
 */
export interface BusyBlock extends Interval {
  calendar: string
  detail: Access
  event_id?: string
  summary?: string
  all_day?: boolean
}

/** An event as Google returns it, in the subset this service looks at. */
export interface GoogleEvent {
  id?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  transparency?: string
  eventType?: string
  start?: { date?: string; dateTime?: string; timeZone?: string }
  end?: { date?: string; dateTime?: string; timeZone?: string }
  attendees?: Array<{ self?: boolean; responseStatus?: string; email?: string }>
  extendedProperties?: { private?: Record<string, string> }
  htmlLink?: string
  recurringEventId?: string
}

/** A create request, normalized after validation. */
export interface EventInput {
  summary: string
  description?: string
  location?: string
  start: string
  end: string
  timezone: string
  all_day: boolean
}

/** Outcome of one copy of a fan-out. */
export interface FanoutResult {
  calendar: string
  calendar_id: string
  ok: boolean
  created?: boolean
  updated?: boolean
  event_id?: string
  html_link?: string
  error?: string
}
