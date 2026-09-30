/**
 * service/alerts.ts — Telegram alerts through gossip-gate. No key, no alerts.
 */

import type { AuthError } from "../google/auth"
import { log } from "../logger"

export interface Alerts {
  notify(message: string): Promise<void>
  authFailure(e: AuthError): Promise<void>
}

const AUTH_ALERT_INTERVAL_MS = 60 * 60 * 1000

export function createAlerts(opts: {
  url: string
  apiKey: string
  fetch?: typeof fetch
  now?: () => number
}): Alerts {
  const send = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  let lastAuthAlert = 0

  async function notify(message: string): Promise<void> {
    if (!opts.apiKey) return
    try {
      await send(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": opts.apiKey },
        body: JSON.stringify({ message }),
      })
    } catch (e) {
      log("gossip-gate notification failed", { error: String(e) })
    }
  }

  return {
    notify,
    /**
     * A credential failure would otherwise stay invisible until an agent
     * happened to try something. Throttled to one alert an hour so a broken
     * key does not turn into a message storm.
     */
    async authFailure(e) {
      const t = now()
      if (t - lastAuthAlert < AUTH_ALERT_INTERVAL_MS) return
      lastAuthAlert = t
      await notify(`calendar-gate: Google credential is failing.\n${e.message}\n\n${e.actionable}`)
    },
  }
}
