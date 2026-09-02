/**
 * google/auth.ts — service account JWT, the part that replaces the refresh
 * token.
 *
 * There is no browser anywhere in this flow, which is the whole reason the
 * architecture changed: sign a JWT with the service account's private key,
 * trade it for a one-hour access token, repeat. Nothing expires, nothing needs
 * a consent screen, and disaster recovery is copying one file back.
 *
 * Roughly forty lines of crypto and zero dependencies, in line with the rest of
 * the fleet.
 */

import { readFileSync } from "fs"

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"

/**
 * Deliberately not the full `calendar` scope, which would allow creating and
 * deleting whole calendars. The scope is the ceiling; the real limit is which
 * calendars were shared with this service account.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
]

export class AuthError extends Error {
  constructor(
    message: string,
    readonly actionable: string
  ) {
    super(message)
    this.name = "AuthError"
  }
}

interface ServiceAccountKey {
  client_email: string
  private_key: string
  project_id?: string
}

function base64url(input: string | Uint8Array): string {
  const b64 = typeof input === "string" ? btoa(input) : Buffer.from(input).toString("base64")
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** PEM (PKCS#8) to DER. The key file ships the newlines escaped inside JSON. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "")
  return new Uint8Array(Buffer.from(body, "base64"))
}

export function readServiceAccountKey(path: string): ServiceAccountKey {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    throw new AuthError(
      `cannot read the service account key at ${path}: ${(e as Error).message}`,
      "Check GOOGLE_SA_KEY_FILE and that the file is readable by the service user (chmod 600, owned by hermes)."
    )
  }

  let parsed: ServiceAccountKey
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AuthError(
      `the service account key at ${path} is not valid JSON`,
      "Download the key again from the GCP console (Service Accounts, Keys, Add key, JSON) and copy it whole."
    )
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new AuthError(
      `the service account key at ${path} has no client_email or private_key`,
      "That file is probably an OAuth client secret, not a service account key. They are different downloads."
    )
  }
  return parsed
}

export class ServiceAccountAuth {
  private key: ServiceAccountKey | null = null
  private token: string | null = null
  private expiresAt = 0
  private inFlight: Promise<string> | null = null

  constructor(
    private readonly keyFile: string,
    private readonly scopes: string[] = SCOPES
  ) {}

  /** The service account's e-mail, which is what calendars get shared with. */
  clientEmail(): string {
    if (!this.key) this.key = readServiceAccountKey(this.keyFile)
    return this.key.client_email
  }

  /** Drops the cached key and token, so SIGHUP picks up a rotated key file. */
  reset(): void {
    this.key = null
    this.token = null
    this.expiresAt = 0
  }

  async getAccessToken(now: number = Date.now()): Promise<string> {
    // Refresh a minute early: a token that expires mid-request would surface as
    // a mystery 401 from the Calendar API.
    if (this.token && now < this.expiresAt - 60_000) return this.token
    if (this.inFlight) return this.inFlight

    this.inFlight = this.fetchToken(now).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async fetchToken(now: number): Promise<string> {
    if (!this.key) this.key = readServiceAccountKey(this.keyFile)

    const assertion = await this.signAssertion(this.key, now)

    let res: Response
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
      })
    } catch (e) {
      throw new AuthError(
        `cannot reach ${TOKEN_URL}: ${(e as Error).message}`,
        "Check outbound network from the WSL distro."
      )
    }

    const text = await res.text()
    if (!res.ok) {
      // The body carries error and error_description but never the assertion,
      // so it is safe to surface. The Authorization header never is.
      throw new AuthError(
        `token exchange failed (${res.status}): ${text.slice(0, 400)}`,
        text.includes("invalid_grant")
          ? "The key was rotated, deleted or the clock is off. Check the key in the GCP console and the system clock."
          : "Check that the Google Calendar API is enabled on the project."
      )
    }

    let body: { access_token?: string; expires_in?: number }
    try {
      body = JSON.parse(text)
    } catch {
      throw new AuthError("token endpoint returned a non-JSON body", "Retry; if it persists, check for a captive proxy.")
    }
    if (!body.access_token) {
      throw new AuthError("token endpoint returned no access_token", "Check the service account key file.")
    }

    this.token = body.access_token
    this.expiresAt = now + (body.expires_in ?? 3600) * 1000
    return this.token
  }

  private async signAssertion(key: ServiceAccountKey, now: number): Promise<string> {
    const iat = Math.floor(now / 1000)
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    const claims = base64url(
      JSON.stringify({
        iss: key.client_email,
        scope: this.scopes.join(" "),
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      })
    )
    const input = `${header}.${claims}`

    let cryptoKey: CryptoKey
    try {
      cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        pemToDer(key.private_key),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      )
    } catch (e) {
      throw new AuthError(
        `the private key could not be imported: ${(e as Error).message}`,
        "The private_key field must be the PKCS#8 PEM exactly as downloaded, newlines included."
      )
    }

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(input)
    )
    return `${input}.${base64url(new Uint8Array(signature))}`
  }
}
