import { describe, expect, test } from "bun:test"
import { AuthError } from "../../src/google/auth"
import type { LogEntry } from "../../src/logger"
import { hashKey, type Registry } from "../../src/principals"
import type { Handlers } from "../../src/service/calendar-service"
import { createFetchHandler } from "../../src/transport/http"
import type { Principal } from "../../src/types"

const KEY = "writer-key"
const WRITER: Principal = { name: "writer", role: "write", calendars: ["ana"] }

const registry = (): Registry => ({
  calendars: new Map([["ana", { alias: "ana", id: "ana@example.com", access: "details" }]]),
  principals: new Map([[WRITER.name, WRITER]]),
  byKeyHash: new Map([[hashKey(KEY), WRITER.name]]),
  errors: [],
})

function setup(opts: { authFails?: boolean; handlers?: Partial<Handlers> } = {}) {
  const calls: Array<{ op: string; args?: Record<string, unknown> }> = []
  const record = (op: string) => async (_p: Principal, args?: Record<string, unknown>) => {
    calls.push({ op, args })
    return { ok: true }
  }
  const handlers: Handlers = {
    listCalendars: record("listCalendars"),
    searchEvents: record("searchEvents"),
    checkConflicts: record("checkConflicts"),
    findFreeSlots: record("findFreeSlots"),
    createEvent: record("createEvent"),
    updateEvent: record("updateEvent"),
    ...opts.handlers,
  }
  const entries: LogEntry[] = []
  const authAlerts: AuthError[] = []
  const fetch = createFetchHandler({
    handlers,
    registry,
    auth: {
      getAccessToken: async () => {
        if (opts.authFails) throw new AuthError("token exchange failed", "check the key")
        return "token"
      },
    },
    audit: { append: async (e) => void entries.push(e) },
    alerts: { authFailure: async (e) => void authAlerts.push(e) },
  })
  return { fetch, calls, entries, authAlerts }
}

const req = (method: string, path: string, opts: { key?: string; body?: string } = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: opts.key ? { "X-Api-Key": opts.key } : {},
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  })

describe("http", () => {
  test("/health needs no key and says the credential works", async () => {
    const { fetch } = setup()
    const res = await fetch(req("GET", "/health"))

    expect(res.status).toBe(200)
    expect(((await res.json()) as any).google_authenticated).toBe(true)
  })

  test("/health answers 503 with a next step and alerts when the credential fails", async () => {
    const { fetch, authAlerts } = setup({ authFails: true })
    const res = await fetch(req("GET", "/health"))

    expect(res.status).toBe(503)
    expect(((await res.json()) as any).next_step).toBe("check the key")
    expect(authAlerts).toHaveLength(1)
  })

  test("a request with no key is refused and audited under (unknown)", async () => {
    const { fetch, calls, entries } = setup()
    const res = await fetch(req("GET", "/calendars"))

    expect(res.status).toBe(401)
    expect(calls).toEqual([])
    expect(entries).toEqual([
      expect.objectContaining({ principal: "(unknown)", operation: "GET /calendars", reason: "UNAUTHORIZED" }),
    ])
  })

  test("a body that is not a JSON object is a 400 before any handler runs", async () => {
    const { fetch, calls } = setup()
    const res = await fetch(req("POST", "/events", { key: KEY, body: "[1, 2]" }))

    expect(res.status).toBe(400)
    expect(calls).toEqual([])
  })

  test("PATCH /events/group/:id hands the decoded group id to the handler", async () => {
    const { fetch, calls } = setup()
    const res = await fetch(req("PATCH", "/events/group/abc%20def/", { key: KEY, body: '{"summary":"x"}' }))

    expect(res.status).toBe(200)
    expect(calls).toEqual([{ op: "updateEvent", args: { summary: "x", group_id: "abc def" } }])
  })

  test("a partial fan-out's 207 reaches the HTTP status", async () => {
    const { fetch } = setup({ handlers: { createEvent: async () => ({ ok: false, status: 207 }) } })
    const res = await fetch(req("POST", "/events", { key: KEY, body: "{}" }))

    expect(res.status).toBe(207)
  })

  test("an unknown route is a 404", async () => {
    const { fetch } = setup()
    expect((await fetch(req("GET", "/nope", { key: KEY }))).status).toBe(404)
  })
})
