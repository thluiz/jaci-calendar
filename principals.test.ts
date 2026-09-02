import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  calendarsOf,
  canWrite,
  describePrincipal,
  hashKey,
  loadRegistry,
  parseCalendars,
  parsePrincipals,
  resolveCalendar,
  resolvePrincipal,
  type Registry,
} from "./principals"

const KEY_WRITE = "aaaa1111"
const KEY_READ = "bbbb2222"

function buildRegistry(overrides?: {
  calendars?: Record<string, unknown>
  principals?: Record<string, unknown>
}): { registry: Registry; errors: string[] } {
  const errors: string[] = []
  const calendars = parseCalendars(
    overrides?.calendars ?? {
      _comment: "ignored",
      thiago: { id: "thiago@gmail.com", access: "details" },
      thilia: { id: "thilia@gmail.com", access: "busy_only" },
      familia: { id: "fam@group.calendar.google.com", access: "details" },
    },
    errors
  )
  const { principals, byKeyHash } = parsePrincipals(
    overrides?.principals ?? {
      "claude-code-thiago": {
        key_sha256: hashKey(KEY_WRITE),
        role: "write",
        calendars: ["thiago", "familia"],
      },
      openclaw: {
        key_sha256: hashKey(KEY_READ),
        role: "read",
        calendars: ["familia"],
      },
    },
    calendars,
    errors
  )
  return { registry: { calendars, principals, byKeyHash, errors }, errors }
}

describe("parseCalendars", () => {
  test("skips underscore keys and rejects a bad access level", () => {
    const errors: string[] = []
    const cals = parseCalendars(
      {
        _comment: "x",
        ok: { id: "a@b.com", access: "details" },
        bad: { id: "c@d.com", access: "read-write" },
        noid: { access: "details" },
      },
      errors
    )
    expect([...cals.keys()]).toEqual(["ok"])
    expect(errors.some((e) => e.includes('"bad"'))).toBe(true)
    expect(errors.some((e) => e.includes('"noid"'))).toBe(true)
  })
})

describe("parsePrincipals", () => {
  test("accepts a raw calendar id as well as an alias", () => {
    const { registry } = buildRegistry({
      principals: {
        p: { key_sha256: hashKey(KEY_WRITE), role: "write", calendars: ["thiago@gmail.com"] },
      },
    })
    expect(registry.principals.get("p")?.calendars).toEqual(["thiago"])
  })

  test("an unknown calendar fails the whole principal, loudly", () => {
    const { registry, errors } = buildRegistry({
      principals: {
        p: { key_sha256: hashKey(KEY_WRITE), role: "write", calendars: ["thiago", "typo"] },
      },
    })
    expect(registry.principals.size).toBe(0)
    expect(errors.some((e) => e.includes("typo"))).toBe(true)
  })

  test("rejects a plaintext key in key_sha256", () => {
    const { registry, errors } = buildRegistry({
      principals: { p: { key_sha256: KEY_WRITE, role: "write", calendars: ["thiago"] } },
    })
    expect(registry.principals.size).toBe(0)
    expect(errors.some((e) => e.includes("64 hex"))).toBe(true)
  })

  test("rejects an unknown role", () => {
    const { registry } = buildRegistry({
      principals: { p: { key_sha256: hashKey(KEY_WRITE), role: "admin", calendars: ["thiago"] } },
    })
    expect(registry.principals.size).toBe(0)
  })

  test("rejects an empty calendar list", () => {
    const { registry } = buildRegistry({
      principals: { p: { key_sha256: hashKey(KEY_WRITE), role: "read", calendars: [] } },
    })
    expect(registry.principals.size).toBe(0)
  })

  test("the second principal sharing a key is dropped, not silently merged", () => {
    const { registry, errors } = buildRegistry({
      principals: {
        first: { key_sha256: hashKey(KEY_WRITE), role: "read", calendars: ["familia"] },
        second: { key_sha256: hashKey(KEY_WRITE), role: "write", calendars: ["thiago"] },
      },
    })
    expect([...registry.principals.keys()]).toEqual(["first"])
    expect(errors.some((e) => e.includes("already used"))).toBe(true)
  })
})

describe("resolvePrincipal", () => {
  test("resolves a known key and rejects everything else", () => {
    const { registry } = buildRegistry()
    expect(resolvePrincipal(registry, KEY_WRITE)?.name).toBe("claude-code-thiago")
    expect(resolvePrincipal(registry, "nope")).toBeNull()
    expect(resolvePrincipal(registry, "")).toBeNull()
    expect(resolvePrincipal(registry, null)).toBeNull()
  })

  test("a key hash prefix does not authenticate", () => {
    const { registry } = buildRegistry()
    expect(resolvePrincipal(registry, KEY_WRITE.slice(0, 4))).toBeNull()
  })
})

describe("resolveCalendar", () => {
  test("resolves by alias and by id, within the principal's set", () => {
    const { registry } = buildRegistry()
    const p = resolvePrincipal(registry, KEY_WRITE)!
    expect(resolveCalendar(registry, p, "thiago")?.id).toBe("thiago@gmail.com")
    expect(resolveCalendar(registry, p, "THIAGO@gmail.com")?.alias).toBe("thiago")
  })

  test("denies a calendar the service account can see but this principal cannot", () => {
    const { registry } = buildRegistry()
    const p = resolvePrincipal(registry, KEY_WRITE)!
    expect(resolveCalendar(registry, p, "thilia")).toBeNull()
    expect(resolveCalendar(registry, p, "thilia@gmail.com")).toBeNull()
  })
})

describe("role", () => {
  test("read is not write", () => {
    const { registry } = buildRegistry()
    expect(canWrite(resolvePrincipal(registry, KEY_WRITE)!)).toBe(true)
    expect(canWrite(resolvePrincipal(registry, KEY_READ)!)).toBe(false)
  })
})

describe("loadRegistry", () => {
  // This is the path SIGHUP takes: re-reading both files from disk while the
  // service keeps running, so a revoked agent stops working without a restart.
  const dir = mkdtempSync(join(tmpdir(), "calendar-gate-test-"))
  const calendarsFile = join(dir, "calendars.json")
  const principalsFile = join(dir, "principals.json")

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function write(calendars: unknown, principals: unknown) {
    writeFileSync(calendarsFile, JSON.stringify(calendars))
    writeFileSync(principalsFile, JSON.stringify(principals))
  }

  test("reads both files and resolves a key", () => {
    write(
      { familia: { id: "fam@group.calendar.google.com", access: "details" } },
      { openclaw: { key_sha256: hashKey(KEY_READ), role: "read", calendars: ["familia"] } }
    )
    const registry = loadRegistry({ calendarsFile, principalsFile })
    expect(registry.errors).toEqual([])
    expect(resolvePrincipal(registry, KEY_READ)?.name).toBe("openclaw")
  })

  test("a reload picks up a revoked principal", () => {
    write({ familia: { id: "fam@group.calendar.google.com", access: "details" } }, {})
    const registry = loadRegistry({ calendarsFile, principalsFile })
    expect(resolvePrincipal(registry, KEY_READ)).toBeNull()
    expect(registry.errors.some((e) => e.includes("no usable principal"))).toBe(true)
  })

  test("a malformed file degrades to fail-closed instead of throwing", () => {
    writeFileSync(principalsFile, "{ not json")
    const registry = loadRegistry({ calendarsFile, principalsFile })
    expect(registry.principals.size).toBe(0)
    expect(registry.errors.some((e) => e.includes("invalid JSON"))).toBe(true)
  })

  test("missing files are reported, not thrown", () => {
    const registry = loadRegistry({
      calendarsFile: join(dir, "nope.json"),
      principalsFile: join(dir, "nope2.json"),
    })
    expect(registry.errors.filter((e) => e.includes("not found"))).toHaveLength(2)
  })
})

describe("describePrincipal", () => {
  test("never leaks the key hash", () => {
    const { registry } = buildRegistry()
    const p = resolvePrincipal(registry, KEY_WRITE)!
    const dump = JSON.stringify(describePrincipal(registry, p))
    expect(dump).not.toContain(hashKey(KEY_WRITE))
    expect(dump).not.toContain(KEY_WRITE)
    expect(dump).toContain("thiago@gmail.com")
  })

  test("lists only this principal's calendars, with their access level", () => {
    const { registry } = buildRegistry()
    const p = resolvePrincipal(registry, KEY_READ)!
    expect(calendarsOf(registry, p).map((c) => c.alias)).toEqual(["familia"])
    expect(describePrincipal(registry, p).calendars[0]!.access).toBe("details")
  })
})
