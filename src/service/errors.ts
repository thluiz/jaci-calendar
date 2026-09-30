/**
 * service/errors.ts — the error vocabulary shared by both transports, and its
 * mapping to an HTTP-style status and body.
 */

import type { PolicyViolation } from "../core/policy"
import { AuthError } from "../google/auth"
import { CalendarApiError } from "../google/calendar"

export class ApiError extends Error {
  /**
   * Set by the handlers that already wrote a richer audit line (with the group
   * id and the calendars). Everything else is audited centrally, so a denial
   * cannot be lost just because it was raised early.
   */
  audited = false

  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly extra?: unknown
  ) {
    super(message)
    this.name = "ApiError"
  }

  static from(v: PolicyViolation): ApiError {
    return new ApiError(v.code, v.message, v.status)
  }
}

/** Auth failures deserve a 503 with something to act on, not a generic 500. */
export function toResponseError(e: unknown): { status: number; body: Record<string, unknown> } {
  if (e instanceof ApiError) {
    return {
      status: e.status,
      body: { error: e.code, message: e.message, ...(e.extra ? { detail: e.extra } : {}) },
    }
  }
  if (e instanceof AuthError) {
    return {
      status: 503,
      body: { error: "GOOGLE_AUTH_FAILED", message: e.message, next_step: e.actionable },
    }
  }
  if (e instanceof CalendarApiError) {
    return { status: e.status === 403 ? 403 : 502, body: { error: "GOOGLE_API_ERROR", message: e.message } }
  }
  return { status: 500, body: { error: "INTERNAL", message: String((e as Error)?.message ?? e) } }
}
