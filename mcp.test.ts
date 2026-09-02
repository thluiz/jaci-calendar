import { describe, expect, test } from "bun:test"
import { handleMCP, toolsFor, TOOLS, type Handlers } from "./mcp"
import type { Principal } from "./types"

const WRITER: Principal = { name: "claude-code-thiago", role: "write", calendars: ["thiago"] }
const READER: Principal = { name: "openclaw", role: "read", calendars: ["familia"] }

function stubHandlers(overrides: Partial<Handlers> = {}): Handlers {
  const notCalled = async () => {
    throw new Error("handler should not have been reached")
  }
  return {
    listCalendars: async () => ({ name: "x", calendars: [] }),
    searchEvents: notCalled,
    checkConflicts: notCalled,
    findFreeSlots: notCalled,
    createEvent: notCalled,
    updateEvent: notCalled,
    ...overrides,
  }
}

function rpc(method: string, params?: Record<string, unknown>, id: number | null = 1) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  })
}

describe("toolsFor", () => {
  test("a read key never sees the write tools", () => {
    const names = toolsFor(READER).map((t) => t.name)
    expect(names).toEqual(["list_calendars", "search_events", "check_conflicts", "find_free_slots"])
    expect(names).not.toContain("create_event")
  })

  test("a write key sees all six", () => {
    expect(toolsFor(WRITER)).toHaveLength(6)
  })

  test("the role field is not part of the wire schema", () => {
    expect(JSON.stringify(toolsFor(WRITER))).not.toContain('"role"')
  })
})

describe("tool descriptions", () => {
  test("create_event states plainly that there are no guests", () => {
    const create = TOOLS.find((t) => t.name === "create_event")!
    expect(create.description).toContain("NO GUESTS")
    expect(create.description).toContain("calendar_ids")
    expect(create.description).toContain("409")
  })

  test("every tool documents its arguments", () => {
    for (const tool of TOOLS) {
      const props = tool.inputSchema.properties as Record<string, { description?: string }>
      for (const [name, schema] of Object.entries(props)) {
        expect(`${tool.name}.${name}: ${schema.description ?? ""}`.length).toBeGreaterThan(
          `${tool.name}.${name}: `.length
        )
      }
    }
  })
})

describe("handleMCP", () => {
  test("no key is 401, before any handler runs", async () => {
    const res = await handleMCP(rpc("tools/list"), null, stubHandlers())
    expect(res.status).toBe(401)
  })

  test("initialize answers the protocol handshake", async () => {
    const res = await handleMCP(rpc("initialize"), READER, stubHandlers())
    const body = await res.json()
    expect(body.result.protocolVersion).toBe("2024-11-05")
    expect(body.result.serverInfo.name).toBe("calendar-gate")
  })

  test("a notification gets 202 and no body", async () => {
    const res = await handleMCP(rpc("notifications/initialized", undefined, null), READER, stubHandlers())
    expect(res.status).toBe(202)
  })

  test("a read key calling a write tool is refused without reaching the handler", async () => {
    const res = await handleMCP(
      rpc("tools/call", { name: "create_event", arguments: { summary: "x", start: "a", end: "b", calendar_ids: ["y"] } }),
      READER,
      stubHandlers({ createEvent: async () => ({ never: true }) })
    )
    const body = await res.json()
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain("read only")
  })

  test("a missing required argument is -32602", async () => {
    const res = await handleMCP(
      rpc("tools/call", { name: "search_events", arguments: { time_min: "2026-09-03T00:00:00-03:00" } }),
      READER,
      stubHandlers()
    )
    const body = await res.json()
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain("time_max")
  })

  test("a business refusal comes back as isError content, not a transport error", async () => {
    const res = await handleMCP(
      rpc("tools/call", { name: "list_calendars", arguments: {} }),
      READER,
      stubHandlers({
        listCalendars: async () => {
          throw Object.assign(new Error("the requested time overlaps existing events"), {
            code: "CONFLICT",
            status: 409,
          })
        },
      })
    )
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.error).toBe("CONFLICT")
    expect(payload.status).toBe(409)
  })

  test("a successful call returns the data as JSON text", async () => {
    const res = await handleMCP(
      rpc("tools/call", { name: "list_calendars", arguments: {} }),
      WRITER,
      stubHandlers({ listCalendars: async () => ({ name: "claude-code-thiago", calendars: ["thiago"] }) })
    )
    const body = await res.json()
    expect(JSON.parse(body.result.content[0].text).name).toBe("claude-code-thiago")
  })

  test("an unknown tool is refused", async () => {
    const res = await handleMCP(rpc("tools/call", { name: "delete_event", arguments: {} }), WRITER, stubHandlers())
    const body = await res.json()
    expect(body.error.code).toBe(-32602)
  })

  test("batch requests answer as a batch", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    })
    const body = await (await handleMCP(req, READER, stubHandlers())).json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
  })

  test("an unknown method is -32601", async () => {
    const body = await (await handleMCP(rpc("resources/list"), READER, stubHandlers())).json()
    expect(body.error.code).toBe(-32601)
  })

  test("malformed JSON is a parse error, not a crash", async () => {
    const req = new Request("http://localhost/mcp", { method: "POST", body: "{not json" })
    const res = await handleMCP(req, READER, stubHandlers())
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(-32700)
  })

  test("there is no tool that deletes anything", () => {
    expect(TOOLS.some((t) => /delete|remove|cancel/i.test(t.name))).toBe(false)
  })
})
