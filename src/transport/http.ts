/**
 * transport/http.ts — the REST routes and the /mcp mount point.
 *
 * Routing, authentication and the mapping of errors to responses. No rule
 * lives here: every route calls the same handler the matching MCP tool calls.
 */

import { AuthError } from "../google/auth"
import { log, type AuditLog } from "../logger"
import { resolvePrincipal, type Registry } from "../principals"
import type { Alerts } from "../service/alerts"
import type { Handlers } from "../service/calendar-service"
import { ApiError, toResponseError } from "../service/errors"
import type { Principal } from "../types"
import { handleMCP } from "./mcp"

export interface HttpDeps {
  handlers: Handlers
  registry: () => Registry
  /** Only used by /health, to say whether the Google credential works. */
  auth: { getAccessToken(): Promise<string> }
  audit: AuditLog
  alerts: Pick<Alerts, "authFailure">
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/** Create and update answer 207 on a partial fan-out; the status rides in the body. */
function statusOf(result: unknown): number {
  const status = (result as { status?: unknown }).status
  return typeof status === "number" ? status : 200
}

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

export function createFetchHandler(deps: HttpDeps): (req: Request) => Promise<Response> {
  const { handlers } = deps

  function authenticate(req: Request): Principal {
    const principal = resolvePrincipal(deps.registry(), req.headers.get("x-api-key"))
    if (!principal) throw new ApiError("UNAUTHORIZED", "missing or unknown X-Api-Key", 401)
    return principal
  }

  async function health(): Promise<Response> {
    let authenticated = false
    let detail: string | undefined
    try {
      await deps.auth.getAccessToken()
      authenticated = true
    } catch (e) {
      detail = e instanceof AuthError ? e.actionable : "unexpected auth failure"
      if (e instanceof AuthError) void deps.alerts.authFailure(e)
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

  async function route(req: Request, path: string): Promise<Response> {
    // The only unauthenticated route. It says alive and whether the Google
    // credential works, and nothing else — not the service account address,
    // not which calendars exist.
    if (path === "/health" && req.method === "GET") return health()

    if (path === "/mcp") {
      // Diverges from the fleet default of an open /mcp: with an open one,
      // any local process could write to anyone's calendar with no credential.
      const principal = resolvePrincipal(deps.registry(), req.headers.get("x-api-key"))
      return handleMCP(req, principal, handlers)
    }

    if (path === "/calendars" && req.method === "GET") {
      return json(await handlers.listCalendars(authenticate(req)))
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
      return json(result, statusOf(result))
    }

    const groupMatch = /^\/events\/group\/([^/]+)$/.exec(path)
    if (groupMatch && req.method === "PATCH") {
      const principal = authenticate(req)
      const body = await readBody(req)
      body.group_id = decodeURIComponent(groupMatch[1]!)
      const result = await handlers.updateEvent(principal, body)
      return json(result, statusOf(result))
    }

    return json({ error: "NOT_FOUND", message: `no route for ${req.method} ${path}` }, 404)
  }

  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/"
    try {
      return await route(req, path)
    } catch (e) {
      if (e instanceof AuthError) void deps.alerts.authFailure(e)
      const { status, body } = toResponseError(e)
      if (status >= 500) log("request failed", { path, status, error: String((e as Error)?.message ?? e) })
      // A run of these is the intrusion signal, and there is no principal to
      // attribute them to — that is exactly what makes them worth keeping.
      if (status === 401) {
        await deps.audit.append({
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
  }
}
