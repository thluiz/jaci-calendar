# Changelog

## 0.1.0 — unreleased

First implementation, from the plan of 2026-08-29 (service account revision).

### Added — 2026-09-02

- Service account auth (`google/auth.ts`): RS256 JWT signed with `crypto.subtle`,
  traded for a one-hour access token, cached in memory and refreshed a minute
  early. No browser anywhere, no dependency, and the token never touches disk or
  a log line.
- Calendar API wrappers (`google/calendar.ts`): `listEvents` (always
  `singleEvents=true`, so recurring events show as occurrences), `freeBusy`,
  `getEvent`, `insertEvent` with a client-chosen id, `patchEvent`, and
  `findByGroupId`. No delete wrapper, by design.
- Principal registry (`principals.ts`): one principal per API key, storing the
  key's SHA-256 and a calendar allowlist. Reloaded on `SIGHUP`.
- Guards (`policy.ts`): input validation with `attendees` rejected and explained,
  date guard for past and far-future starts, sliding write caps per minute and
  per day where a fan-out costs N.
- Conflict detection and free-slot search (`conflicts.ts`, `timezone.ts`):
  touching intervals do not conflict, transparent, cancelled, declined and
  Google-injected events are ignored, all-day boundaries are resolved in the
  calendar's own zone, and the working-day window is walked day by day so a DST
  transition does not drift it.
- Fan-out (`fanout.ts`): one copy per participant, linked by `group_id`,
  deterministic event ids from the idempotency key, all-or-nothing calendar
  resolution and a 207 answer on partial failure.
- HTTP API and MCP server, sharing the same functions so the two cannot drift.
  `tools/list` is filtered by role.
- Audit log (`logger.ts`): daily NDJSON of writes and denials, without secrets.

### Fixed — 2026-09-02

- Default timezone changed from `America/Sao_Paulo` to `Europe/Lisbon`: the
  calendar actually shared with the service account declares Europe/Lisbon, and
  the users are in Portugal, where DST (unlike Brazil) means the offset is not a
  fixed distance from UTC.
- Denials now reach the audit log on both transports. `CALENDAR_DENIED` (403)
  and input rejections were raised before the handlers that wrote their own
  audit line, so they never appeared — including every denial from MCP, the
  transport the main agent actually uses. Both transports now funnel through
  one `run()` choke point that logs the refusal, with unauthorized requests
  logged under `"(unknown)"` rather than dropped.
- `GET /mcp`'s SSE keep-alive now stays open and heartbeats every 25s instead
  of closing immediately after one comment. OpenClaw holds the connection and
  was reopening it ~10 times a minute (~14k log entries a day), burying the
  audit trail the log exists for.

### Fixed — 2026-09-11

- `search_events` and `check_conflicts` now echo `group_id` on any event that
  carries one. Previously the field was read from `extendedProperties.private`
  for conflict-skipping but never included in the response, so a session that
  had not seen the original `create_event` call — a different agent session, or
  the same agent on a later day — had no way to recover the `group_id` that
  `update_event` requires, and could not edit an event it had itself created
  through calendar-gate earlier.

### Fixed — 2026-09-30

- `search_events` dropped every event marked free, because it shared the
  conflict check's filter. All-day events are marked free so they stop blocking
  slots, and they vanished from the morning briefing with it. The listing now
  keeps them, flagged `show_as: "free"`; `check_conflicts` and
  `find_free_slots` still ignore them.

### Fixed — 2026-09-27

- `find_free_slots` found no free hour in the week of 2026-09-28 because of an
  all-day event, "Handmade Market Bolhão" (2026-09-28 to 2026-10-03), marked busy: it
  correctly blocked every working hour of the week, but the answer was a bare
  empty list the agent could not explain. All-day events marked busy now come
  back in `all_day_blocks` with a note, and `ignore_all_day: true` recomputes
  without them once the person confirms they do not block anything. The tool
  description also says that each slot's `duration_minutes` is the whole gap,
  not the meeting.
- New events follow the Google Calendar UI on availability: all-day shows as
  free, timed as busy. The API defaults everything to busy, so every all-day
  event created here blocked whole days. `show_as: "free" | "busy"` overrides it
  on create, and sets it on update; an update that only moves dates keeps what
  the event had. A free event is not checked for conflicts.
- A plain date in `time_min`/`time_max` (search, free slots) or in
  `check_conflicts` is rejected with the timestamp to send instead. It used to go
  straight to Google, which answers 400, and came back as `CALENDAR_UNREADABLE`
  — "could not read the calendar", a false diagnosis.
- The conflict check of an all-day `create_event`/`update_event` sent the plain
  dates to Google the same way, so it always failed with that false
  `CALENDAR_UNREADABLE` unless `allow_conflict` was set. It now queries midnight
  to midnight in the event's zone.

### Decisions worth remembering — 2026-09-02

- **`/mcp` requires a key**, unlike the other services in this fleet. An open
  `/mcp` would let any local process write to anyone's calendar.
- **Reads fail closed.** A calendar that could not be read makes the service
  answer 502 rather than report an empty agenda; `partial_ok: true` overrides.
- **Loopback only.** The service binds `127.0.0.1`, and its nginx route lives in
  a new `loopback/` include used only by the `:8080` server block, because
  `local/` is also served on `:18443` and reachable over ZeroTier.
