/**
 * calendar-gate — headless multi-user Google Calendar gateway for agents.
 *
 * Three requirements shape this service, and none of them is a feature:
 * it runs headless (a service account JWT, never a browser), it serves several
 * people through one credential (each principal reaches only its own
 * calendars), and it is built so that an agent hallucinating in a loop cannot
 * do damage (write caps, date guards, conflict checks, no delete at all).
 *
 * This file only wires the pieces together and starts listening. The rules
 * live in service/calendar-service.ts; transport/http.ts and transport/mcp.ts
 * are thin layers over them.
 */

import { loadConfig } from "./config"
import { WriteLimiter } from "./core/policy"
import { ServiceAccountAuth } from "./google/auth"
import { CalendarClient } from "./google/calendar"
import { createAuditLog, log } from "./logger"
import { loadRegistry, type Registry } from "./principals"
import { createAlerts } from "./service/alerts"
import { createCalendarService } from "./service/calendar-service"
import { createFetchHandler } from "./transport/http"

const config = loadConfig()
const auth = new ServiceAccountAuth(config.saKeyFile)
const audit = createAuditLog({ dir: config.logDir, retentionDays: config.logRetentionDays })
const alerts = createAlerts({ url: config.gossipUrl, apiKey: config.gossipApiKey })

let registry: Registry = loadRegistry(config)
for (const problem of registry.errors) log("registry problem", { problem })

const handlers = createCalendarService({
  config,
  calendar: new CalendarClient(auth),
  registry: () => registry,
  limiter: new WriteLimiter(config.maxWritesPerMin, config.maxWritesPerDay),
  audit,
  alerts,
})

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch: createFetchHandler({ handlers, registry: () => registry, auth, audit, alerts }),
})

// Reload principals and calendars without a restart, so revoking an agent does
// not interrupt the others. Also drops the cached key, which is what makes a
// rotated sa-key.json take effect.
process.on("SIGHUP", () => {
  registry = loadRegistry(config)
  auth.reset()
  log("registry reloaded via SIGHUP", {
    principals: registry.principals.size,
    calendars: registry.calendars.size,
    problems: registry.errors.length,
  })
  for (const problem of registry.errors) log("registry problem", { problem })
})

log("calendar-gate listening", {
  host: config.host,
  port: server.port,
  principals: registry.principals.size,
  calendars: registry.calendars.size,
  timezone: config.defaultTimezone,
})
