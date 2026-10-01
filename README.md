# TOA MCP wrapper

A small remote MCP server that wraps TOA's REST API (`https://app.toa.energy/api/x`)
so it can be added to Claude as a **custom connector**. TOA itself has no MCP
server — this is the bridge.

- Claude <-> this server: protected by a shared secret you make up (`MCP_SHARED_SECRET`).
- This server <-> TOA: your TOA installer API token (`TOA_API_TOKEN`), kept
  server-side only. Claude never sees it.

21 **read-only** tools are registered, covering everything readable in TOA's
documented API: projects, customers, sites, tracks, work types, work
(list/get), form submissions, events, assignments, teams, users, and the
`/changes` sync feed. There is no create/update — TOA's `POST /work` and
`PATCH /work/:id` are deliberately left unimplemented, so nothing Claude
does through this connector can change data in TOA. See `src/tools.js` for
the full list, and the comment near the top of `registerAllTools` if you
ever want to add write tools back in.

## 1. Run it locally (sanity check)

```
cp .env.example .env
# fill in TOA_API_TOKEN (from your TOA admin) and MCP_SHARED_SECRET (openssl rand -hex 32)
npm install
npm start
```

Then from another terminal:

```
curl -s http://localhost:3000/          # -> {"ok":true,...}

curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The second call should return the 21 registered tools as JSON.

> Note: I wrote and syntax-checked this code against the current MCP
> TypeScript SDK source directly from GitHub, but couldn't run a live
> `npm install` in my sandbox (the npm registry is blocked there by policy).
> Run the smoke test above once you've deployed — if something doesn't
> line up with the SDK's exact current API, that's the first place it'll show.

## 2. Deploy it somewhere with a public HTTPS URL

Claude's custom connectors need a URL it can reach over the internet — pick
whichever of these you actually have an account for:

**Render.com** (simplest, free tier, no GitHub required)
1. New -> Web Service -> "Deploy an existing image" or connect a repo.
2. If you don't want to use Git: `render.yaml`/Docker deploy also works — or
   just push this folder to a throwaway GitHub repo on your *personal*
   account and connect that.
3. Set environment variables `TOA_API_TOKEN` and `MCP_SHARED_SECRET` in the
   Render dashboard (Environment tab).
4. Build command: `npm install` — Start command: `npm start`.
5. Render gives you a URL like `https://toa-mcp-wrapper.onrender.com`.

**Fly.io** (works well with just the Dockerfile here, no GitHub needed)
```
fly launch       # detects the Dockerfile, picks an app name
fly secrets set TOA_API_TOKEN=... MCP_SHARED_SECRET=...
fly deploy
```

**Railway** — same idea as Render if you have your own (non-work) Railway
account: new project -> deploy from this folder or a repo -> set the two
env vars -> it gives you a public URL.

Any platform that can run a Dockerfile or `npm install && npm start` and
gives you an HTTPS URL works.

## 3. Add it to Claude

In Claude, go to **Settings -> Connectors -> Add custom connector**:

- **URL**: `https://<your-deployed-host>/mcp`
- **Authentication**: choose **No sign-in**
- **Request headers**: add `Authorization: Bearer <your MCP_SHARED_SECRET>`

Click **Add**. Claude should list the TOA tools (`toa_list_projects`,
`toa_get_work`, etc.) the next time you ask it something that needs them.

## Notes / things to revisit

- **Rate limits**: TOA throttles per-token (serial per token, a per-minute
  and per-day cap). Fine for ad hoc questions; if you start pulling large
  lists often, read TOA's "Rate limits & sync" docs and consider caching.
- **Write access**: not implemented. When you're ready for Claude to create
  or update work in TOA, say so and I'll add `toa_create_work` /
  `toa_update_work` back in (they're documented in TOA's API but intentionally
  left out here).
- **Token rotation**: if TOA rotates your `TOA_API_TOKEN`, update it in
  your hosting platform's env vars and restart/redeploy — nothing else changes.
