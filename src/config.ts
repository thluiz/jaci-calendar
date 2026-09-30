// Configuration from the environment. No secret lives in code or in the systemd
// unit: the service account key is a chmod 600 file pointed at from here.

import { join } from "path"

export interface Config {
  port: number
  host: string
  saKeyFile: string
  calendarsFile: string
  principalsFile: string
  defaultTimezone: string
  maxWritesPerMin: number
  maxWritesPerDay: number
  maxPastHours: number
  maxFutureDays: number
  logDir: string
  logRetentionDays: number
  gossipUrl: string
  gossipApiKey: string
}

/**
 * The repository root, one level above src/. Relative defaults hang from here
 * so the key file, the registries and logs/ stay where they were before the
 * source moved into src/, and an existing deploy keeps its audit history.
 */
export const ROOT_DIR = join(import.meta.dir, "..")

type Env = Record<string, string | undefined>

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function loadConfig(env: Env = process.env): Config {
  return {
    port: num(env, "PORT", 8009),
    // Loopback by default, not 0.0.0.0. Three services in this fleet listen on
    // `*` and today only the iptables INPUT DROP protects them. Not repeated.
    host: env.HOST || "127.0.0.1",
    saKeyFile: env.GOOGLE_SA_KEY_FILE || join(ROOT_DIR, "sa-key.json"),
    calendarsFile: env.CALENDARS_FILE || join(ROOT_DIR, "calendars.json"),
    principalsFile: env.PRINCIPALS_FILE || join(ROOT_DIR, "principals.json"),
    defaultTimezone: env.DEFAULT_TIMEZONE || "Europe/Lisbon",
    maxWritesPerMin: num(env, "MAX_WRITES_PER_MIN", 10),
    maxWritesPerDay: num(env, "MAX_WRITES_PER_DAY", 50),
    maxPastHours: num(env, "MAX_PAST_HOURS", 24),
    maxFutureDays: num(env, "MAX_FUTURE_DAYS", 730),
    logDir: env.LOG_DIR || join(ROOT_DIR, "logs"),
    logRetentionDays: num(env, "LOG_RETENTION_DAYS", 30),
    gossipUrl: env.GOSSIP_URL || "http://127.0.0.1:8080/api/gossip-gate/send",
    gossipApiKey: env.GOSSIP_API_KEY || "",
  }
}
