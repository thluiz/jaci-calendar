/**
 * google/calendar.ts — thin wrappers over the Calendar API v3.
 *
 * Thin on purpose: no rule lives here. Each call throws a CalendarApiError
 * carrying the status and the body, so the caller can tell "409, it already
 * exists" (an idempotent replay) from "403, not shared with us" (a real
 * denial). The Authorization header never appears in an error message.
 *
 * There is no delete wrapper, and there will not be one: the service cannot
 * remove an event, by construction.
 */

import type { GoogleEvent } from "../types"
import type { ServiceAccountAuth } from "./auth"

const BASE = "https://www.googleapis.com/calendar/v3"

export class CalendarApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly calendarId?: string
  ) {
    super(`Google Calendar API ${status}: ${body.slice(0, 300)}`)
    this.name = "CalendarApiError"
  }

  /** 409 on insert means an event with that id already exists. */
  get isAlreadyExists(): boolean {
    return this.status === 409
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  /** Not shared with the service account, or shared at a lower level. */
  get isForbidden(): boolean {
    return this.status === 403 || this.status === 401
  }
}

export class CalendarClient {
  constructor(private readonly auth: ServiceAccountAuth) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined>; calendarId?: string } = {}
  ): Promise<T> {
    const token = await this.auth.getAccessToken()
    const url = new URL(`${BASE}${path}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v)
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    })

    const text = await res.text()
    if (!res.ok) throw new CalendarApiError(res.status, text, opts.calendarId)
    return (text ? JSON.parse(text) : {}) as T
  }

  /**
   * Events in a window. Always with singleEvents=true: without it a recurring
   * event comes back as a single row carrying an RRULE, and conflict detection
   * would never see the occurrences.
   */
  async listEvents(
    calendarId: string,
    opts: { timeMin: string; timeMax: string; q?: string; maxResults?: number }
  ): Promise<GoogleEvent[]> {
    const data = await this.request<{ items?: GoogleEvent[] }>(
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        calendarId,
        query: {
          timeMin: opts.timeMin,
          timeMax: opts.timeMax,
          q: opts.q,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(opts.maxResults ?? 250),
        },
      }
    )
    return data.items ?? []
  }

  /** Availability only. Used for calendars shared as "see only free/busy". */
  async freeBusy(opts: {
    timeMin: string
    timeMax: string
    calendarIds: string[]
    timeZone?: string
  }): Promise<Record<string, { busy: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }>> {
    const data = await this.request<{
      calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }>
    }>("POST", "/freeBusy", {
      body: {
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
        items: opts.calendarIds.map((id) => ({ id })),
      },
    })

    const out: Record<string, { busy: Array<{ start: string; end: string }>; errors?: Array<{ reason: string }> }> = {}
    for (const [id, value] of Object.entries(data.calendars ?? {})) {
      out[id] = { busy: value.busy ?? [], ...(value.errors ? { errors: value.errors } : {}) }
    }
    return out
  }

  async getEvent(calendarId: string, eventId: string): Promise<GoogleEvent> {
    return this.request<GoogleEvent>(
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { calendarId }
    )
  }

  /**
   * Creates an event with a client-chosen id. A second insert with the same id
   * comes back 409, which is what turns an agent retry into a no-op instead of
   * a duplicate.
   */
  async insertEvent(calendarId: string, eventId: string, event: GoogleEvent): Promise<GoogleEvent> {
    return this.request<GoogleEvent>("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      calendarId,
      body: { ...event, id: eventId },
      // No invitations exist here, but the parameter is explicit so nobody
      // later assumes the default sends mail.
      query: { sendUpdates: "none" },
    })
  }

  async patchEvent(calendarId: string, eventId: string, patch: GoogleEvent): Promise<GoogleEvent> {
    return this.request<GoogleEvent>(
      "PATCH",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { calendarId, body: patch, query: { sendUpdates: "none" } }
    )
  }

  /**
   * All copies of a fan-out, found by the shared marker. privateExtendedProperty
   * takes a `key=value` string, and matching on it is what makes an update
   * reach the copy on someone else's calendar without storing a mapping here.
   */
  async findByGroupId(
    calendarId: string,
    groupId: string,
    window?: { timeMin?: string; timeMax?: string }
  ): Promise<GoogleEvent[]> {
    const data = await this.request<{ items?: GoogleEvent[] }>(
      "GET",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        calendarId,
        query: {
          privateExtendedProperty: `group_id=${groupId}`,
          singleEvents: "true",
          showDeleted: "false",
          maxResults: "10",
          timeMin: window?.timeMin,
          timeMax: window?.timeMax,
        },
      }
    )
    return data.items ?? []
  }
}
