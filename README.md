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
| `portal_timetable` | Student timetable — current week, static, upcoming events, archive |
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

### 1. Build from source

```bash
git clone <this-repo>
cd edookit-legacy-mcp
npm install
npx playwright install chromium
npm run build
```

### 2. Add to Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "edookit-portal": {
      "command": "node",
      "args": ["/path/to/edookit-legacy-mcp/dist/index.js"],
      "env": {
        "EDOOKIT_SCHOOL": "skolasquare"
      }
    }
  }
}
```

`EDOOKIT_SCHOOL` is the subdomain — if your portal is at `https://zs-example.edookit.net`, use `zs-example`.

### 3. First-time login

On the first tool call, the MCP server will open a **visible Chrome window** and navigate to the school portal login page. Complete the Plus4U / Google login in that window. Once authenticated, the window closes automatically and the session is cached for **10 hours** in `~/.cache/edookit-legacy-mcp/`. Subsequent calls use the cached session silently.

To force a fresh login, delete `~/.cache/edookit-legacy-mcp/<school>.session.json`.

## Notes

- **Read-only by default** — only `portal_excuse_absence`, `portal_report_absence`, and `portal_send_message` submit data.
- All text is in Czech (the portal language); field values are returned as-is.
- Pages with no data return empty arrays — this is normal for accounts with no activity yet.
- `portal_search` depends on whether the school has search enabled in their Edookit instance.
