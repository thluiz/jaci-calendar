/**
 * mcp.ts — MCP over HTTP (Streamable HTTP), JSON-RPC 2.0, no SDK.
 *
 * Thin by design: it reimplements no rule, it calls the same functions the REST
 * routes call. What it adds is the role filter on tools/list — a `read`
 * principal is never shown the write tools, and a tool the model cannot see is
 * a tool it cannot hallucinate calling.
 *
 * Unlike the other services in this fleet, /mcp here requires a key. An open
 * /mcp would let any local process write to anyone's calendar.
 */

import type { Principal, Role } from "./types"

export interface Handlers {
  listCalendars(principal: Principal): Promise<unknown>
  searchEvents(principal: Principal, args: Record<string, unknown>): Promise<unknown>
  checkConflicts(principal: Principal, args: Record<string, unknown>): Promise<unknown>
  findFreeSlots(principal: Principal, args: Record<string, unknown>): Promise<unknown>
  createEvent(principal: Principal, args: Record<string, unknown>): Promise<unknown>
  updateEvent(principal: Principal, args: Record<string, unknown>): Promise<unknown>
}

interface MCPRequest {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface MCPResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface Tool {
  name: string
  role: Role
  description: string
  inputSchema: Record<string, unknown>
}

const WINDOW_PROPS = {
  time_min: { type: "string", description: "Window start, RFC3339 with offset: 2026-09-03T00:00:00-03:00" },
  time_max: { type: "string", description: "Window end, RFC3339 with offset (exclusive)" },
  calendar_ids: {
    type: "array",
    items: { type: "string" },
    description: "Calendar aliases from list_calendars (default: every calendar you can reach)",
  },
  timezone: { type: "string", description: "IANA timezone for the answer (default: America/Sao_Paulo)" },
}

export const TOOLS: Tool[] = [
  {
    name: "list_calendars",
    role: "read",
    description:
      "Lists the calendars this API key can reach, with the access level of each. " +
      "Answered from local config without calling Google, so it shows exactly what you may use and nothing else; " +
      "a calendar with access 'busy_only' can be checked for availability but never read in detail nor written to. " +
      "Call this first: every other tool takes the aliases returned here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_events",
    role: "read",
    description:
      "Lists events in a time window, across one or more calendars. " +
      "Recurring events come back expanded into their occurrences, and events from a 'busy_only' calendar arrive " +
      "as bare intervals marked detail: 'busy_only' — those have no title to report, say only that the person is busy. " +
      "Use it to answer what is on the agenda; to ask whether a specific slot is free, use check_conflicts instead.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        query: { type: "string", description: "Free-text filter on title and description" },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "check_conflicts",
    role: "read",
    description:
      "Checks whether a specific time slot collides with anything already scheduled. " +
      "Events that touch do not conflict (one ending at 15:00 leaves 15:00 free), and events marked free, declined " +
      "or injected by Google (birthdays, working location) are ignored. " +
      "Use it before proposing a time; when moving an existing event, pass its group_id in ignore_group_id so it does not collide with itself.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Slot start, RFC3339 with offset" },
        end: { type: "string", description: "Slot end, RFC3339 with offset" },
        calendar_ids: WINDOW_PROPS.calendar_ids,
        timezone: WINDOW_PROPS.timezone,
        ignore_event_id: { type: "string", description: "Event id to ignore when checking" },
        ignore_group_id: { type: "string", description: "group_id whose copies should be ignored" },
        partial_ok: {
          type: "boolean",
          description: "Answer even if a calendar could not be read, instead of failing (default: false)",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "find_free_slots",
    role: "read",
    description:
      "Finds gaps long enough for a meeting, across everyone's calendars at once. " +
      "Returns whole free gaps inside working hours, not every possible start time, it never proposes a slot in the past, " +
      "and it fails rather than calling a day free when a calendar could not be read. " +
      "Use it to answer 'when can we meet'; then confirm the chosen time with the person before calling create_event.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        duration_minutes: { type: "integer", description: "Length needed, in minutes (default: 60)" },
        business_start: { type: "string", description: "Start of the working day, HH:MM (default: 09:00)" },
        business_end: { type: "string", description: "End of the working day, HH:MM (default: 18:00)" },
        weekdays: {
          type: "array",
          items: { type: "integer" },
          description: "Days to consider, 0 = Sunday (default: [1,2,3,4,5])",
        },
        max_results: { type: "integer", description: "Maximum gaps to return (default: 20)" },
        partial_ok: {
          type: "boolean",
          description: "Answer even if a calendar could not be read, instead of failing (default: false)",
        },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "create_event",
    role: "write",
    description:
      "Creates an event on one or more calendars, linking the copies with a shared group_id. " +
      "THERE ARE NO GUESTS AND NO RSVP: to include a person, list their calendar alias in calendar_ids — the event is " +
      "created on their own calendar, and an 'attendees' field is rejected. A 409 answer means the slot is taken, not that " +
      "the call failed: read the conflicts, propose another time, and only resend with allow_conflict: true if the person agreed to overlap. " +
      "Use dry_run: true when unsure, and keep the returned group_id — update_event needs it.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start, RFC3339 with offset, or YYYY-MM-DD for an all-day event" },
        end: { type: "string", description: "End, same format as start. For all-day events the end date is exclusive" },
        calendar_ids: {
          type: "array",
          items: { type: "string" },
          description: "Calendar aliases the event is created on, one per participant. Required",
        },
        description: { type: "string", description: "Event body" },
        location: { type: "string", description: "Where it happens" },
        timezone: { type: "string", description: "IANA timezone (default: America/Sao_Paulo)" },
        idempotency_key: {
          type: "string",
          description: "Stable key so a retry does not duplicate the event. Reuse the same key when retrying",
        },
        allow_conflict: { type: "boolean", description: "Schedule even if it overlaps (default: false)" },
        allow_past: { type: "boolean", description: "Allow a start more than 24h in the past (default: false)" },
        dry_run: { type: "boolean", description: "Validate and show what would be created, writing nothing (default: false)" },
      },
      required: ["summary", "start", "end", "calendar_ids"],
    },
  },
  {
    name: "update_event",
    role: "write",
    description:
      "Updates every copy of an event, found by its group_id. " +
      "Only the fields you send change, start and end must move together, and copies on calendars this key cannot reach are " +
      "left untouched and reported instead of silently skipped. Moving to a busy time answers 409 exactly like create_event does. " +
      "Use it to reschedule or retitle; there is no way to delete an event through this service, that has to be done in Google Calendar.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: { type: "string", description: "group_id returned by create_event. Required" },
        summary: { type: "string", description: "New title" },
        start: { type: "string", description: "New start, RFC3339 with offset. Must come with end" },
        end: { type: "string", description: "New end, RFC3339 with offset. Must come with start" },
        description: { type: "string", description: "New body" },
        location: { type: "string", description: "New location" },
        timezone: { type: "string", description: "IANA timezone (default: America/Sao_Paulo)" },
        calendar_ids: {
          type: "array",
          items: { type: "string" },
          description: "Restrict the update to these calendars (default: every calendar you can reach)",
        },
        allow_conflict: { type: "boolean", description: "Move even if the new time overlaps (default: false)" },
        dry_run: { type: "boolean", description: "Show what would change, writing nothing (default: false)" },
      },
      required: ["group_id"],
    },
  },
]

/** The tools a principal may see. Write tools stay invisible to a read key. */
export function toolsFor(principal: Principal): Array<Omit<Tool, "role">> {
  return TOOLS.filter((t) => t.role === "read" || principal.role === "write").map(
    ({ role: _role, ...tool }) => tool
  )
}

function ok(id: string | number | null, result: unknown): MCPResponse {
  return { jsonrpc: "2.0", id, result }
}

function err(id: string | number | null, code: number, message: string): MCPResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function content(data: unknown, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

async function dispatch(
  msg: MCPRequest,
  principal: Principal,
  handlers: Handlers
): Promise<MCPResponse | null> {
  const id = msg.id ?? null
  const params = msg.params

  switch (msg.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "calendar-gate", version: "0.1.0" },
      })

    case "notifications/initialized":
      return null // notification — no response

    case "ping":
      return ok(id, {})

    case "tools/list":
      return ok(id, { tools: toolsFor(principal) })

    case "tools/call": {
      const name = params?.name as string | undefined
      const args = (params?.arguments ?? {}) as Record<string, unknown>

      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return err(id, -32602, `unknown tool: ${name}`)
      if (tool.role === "write" && principal.role !== "write") {
        return err(id, -32602, `tool ${name} requires a write key; this key is read only`)
      }
      for (const required of (tool.inputSchema.required as string[] | undefined) ?? []) {
        if (args[required] === undefined) return err(id, -32602, `Missing required arg: ${required}`)
      }

      try {
        switch (name) {
          case "list_calendars":
            return ok(id, content(await handlers.listCalendars(principal)))
          case "search_events":
            return ok(id, content(await handlers.searchEvents(principal, args)))
          case "check_conflicts":
            return ok(id, content(await handlers.checkConflicts(principal, args)))
          case "find_free_slots":
            return ok(id, content(await handlers.findFreeSlots(principal, args)))
          case "create_event":
            return ok(id, content(await handlers.createEvent(principal, args)))
          case "update_event":
            return ok(id, content(await handlers.updateEvent(principal, args)))
          default:
            return err(id, -32602, `unknown tool: ${name}`)
        }
      } catch (e) {
        // A refusal is a result, not a transport error: the model has to read
        // the message to decide what to do — 409 means propose another time,
        // 403 means use a different calendar.
        const error = e as { code?: string; message?: string; status?: number; extra?: unknown }
        return ok(
          id,
          content(
            {
              error: error?.code ?? "INTERNAL",
              message: error?.message ?? String(e),
              ...(error?.status ? { status: error.status } : {}),
              ...(error?.extra ? { detail: error.extra } : {}),
            },
            true
          )
        )
      }
    }
  }

  if (id === null) return null // unknown notification
  return err(id, -32601, `method not supported: ${msg.method}`)
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, X-Api-Key",
}

const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" }

export async function handleMCP(
  req: Request,
  principal: Principal | null,
  handlers: Handlers
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })

  if (!principal) {
    return new Response(
      JSON.stringify({ error: "UNAUTHORIZED", message: "missing or unknown X-Api-Key" }),
      { status: 401, headers: JSON_HEADERS }
    )
  }

  // GET /mcp — minimal SSE keep-alive, for clients that open one.
  if (req.method === "GET") {
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(": calendar-gate mcp\n\n"))
      },
    })
    return new Response(body, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    })
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS })
  }

  let body: MCPRequest | MCPRequest[]
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify(err(null, -32700, "Parse error: invalid JSON")), {
      status: 400,
      headers: JSON_HEADERS,
    })
  }

  const isBatch = Array.isArray(body)
  const requests = isBatch ? (body as MCPRequest[]) : [body as MCPRequest]

  const settled = await Promise.all(requests.map((r) => dispatch(r, principal, handlers)))
  const responses = settled.filter((r): r is MCPResponse => r !== null)

  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS })

  return new Response(JSON.stringify(isBatch ? responses : responses[0]), { headers: JSON_HEADERS })
}
