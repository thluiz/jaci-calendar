/**
 * principals.ts — API key registry and per-principal calendar allowlist.
 *
 * This is layer 2 of the permission model. Layer 1 lives at Google: the service
 * account only sees calendars explicitly shared with it, and nothing here can
 * widen that. What this layer adds is separation *between agents on the same
 * machine* — it is what stops the sandbox agent from touching a calendar that
 * was shared with the service account for a different agent's use.
 *
 * Pure module: no side effects at import time, so it unit tests without
 * starting the server.
 */

import { existsSync, readFileSync } from "fs"
import { createHash } from "crypto"
import type { Access, CalendarEntry, Principal, Role } from "./types"

export interface Registry {
  /** alias -> calendar */
  calendars: Map<string, CalendarEntry>
  /** principal name -> principal */
  principals: Map<string, Principal>
  /** sha256(key) -> principal name */
  byKeyHash: Map<string, string>
  /** Config problems to surface at startup. Never fatal. */
  errors: string[]
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const ROLES: Role[] = ["read", "write"]
const ACCESS: Access[] = ["details", "busy_only"]

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex")
}

function readJsonObject(path: string, errors: string[]): Record<string, unknown> | null {
  if (!existsSync(path)) {
    errors.push(`${path}: not found`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    errors.push(`${path}: invalid JSON (${(e as Error).message}) — file ignored`)
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push(`${path}: expected a JSON object`)
    return null
  }
  return parsed as Record<string, unknown>
}

export function parseCalendars(
  raw: Record<string, unknown>,
  errors: string[]
): Map<string, CalendarEntry> {
  const out = new Map<string, CalendarEntry>()
  // Object.entries never walks the prototype chain, unlike for..in.
  for (const [alias, value] of Object.entries(raw)) {
    // JSON has no comments; a leading underscore is the usual stand-in.
    if (alias.startsWith("_")) continue
    if (!NAME_RE.test(alias)) {
      errors.push(`calendar "${alias}": invalid alias, must match ${NAME_RE.source}`)
      continue
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`calendar "${alias}": expected an object`)
      continue
    }
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === "string" ? entry.id.trim() : ""
    if (!id) {
      errors.push(`calendar "${alias}": missing id`)
      continue
    }
    const access = entry.access as Access
    if (!ACCESS.includes(access)) {
      errors.push(`calendar "${alias}": access must be one of ${ACCESS.join(", ")}`)
      continue
    }
    out.set(alias, {
      alias,
      id,
      access,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    })
  }
  return out
}

export function parsePrincipals(
  raw: Record<string, unknown>,
  calendars: Map<string, CalendarEntry>,
  errors: string[]
): { principals: Map<string, Principal>; byKeyHash: Map<string, string> } {
  const principals = new Map<string, Principal>()
  const byKeyHash = new Map<string, string>()

  // Reverse index so a principal may also name a raw calendar id, which is what
  // someone copying an id out of the Google UI will naturally do.
  const byId = new Map<string, string>()
  for (const c of calendars.values()) byId.set(c.id.toLowerCase(), c.alias)

  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith("_")) continue
    if (!NAME_RE.test(name)) {
      errors.push(`principal "${name}": invalid name, must match ${NAME_RE.source}`)
      continue
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`principal "${name}": expected an object`)
      continue
    }
    const entry = value as Record<string, unknown>

    const hash = typeof entry.key_sha256 === "string" ? entry.key_sha256.trim().toLowerCase() : ""
    if (!SHA256_RE.test(hash)) {
      errors.push(`principal "${name}": key_sha256 must be 64 hex chars (the hash, never the key)`)
      continue
    }
    if (byKeyHash.has(hash)) {
      // Two principals behind one key would make the audit log ambiguous about
      // who acted, and the stricter of the two roles unenforceable.
      errors.push(`principal "${name}": key already used by "${byKeyHash.get(hash)}" — ignored`)
      continue
    }

    const role = entry.role as Role
    if (!ROLES.includes(role)) {
      errors.push(`principal "${name}": role must be one of ${ROLES.join(", ")}`)
      continue
    }

    if (!Array.isArray(entry.calendars) || entry.calendars.length === 0) {
      errors.push(`principal "${name}": calendars must be a non-empty array`)
      continue
    }

    const aliases: string[] = []
    let bad = false
    for (const item of entry.calendars) {
      if (typeof item !== "string") {
        errors.push(`principal "${name}": calendar entries must be strings`)
        bad = true
        break
      }
      const alias = calendars.has(item) ? item : byId.get(item.toLowerCase())
      if (!alias) {
        // Fail the whole principal, not just the entry: a typo silently
        // shrinking someone's access is worse than a loud startup error.
        errors.push(`principal "${name}": unknown calendar "${item}"`)
        bad = true
        break
      }
      if (!aliases.includes(alias)) aliases.push(alias)
    }
    if (bad) continue

    const principal: Principal = {
      name,
      role,
      calendars: aliases,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    }
    principals.set(name, principal)
    byKeyHash.set(hash, name)
  }

  return { principals, byKeyHash }
}

/**
 * Reads both registries from disk. A malformed file degrades to an empty
 * registry instead of throwing: throwing here would put systemd in a restart
 * loop, and an empty registry fails closed anyway (every request gets 401).
 */
export function loadRegistry(opts: { calendarsFile: string; principalsFile: string }): Registry {
  const errors: string[] = []
  const rawCalendars = readJsonObject(opts.calendarsFile, errors)
  const rawPrincipals = readJsonObject(opts.principalsFile, errors)

  const calendars = rawCalendars ? parseCalendars(rawCalendars, errors) : new Map()
  const { principals, byKeyHash } = rawPrincipals
    ? parsePrincipals(rawPrincipals, calendars, errors)
    : { principals: new Map<string, Principal>(), byKeyHash: new Map<string, string>() }

  if (principals.size === 0) {
    errors.push("no usable principal loaded — every authenticated route will answer 401")
  }

  return { calendars, principals, byKeyHash, errors }
}

/** Resolves a presented API key to a principal, or null. */
export function resolvePrincipal(registry: Registry, apiKey: string | null): Principal | null {
  const key = (apiKey ?? "").trim()
  if (!key) return null
  // Lookup is by hash, so the raw key never sits in a Map key that could end up
  // in a heap dump or a debug print of the registry.
  const name = registry.byKeyHash.get(hashKey(key))
  if (!name) return null
  return registry.principals.get(name) ?? null
}

export function canWrite(principal: Principal): boolean {
  return principal.role === "write"
}

/** Resolves an alias or raw calendar id, restricted to what the principal has. */
export function resolveCalendar(
  registry: Registry,
  principal: Principal,
  ref: string
): CalendarEntry | null {
  const wanted = (ref ?? "").trim()
  if (!wanted) return null
  for (const alias of principal.calendars) {
    const cal = registry.calendars.get(alias)
    if (!cal) continue
    if (cal.alias === wanted || cal.id.toLowerCase() === wanted.toLowerCase()) return cal
  }
  return null
}

export function calendarsOf(registry: Registry, principal: Principal): CalendarEntry[] {
  return principal.calendars
    .map((alias) => registry.calendars.get(alias))
    .filter((c): c is CalendarEntry => c !== undefined)
}

/**
 * Safe to hand to a client. Deliberately without key_sha256: the registry
 * dump must not become the offline-cracking oracle we did not build.
 */
export function describePrincipal(
  registry: Registry,
  principal: Principal
): { name: string; role: Role; calendars: Array<{ alias: string; id: string; access: Access; description: string | null }> } {
  return {
    name: principal.name,
    role: principal.role,
    calendars: calendarsOf(registry, principal).map((c) => ({
      alias: c.alias,
      id: c.id,
      access: c.access,
      description: c.description ?? null,
    })),
  }
}
