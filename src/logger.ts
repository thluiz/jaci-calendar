/**
 * logger.ts — audit trail: append-only NDJSON, one file per day.
 *
 * Denials are logged as carefully as writes. A run of 403s on calendars outside
 * a principal's set is exactly what an agent in a loop, or an intruder probing
 * the allowlist, looks like — and it is invisible if only successes are kept.
 *
 * No API key, no key hash, no access token and no fragment of the service
 * account JSON ever reaches this file.
 */

import { join } from "path"
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs"
import { appendFile } from "fs/promises"

export interface LogEntry {
  ts: string
  /** Principal name, which is an alias — never the key or its hash. */
  principal: string
  operation: string
  /** Calendar aliases, never raw ids: the log should not be the address book. */
  calendars?: string[]
  group_id?: string
  event_ids?: string[]
  outcome: "ok" | "denied" | "error" | "dry_run"
  /** Which guard denied it, when one did. */
  reason?: string
  status: number
}

export interface AuditLog {
  append(entry: LogEntry): Promise<void>
}

/**
 * Where the trail lives and for how long come from the caller rather than from
 * the environment, so a test can point it at a temporary directory.
 */
export function createAuditLog(opts: { dir: string; retentionDays: number }): AuditLog {
  let lastCleanupDate = ""

  return {
    async append(entry) {
      try {
        mkdirSync(opts.dir, { recursive: true })

        const today = new Date().toISOString().slice(0, 10)
        if (lastCleanupDate !== today) {
          lastCleanupDate = today
          cleanOldLogs(opts.dir, opts.retentionDays)
        }

        // Bun.write() silently ignores { append: true } and truncates the file,
        // which in gossip-gate left only the day's last entry on disk.
        await appendFile(join(opts.dir, `${today}.ndjson`), JSON.stringify(entry) + "\n", "utf8")
      } catch (e) {
        // An unwritable log must not take the service down, but it must be loud.
        console.error(JSON.stringify({ ts: new Date().toISOString(), msg: "audit log write failed", error: String(e) }))
      }
    },
  }
}

export function cleanOldLogs(dir: string, retentionDays: number, now = Date.now()): void {
  if (!existsSync(dir)) return
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ndjson")) continue
      const fileMs = new Date(file.replace(".ndjson", "")).getTime()
      if (!isNaN(fileMs) && fileMs < cutoff) unlinkSync(join(dir, file))
    }
  } catch {
    // non-fatal
  }
}

/** Structured stdout line, for journalctl. Same discipline about secrets. */
export function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...(extra ?? {}) }))
}
