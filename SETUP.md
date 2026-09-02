# Setup

Two halves. The first is done by hand in the Google console and cannot be
automated; the second is the deploy on HermesTools.

## Part 1 — Google Cloud

No consent screen, no app publishing, no verification, no browser step in
operation. A service account is machine-to-machine from the start.

1. **Project.** [console.cloud.google.com](https://console.cloud.google.com) →
   project picker → **New project** → name it `hermes-calendar` → Create, then
   make sure it is the selected project.

2. **Enable the API.** *APIs & Services → Library* → search **Google Calendar
   API** → **Enable**. This is the only API needed.

3. **Service account.** *IAM & Admin → Service Accounts → Create service
   account*. Name `calendar-gate`. **Skip the "Grant this service account access
   to the project" step**: IAM roles govern GCP resources, and calendar access
   comes only from sharing. Create.

4. **Key.** Open the service account → **Keys → Add key → Create new key →
   JSON** → Create. The file downloads once. It is the entire credential; treat
   it like a password.

5. **Copy the address.** It looks like
   `calendar-gate@hermes-calendar.iam.gserviceaccount.com`. Every calendar gets
   shared with this address.

6. **Share each calendar.** In [calendar.google.com](https://calendar.google.com),
   for each calendar that enters the system, the **owner** opens *Settings for
   my calendars → <calendar> → Share with specific people or groups → Add
   people*, pastes the service account address and picks a permission:

   | Calendar | Permission to pick | `access` in `calendars.json` |
   |---|---|---|
   | agents will create events on it | **Make changes to events** | `details` |
   | only checked for availability | **See only free/busy (hide details)** | `busy_only` |

   This step is where the real security of the system lives. A calendar that was
   never shared is unreachable, whatever happens on the machine. Each owner
   decides for themselves, in their own interface, and can revoke at any time
   without anyone touching the service.

   > Sharing a personal calendar with someone outside the domain sometimes needs
   > confirming an e-mail Google sends. A service account has no inbox: if the
   > share stays pending, the workaround is to share the calendar with a
   > *secondary* calendar you own, or to have the owner add the address from
   > their own account settings page rather than from the sharing dialog.

7. **Copy each Calendar ID.** Same settings page, section *Integrate calendar*.
   A personal calendar's id is the e-mail address; a secondary calendar's ends
   in `@group.calendar.google.com`.

8. **Verify.** After the deploy, `GET /health` answering
   `google_authenticated: true` proves the whole chain works. It is the first
   check to run.

## Part 2 — Deploy on HermesTools

Source lives on the Windows host at `E:\jaci-calendar\`; the service runs at
`/home/hermes/services/calendar-gate/`.

1. **Sync the source.** Windows to WSL goes through base64, per the house rule.
   `sa-key.json`, `principals.json` and `calendars.json` are created **inside**
   the distro with a heredoc, never through a pipe, then `chmod 600`.

2. **Config files.**

   ```bash
   cd /home/hermes/services/calendar-gate
   cp .env.example .env && chmod 600 .env
   # write sa-key.json, calendars.json, principals.json, then:
   chmod 600 sa-key.json principals.json calendars.json
   ```

3. **API keys.** One per agent. Generate the key, store the **hash** in
   `principals.json`, and hand the key itself only to the agent that uses it:

   ```bash
   KEY=$(openssl rand -hex 32); echo "key: $KEY"; printf '%s' "$KEY" | sha256sum
   ```

4. **systemd.** Copy `deploy/calendar-gate.service` to
   `/etc/systemd/system/`, then:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now calendar-gate
   systemctl status calendar-gate --no-pager
   ```

5. **nginx.** The route goes in a **new** `hermes-routes/loopback/` directory,
   included only from the `:8080` server block. It must not go into
   `hermes-routes/local/`, which is also served on `:18443` and is therefore
   reachable over ZeroTier from another machine.

   ```bash
   sudo mkdir -p /etc/nginx/hermes-routes/loopback
   sudo cp deploy/calendar-gate.conf /etc/nginx/hermes-routes/loopback/
   # add, inside the :8080 server block only:
   #   include /etc/nginx/hermes-routes/loopback/*.conf;
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Editing `sites-enabled/hermes-proxy` touches shared infrastructure: back the
   file up first, edit with an anchor rather than rewriting it, and never reload
   before `nginx -t` passes.

6. **Firewall: nothing to do.** Port 8009 is never opened. The service is
   reached only over `lo`, through nginx.

7. **Register the MCP server** in `~/.claude.json` under
   `projects["E:/"].mcpServers`:

   ```json
   "calendar-gate": {
     "type": "http",
     "url": "http://localhost:8080/api/calendar-gate/mcp",
     "headers": { "X-Api-Key": "<the claude-code-thiago key>" }
   }
   ```

## Verification

Run in this order. The first one is the one that proves the architecture.

| # | Check | Expected |
|---|---|---|
| 1 | `GET /health` with no key | 200, `google_authenticated: true` |
| 2 | `GET /calendars` with no key | 401 |
| 3 | `GET /calendars` with the read key | only that principal's calendars |
| 4 | `POST /events` with the read key | 403 `READ_ONLY_PRINCIPAL` |
| 5 | `POST /events` with `dry_run: true` | the payload, nothing on the calendar |
| 6 | `POST /events` for real | event visible in Google Calendar |
| 7 | repeat 6 with the same `idempotency_key` | `created: false`, one event |
| 8 | `POST /events` across two people | two copies, one `group_id` |
| 9 | `PATCH /events/group/:id` moving the time | both copies move |
| 10 | `POST /events` including a calendar outside the set | 403, **no copy anywhere** |
| 11 | `POST /conflicts` on a `busy_only` calendar | `detail: "busy_only"`, no title |
| 12 | `POST /events` overlapping | 409 with the conflicts; 201 with `allow_conflict` |
| 13 | `POST /events` with `attendees` | 400 explaining the fan-out |
| 14 | 15 writes in a minute | 429 past the cap, one Telegram alert |
| 15 | `cat logs/$(date +%F).ndjson` | writes and denials, no key anywhere |
| 16 | read an **unshared** calendar with the access token, directly at Google | 403/404 — proves the containment |
| 17 | remove a share in the Google UI, read again | fails, with nothing changed here |
| 18 | `curl -k https://10.147.18.163:18443/api/calendar-gate/health` from ZeroTier | **404** — if it answers 200 the route landed in `local/` |
| 19 | `tools/list` with no key / read key / write key | 401 / 4 tools / 6 tools |
| 20 | in Claude Code: "find an hour free on Thursday for me and Thilia", then "create it" | exercises the tool descriptions, the fan-out and `busy_only` reads |

## Rollback

`systemctl disable --now calendar-gate`, remove the `.conf` and the `include`
line, restore the `hermes-proxy` backup, `nginx -t && systemctl reload nginx`,
drop the entry from `.claude.json`, delete the key in the GCP console and remove
the shares. No existing service is modified by any of this.
