# edookit-legacy-mcp — Status

## What was built

MCP server at `/Users/I779886/Developer/edookit-legacy-mcp/` that scrapes the Edookit parent/student portal web UI (`skolasquare.edookit.net`). Registered in `~/.claude/settings.json` as `edookit-portal`.

### 21 tools implemented

| Tool | Portal page |
|---|---|
| `portal_dashboard` | `/` |
| `portal_inbox` | `/overview/updates` |
| `portal_evaluations` | `/evaluation/` |
| `portal_assignments` | `/assignments/` |
| `portal_exams` | `/exams/` |
| `portal_materials` | `/materials/` |
| `portal_lesson_plans` | `/lesson-plans/` |
| `portal_timetable` | `/timetable/` |
| `portal_attendance` | `/attendance/` |
| `portal_excuse_absence` | POST `/attendance/` |
| `portal_report_absence` | POST `/attendance/report` |
| `portal_messages` | `/overview/updates` |
| `portal_get_message` | `/messages/detail?message=ID` |
| `portal_send_message` | POST `/messages/new` |
| `portal_payments` | `/payments/` |
| `portal_discussions` | `/discussions/` |
| `portal_courses` | `/courses/` |
| `portal_portfolios` | `/portfolios/` |
| `portal_library` | `/library/` |
| `portal_consents` | `/consents/` |
| `portal_search` | `/search/` |

### Why a new MCP (not the existing `edookit-mcp`)

The existing `edookit-mcp` (also in settings) calls the Edookit REST API — but the API is not enabled for this school. This MCP scrapes the portal HTML instead.

---

## Auth — current state (INCOMPLETE)

### How the portal authenticates

- Login goes via **Plus4U OIDC** (hosted at `uuidentity.plus4u.net`)
- Plus4U uses a **two-step form**: enter email → "Sign in" button → password field appears → submit
- After successful login, the portal sets `X-Auth-Id` and `PHPSESSID` cookies (valid ~10h / 2 weeks respectively)
- The login page hardcodes `prompt=none` in the OIDC auth request — this causes `interaction_required` errors unless it is stripped from outgoing requests

### What works

1. Playwright headless login flow completes successfully:
   - `prompt=none` is stripped via route interception (before `page.goto`)
   - Email filled → "Sign in" clicked → password filled → `input[type="submit"]` clicked
   - `X-Auth-Id` cookie obtained ✓
   - Session cached to `~/.cache/edookit-legacy-mcp/skolasquare.session.json` ✓
   - Silent SSO on second run (profile reuse) ✓

2. When profile already has a Plus4U session, the login redirects straight to `oidc/callback` (skipping the form) — handled with a race between `waitForSelector` and a cookie poll ✓

### Remaining bug

After login succeeds and cookies are cached, `portalFetch` still gets redirected to `/user/login` (302 → login page) on the first actual page request. The symptom:

```
Session obtained, got 5 cookies
Session invalid, re-authenticating...    ← portalFetch sees redirect to /user/login
Silent SSO succeeded
Session obtained, got 3 cookies
Authentication failed.                   ← still redirecting even with fresh cookies
```

**Root cause (hypothesis):** The portal's PHP session (`PHPSESSID`) is bound to the Playwright browser's TLS/connection context. When the raw Node.js `https` client sends the same `PHPSESSID` value in a separate connection, the server rejects it (possibly because it validates the session against the Plus4U token that was only exchanged in the browser's connection, or uses SameSite/Secure cookie restrictions).

The `X-Auth-Id` cookie alone is not enough — the server requires the PHP session to be established through its own OIDC callback handler.

### What needs to be done

**Option A — Make the raw HTTP client work:**  
After the Playwright browser login, call a portal page *within the browser* (e.g. `/payments/`) to confirm the session works, then extract cookies. The `PHPSESSID` obtained via `/oidc/callback` handling in the browser should be the valid one. Currently we extract cookies immediately after `X-Auth-Id` appears — but the OIDC callback to `skolasquare.edookit.net/oidc/callback` sets a *new* `PHPSESSID` that may not be in `ctx.cookies()` yet.

**Fix:** After detecting `X-Auth-Id`, navigate to a portal page and *then* extract all cookies.

**Option B — Proxy all requests through Playwright:**  
Instead of a raw `https` client, use Playwright's `page.goto()` for every request and extract the HTML from the browser directly. Slower but guaranteed to work since cookies are managed by the browser.

---

## Files

```
src/
  client.ts   — HTTP client + Playwright browser login + session cache
  tools.ts    — All 21 tool implementations (HTML scraping with cheerio)
  index.ts    — MCP server entry point
dist/         — compiled JS (run: npm run build)
```

## Settings entry

```json
"edookit-portal": {
  "command": "node",
  "args": ["/Users/I779886/Developer/edookit-legacy-mcp/dist/index.js"],
  "env": {
    "EDOOKIT_SCHOOL": "skolasquare",
    "EDOOKIT_USERNAME": "thewulf7@gmail.com",
    "EDOOKIT_PASSWORD": "$Pbfitos130191!"
  }
}
```
