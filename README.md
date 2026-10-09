# TOA + Quickbase MCP wrapper

A small remote MCP server that lets Claude read data from **TOA** (`https://app.toa.energy/api/x`) and, optionally, **Quickbase**, as a custom connector. TOA only has a REST API, so this is the bridge.

Everything is **read-only**. Nothing Claude does through this connector can create, change or delete data in TOA or Quickbase.

- Claude <-> this server: protected by per-person named secrets (`MCP_SHARED_SECRETS`).
- This server <-> TOA / Quickbase: API tokens (`TOA_API_TOKEN`, `QB_USER_TOKEN`) kept server-side only. Claude never sees them.

## Tools

All tools are annotated read-only.

- **TOA (21):** projects, customers, sites, tracks, work types, work (list/get), form submissions, events, assignments, teams, users, and the `/changes` sync feed (`src/tools.js`). TOA's `POST /work` and `PATCH /work/:id` are deliberately not implemented.
- **Quickbase, raw (7):** `qb_get_app`, `qb_list_tables`, `qb_get_table`, `qb_list_fields`, `qb_list_reports`, `qb_run_report`, `qb_query_records` (`src/quickbase.js`). Only GETs plus the records-query and report-run POSTs are allowed in code.
- **Quickbase, by name (3):** `qb_search_records` (table and field *names*, filters, sort, no IDs needed), `qb_find_project` (by customer name, address, record ID or Enerflo deal ID), `qb_count_records` (totals or group-by) (`src/qbSmart.js`).
- **Ops (6):** `toa_schedule` (day or range, by team), `crew_workload` (unassigned, double-booked, overloaded days), `toa_schedule_stats` (repeat visits, lead time, by team), `qb_match_project_toa` (compare name, address, size, phone, email), `project_360` (Quickbase + TOA + events + work in one view), `sync_check` (Quickbase "Create Job in TOA" vs. what exists in TOA) (`src/ops.js`).
- **Install / M2 triage (6):** `wip_install_triage` (installs not truly complete; flags FALSE COMPLETE when Quickbase says done but no install task was submitted), `project_schedule_history` (original vs current date, reschedules, go-backs booked as Service, TOA events), `aging_stalls` (oldest stuck installs), `m2_readiness` (inspection/permit/M2 blockers and the PC who owns the next step), `battery_only_projects` (size under 1 kW, blank-market flag), `test_record_check` (Test Project flag plus name check) (`src/triage.js`). All default to Kin Home, non-test projects (`scope`: kin / other / all). Field-task history comes from the Arrivy task mirror table (`QB_TASKS_TABLE_ID`, default `bvbqgs5yc`).
Quickbase tools only appear if `QB_USER_TOKEN` and `QB_REALM_HOSTNAME` are set.

## Kin conventions built in

- A system size of **0.00001 kW** means a **battery-only** project.
- Quickbase and TOA gaps are expected while integrations are still being built.
- Quickbase date-times arrive in UTC and are shown in **Mountain Time**.
- Server instructions tell Claude to try Sparky (separate connector) and, with the user's OK, Dev (Quickbase schema questions) when this connector can't resolve something. Resolution errors include a `hint` to that effect.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TOA_API_TOKEN` | yes | TOA installer API token |
| `MCP_SHARED_SECRETS` | yes | Named secrets, `name:secret,name2:secret2` |
| `QB_USER_TOKEN` | for Quickbase | Quickbase user token (acts with that user's permissions) |
| `QB_REALM_HOSTNAME` | for Quickbase | e.g. `yourcompany.quickbase.com` |
| `QB_APP_ID` | optional | Default Quickbase app, so nobody has to supply an app ID |
| `QB_PROJECTS_TABLE_ID` | optional | Projects table (defaults to `br9kwm8na`) |
| `TOA_BASE_URL`, `QB_BASE_URL`, `PORT` | optional | Overrides (Railway sets `PORT` itself) |

## Run it locally

```
cp .env.example .env
# fill in the values; generate each secret with: openssl rand -hex 32
npm install
npm start
```

Smoke test (in another terminal):

```
curl -s http://localhost:3000/          # -> {"ok":true,...}

curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Hosting (Railway)

This is deployed on Railway, from this GitHub repo.

1. Railway -> New Project -> Deploy from GitHub repo -> this repo. The `Dockerfile` is detected automatically, and every push to `main` redeploys.
2. Service -> **Variables**: add the variables above.
3. Service -> **Settings -> Networking -> Generate Domain** to get the public HTTPS URL.

Check a deploy by calling `GET /` (health) and then `tools/list` as above. Per-deployment logs are under Deployments -> Deploy Logs / Network Logs.

## Add it to Claude

Each person adds it in their own Claude account: **Settings -> Connectors -> Add custom connector**.

- **URL:** `https://<your-railway-domain>/mcp`
- **Authentication:** **No sign-in**
- **Request header:** name `authorization`, value `Bearer ` followed by **that person's own secret only**

Gotchas that have bitten before:
- The header value is `Bearer ` + one secret. Not the whole `MCP_SHARED_SECRETS` line, no `name:` prefix, no angle brackets, no quotes.
- Paste once. Clear the field first (Cmd+A, Delete). A correct value is 7 + 64 = 71 characters.
- The URL can't be edited after creation. To change it, remove the connector and add it again.
- Claude caches a connector's tool list per chat, so after a deploy that changes tools, start a new chat (or Reconnect).

## Adding and revoking people

Generate a secret with `openssl rand -hex 32`, add `name:secret` to `MCP_SHARED_SECRETS` in Railway Variables (comma-separated), and save. Railway redeploys. To revoke someone, remove their pair and save. The legacy single `MCP_SHARED_SECRET` variable is still accepted as the user `default`.

## Notes

- **Stateless server:** a fresh MCP server and transport are created for every request. Reusing one shared instance caused 500s on `initialize`.
- **Rate limits:** TOA throttles per token. Quickbase has per-IP limits (429 when exceeded). Fine for ad hoc questions; cache if you start pulling large lists often.
- **Write access:** not implemented, by design. TOA writes would mean adding `toa_create_work` / `toa_update_work` back in.
- **Permissions in Claude:** set the connector's tools to "Always allow" under Customize -> Connectors -> Tool permissions to avoid approval prompts.
- **Token rotation:** update the token in Railway Variables; nothing else changes.
