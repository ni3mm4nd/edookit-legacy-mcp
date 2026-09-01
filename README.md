# edookit-legacy-mcp

MCP server for the Edookit **parent/student portal** (`*.edookit.net`). Scrapes the portal web UI because the Edookit REST API is only available when separately enabled by the school.

## 21 tools

| Tool | Description |
|---|---|
| `portal_dashboard` | Main dashboard — student name, pinned items, week's attendance, timetable highlights |
| `portal_inbox` | List inbox items; filter: all / unread / messages / events |
| `portal_evaluations` | Grades by subject, by date, or trends |
| `portal_assignments` | Homework — upcoming, today, recent, archive |
| `portal_exams` | Written tests and oral exams — upcoming or archive |
| `portal_materials` | Teaching/learning materials; optional course filter |
| `portal_lesson_plans` | Lesson plan / curriculum content per week |
| `portal_timetable` | Student timetable — current week, static, upcoming events, archive. Use `offset` (multiples of 7) to navigate weeks: `7` = next week, `-7` = last week, `14` = two weeks ahead, etc. Use `term` to select a school year (e.g. `2026/27`). |
| `portal_terms` | List available school terms/years |
| `portal_attendance` | Attendance records and stats (retroactive excuse, forward report, stats, overview) |
| `portal_excuse_absence` | Submit a retroactive absence excuse for specific dates |
| `portal_report_absence` | Report a future absence by day or by lesson |
| `portal_messages` | List inbox / sent / archive messages |
| `portal_get_message` | Full content of a single message by ID |
| `portal_send_message` | Compose and send a new message |
| `portal_payments` | Payment history and outstanding balances |
| `portal_discussions` | Parent-teacher discussion slots — upcoming or archive |
| `portal_courses` | Enrolled courses, class groups, course enrolments |
| `portal_portfolios` | Student portfolio work items |
| `portal_library` | Borrowed and available library books |
| `portal_consents` | Consent forms and their status |
| `portal_search` | Full-text search across the portal |

## Setup

### 1. Install via npx (no build needed)

```json
{
  "mcpServers": {
    "edookit-portal": {
      "command": "npx",
      "args": ["github:thewulf7/edookit-legacy-mcp"],
      "env": {
        "EDOOKIT_SCHOOL": "your-school",
        "EDOOKIT_USERNAME": "your@email.com",
        "EDOOKIT_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### 2. Build from source (optional)

```bash
git clone https://github.com/thewulf7/edookit-legacy-mcp
cd edookit-legacy-mcp
npm install
npx playwright install chromium
npm run build
node dist/index.js
```

### 3. Environment variables

| Variable | Required | Description |
|---|---|---|
| `EDOOKIT_SCHOOL` | yes | Subdomain — if your portal is `https://zs-example.edookit.net`, use `zs-example` |
| `EDOOKIT_USERNAME` | no | Plus4U login (email). If omitted, a visible browser window opens for interactive login. |
| `EDOOKIT_PASSWORD` | no | Plus4U password. Required together with `EDOOKIT_USERNAME` for headless mode. |

### 4. Authentication

**Headless (recommended):** provide `EDOOKIT_USERNAME` + `EDOOKIT_PASSWORD`. The server logs in via Playwright, saves the Plus4U OIDC session to `~/.cache/edookit-legacy-mcp/profile-<school>/session-storage.json`, and uses a fast silent re-auth on subsequent starts — no browser window, no manual steps.

**Interactive:** omit credentials. On the first tool call a visible Chrome window opens at the portal login page. Complete the Plus4U / Google login manually. Once authenticated the window closes and the session is cached. This only works on a machine with a display.

To force a full re-login, delete `~/.cache/edookit-legacy-mcp/profile-<school>/`.

## Notes

- **Read-only by default** — only `portal_excuse_absence`, `portal_report_absence`, and `portal_send_message` submit data.
- All text is in Czech (the portal language); field values are returned as-is.
- Pages with no data return empty arrays — this is normal for accounts with no activity yet.
- `portal_search` depends on whether the school has search enabled in their Edookit instance.
- `portal_timetable` with `offset` fires a server-side session filter via AJAX before fetching the page, so the offset persists for the duration of the MCP process session.
