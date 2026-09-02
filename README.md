# calendar-gate

Headless, multi-user Google Calendar gateway for AI agents. HTTP + MCP, Bun, no
dependencies. Runs on HermesTools at port **8009**, reachable only through nginx
on `:8080`.

Three requirements shape it, and none of them is a feature:

1. **Headless.** A service account JWT signed locally, traded for a one-hour
   access token. No browser, ever, including in disaster recovery.
2. **Multi-user.** One credential; each person shares their own calendar with
   the service account, at the level they choose.
3. **Bounded damage.** An agent hallucinating in a loop, or someone who got into
   the machine, must not be able to wreck an agenda. Write caps, date guards,
   conflict checks, per-key calendar allowlists, and no delete at all.

## Two layers of permission

**Layer 1, at Google, outside this code.** The service account sees only the
calendars explicitly shared with its address. Someone holding the key file
reaches exactly that set and nothing else: no unshared calendar, no Gmail, no
Drive. Revoking is removing the share in the Google UI, and it takes effect
immediately without touching this service.

The owner of each calendar also chooses how much is visible:

| Google share level | `access` in `calendars.json` | What the service can do |
|---|---|---|
| See only free/busy | `busy_only` | availability, no titles, never writes |
| See all event details | `details` | read events with titles |
| Make changes to events | `details` | read and write |

**Layer 2, here.** Each API key is a principal with a name, a role and a list of
calendars. This is what keeps the sandbox agent away from a calendar that was
shared with the service account for a different agent's use.

```
claude-code-thiago   write   [thiago, familia]
jaci-thilia          write   [thilia, familia]
openclaw             read    [familia]
```

## No guests, no RSVP

A service account cannot invite anyone without Domain-Wide Delegation, which
requires Google Workspace. So "meeting with Thilia" is not one event with
guests: it is the same event created on each participant's own calendar, tied
together by a `group_id` in `extendedProperties.private`. Updating the group
updates every copy.

The cost is accepted explicitly: nobody accepts or declines, and an external
participant has to be invited by hand in Google Calendar. An `attendees` field
in a request is rejected with a message explaining this, so an agent does not
keep retrying into a 403 from Google.

## Endpoints

| Method | Route | Role | What |
|---|---|---|---|
| GET | `/health` | none | alive, and whether the credential authenticates |
| GET | `/calendars` | read | this principal's calendars, with access level |
| POST | `/events/search` | read | events in a window |
| POST | `/conflicts` | read | what collides with a slot |
| POST | `/free-slots` | read | gaps long enough for a meeting |
| POST | `/events` | write | create, fanned out across calendars |
| PATCH | `/events/group/:group_id` | write | update every copy |
| GET/POST | `/mcp` | per tool | MCP over Streamable HTTP |

Every route except `/health` requires `X-Api-Key`, **including `/mcp`**. That
diverges from the other services in this fleet, where `/mcp` is open and trusted
via the nginx route. An open `/mcp` here would let any local process write to
anyone's calendar with no credential.

`/health` answers 503 when the Google credential is failing, with a `next_step`
saying what to check, and fires one alert per hour through gossip-gate.

## MCP tools

| Tool | Role | What |
|---|---|---|
| `list_calendars` | read | calendars this key reaches, with access level |
| `search_events` | read | events by window and text |
| `check_conflicts` | read | what collides; titles only where allowed |
| `find_free_slots` | read | free gaps in working hours |
| `create_event` | write | create on one or more calendars, linked by `group_id` |
| `update_event` | write | update every copy of a `group_id` |

`tools/list` is filtered by role: a `read` key never sees the write tools. A
tool the model cannot see is a tool it cannot hallucinate calling.

## Guards

1. **Calendar allowlist** — only the principal's set, redundantly with Google.
2. **Role** — `read` never reaches a write route, and never sees the write tools.
3. **Write caps** — per minute and per day. A fan-out to three calendars counts
   as three. Over the cap is a 429 plus one Telegram alert per breach.
4. **Date guard** — refuses a start more than 24h in the past without
   `allow_past`, and more than two years ahead. Catches year typos.
5. **Conflicts block writes** — `create` and `update` check for themselves and
   answer 409 with the colliding events unless `allow_conflict: true`.
6. **Fail closed on unreadable calendars** — if a calendar cannot be read, the
   answer is an error, not "the day is free". Override with `partial_ok: true`.
7. **Idempotency** — the event id is `sha256(idempotency_key + calendar_id)` in
   base32hex, so a retry answers `created: false` instead of duplicating.
8. **All or nothing on fan-out** — a denied calendar aborts before any copy is
   created. A partial failure answers 207 with the outcome per calendar, never a
   truthful-looking 200.
9. **No delete** — no endpoint, no tool, no wrapper. Deleting is done by a human
   in Google Calendar.
10. **`attendees` rejected** at the door, with the reason.

## Configuration

Three files next to the service, all `chmod 600` except where noted:

- `.env` — see `.env.example`.
- `sa-key.json` — the service account key, downloaded from the GCP console.
- `calendars.json` — alias, calendar id and share level. See the example.
- `principals.json` — one entry per API key, holding the **SHA-256 of the key**,
  never the key. See the example.

Generate a key and its hash:

```bash
KEY=$(openssl rand -hex 32); echo "key: $KEY"
printf '%s' "$KEY" | sha256sum
```

`SIGHUP` reloads `calendars.json` and `principals.json` and drops the cached
credential, so adding or revoking a principal, or rotating the Google key, needs
no restart:

```bash
systemctl reload calendar-gate    # or: kill -HUP $(pidof bun)
```

## Audit

`logs/YYYY-MM-DD.ndjson`, 30 days. Every write and **every denial** is recorded
with the principal, the operation, the calendar aliases, event ids, group id and
the guard that refused. A run of `CALENDAR_DENIED` entries is what an agent in a
loop, or an intruder probing the allowlist, looks like.

No API key, no key hash, no access token and no fragment of the service account
JSON is ever written to the log.

## Tests

```bash
bun test
```

Pure units, no network: id derivation, the principal registry, the guards,
overlap and free-slot maths across a DST boundary, fan-out planning, and the MCP
layer including the role filter on `tools/list`.

## Setup

See [SETUP.md](SETUP.md) for the Google Cloud steps, the sharing, and the
deploy to HermesTools.
