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
  gossipUrl: string
  gossipApiKey: string
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function loadConfig(): Config {
  const dir = import.meta.dir
  return {
    port: num("PORT", 8009),
    // Loopback by default, not 0.0.0.0. Three services in this fleet listen on
    // `*` and today only the iptables INPUT DROP protects them. Not repeated.
    host: process.env.HOST || "127.0.0.1",
    saKeyFile: process.env.GOOGLE_SA_KEY_FILE || join(dir, "sa-key.json"),
    calendarsFile: process.env.CALENDARS_FILE || join(dir, "calendars.json"),
    principalsFile: process.env.PRINCIPALS_FILE || join(dir, "principals.json"),
    defaultTimezone: process.env.DEFAULT_TIMEZONE || "Europe/Lisbon",
    maxWritesPerMin: num("MAX_WRITES_PER_MIN", 10),
    maxWritesPerDay: num("MAX_WRITES_PER_DAY", 50),
    maxPastHours: num("MAX_PAST_HOURS", 24),
    maxFutureDays: num("MAX_FUTURE_DAYS", 730),
    gossipUrl: process.env.GOSSIP_URL || "http://127.0.0.1:8080/api/gossip-gate/send",
    gossipApiKey: process.env.GOSSIP_API_KEY || "",
  }
}
