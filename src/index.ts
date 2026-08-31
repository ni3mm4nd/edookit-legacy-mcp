#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getDashboard,
  getInbox,
  getEvaluations,
  getAssignments,
  getExams,
  getMaterials,
  getLessonPlans,
  getTerms,
  getTimetable,
  getAttendance,
  excuseAbsence,
  reportAbsence,
  getMessages,
  getMessage,
  sendMessage,
  getPayments,
  getDiscussions,
  getCourses,
  getPortfolios,
  getLibrary,
  getConsents,
  searchPortal,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "portal_dashboard",
    description: "Get the main dashboard — student name, pinned items, this week's attendance, and timetable highlights.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "portal_inbox",
    description: "List inbox items (messages, events, assignments, etc.). Optionally filter by type.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "unread", "messages", "events"],
          description: "Filter items by type. Defaults to 'all'.",
        },
      },
    },
  },
  {
    name: "portal_evaluations",
    description: "Get grades and evaluations grouped by subject.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["by-subject", "by-date", "trends"],
          description: "Which evaluation view to fetch.",
        },
      },
    },
  },
  {
    name: "portal_assignments",
    description: "Get homework assignments (upcoming, today, recent, or archive).",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["upcoming", "archive", "all"],
          description: "'upcoming' (default) or 'archive'.",
        },
      },
    },
  },
  {
    name: "portal_exams",
    description: "Get upcoming or past exams and written tests.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["upcoming", "archive"] },
      },
    },
  },
  {
    name: "portal_materials",
    description: "Get teaching/learning materials. Optionally filter by course ID.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course ID to filter materials." },
      },
    },
  },
  {
    name: "portal_lesson_plans",
    description: "Get lesson plans / curriculum content for the student.",
    inputSchema: {
      type: "object",
      properties: {
        week: { type: "string", description: "ISO week (YYYY-Www) to fetch. Defaults to current week." },
      },
    },
  },
  {
    name: "portal_terms",
    description: "List available school terms/years (e.g. 2026/27, 2025/26). Use this to find the term label before calling portal_timetable with a specific term.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "portal_timetable",
    description: "Get the student timetable. Views: current week, static (permanent), upcoming events, archive. Use the 'term' parameter to select a specific school year (e.g. '2026/27'). Call portal_terms first to see available terms.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["current", "static", "upcoming", "archive"],
          description: "Which timetable view to fetch. Default: 'current'.",
        },
        offset: {
          type: "number",
          description: "Week offset in days (e.g. 7 = next week, -7 = last week). Only for 'current' view.",
        },
        term: {
          type: "string",
          description: "School year to view, e.g. '2026/27' or '2025/26'. If omitted, uses the currently active term. Call portal_terms to list options.",
        },
      },
    },
  },
  {
    name: "portal_attendance",
    description: "Get attendance records and statistics. Views: excuse (retroactive), report (forward by day), report-lesson (forward by lesson), excused, stats, overview.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["excuse", "report", "report-lesson", "excused", "stats", "overview"],
          description: "Which attendance view to fetch. Default: 'excuse' (retroactive).",
        },
      },
    },
  },
  {
    name: "portal_excuse_absence",
    description: "Submit a retroactive excuse for absences on specific dates.",
    inputSchema: {
      type: "object",
      required: ["dates", "reason"],
      properties: {
        dates: {
          type: "array",
          items: { type: "string" },
          description: "List of dates to excuse (YYYY-MM-DD or display format matching the portal).",
        },
        reason: { type: "string", description: "Reason / excuse text." },
      },
    },
  },
  {
    name: "portal_report_absence",
    description: "Report a future (upcoming) absence by day or by lesson.",
    inputSchema: {
      type: "object",
      required: ["mode", "dateFrom", "reason"],
      properties: {
        mode: { type: "string", enum: ["day", "lesson"], description: "Report by full days or by individual lessons." },
        dateFrom: { type: "string", description: "Start date (YYYY-MM-DD)." },
        dateTo: { type: "string", description: "End date (YYYY-MM-DD). Optional for single-day." },
        reason: { type: "string", description: "Reason for the absence." },
      },
    },
  },
  {
    name: "portal_messages",
    description: "List inbox, sent, or archived messages.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["inbox", "sent", "archive"], description: "Default: 'inbox'." },
        page: { type: "number", description: "Page number for pagination." },
      },
    },
  },
  {
    name: "portal_get_message",
    description: "Get the full content of a single message by its ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Message ID (numeric, from portal_messages)." },
      },
    },
  },
  {
    name: "portal_send_message",
    description: "Compose and send a new message to a recipient.",
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string", description: "Recipient name or ID as shown in the portal's recipient dropdown." },
        subject: { type: "string", description: "Message subject line." },
        body: { type: "string", description: "Plain-text message body." },
      },
    },
  },
  {
    name: "portal_payments",
    description: "Get payment history and outstanding balances.",
    inputSchema: {
      type: "object",
      properties: {
        personId: { type: "string", description: "Filter by student/person ID (optional)." },
      },
    },
  },
  {
    name: "portal_discussions",
    description: "Get upcoming or archived discussions (parent-teacher talks).",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["upcoming", "archive"] },
      },
    },
  },
  {
    name: "portal_courses",
    description: "Get enrolled courses, class groups, or available course enrolments.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["list", "groups", "enroll"], description: "Default: 'list'." },
      },
    },
  },
  {
    name: "portal_portfolios",
    description: "Get student portfolio work items.",
    inputSchema: {
      type: "object",
      properties: {
        studentId: { type: "string", description: "Student ID (optional)." },
      },
    },
  },
  {
    name: "portal_library",
    description: "Get borrowed and available library books.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "portal_consents",
    description: "Get consent forms (agreements) and their status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "portal_search",
    description: "Search the portal for any content by keyword.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "edookit-legacy-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    let result: unknown;

    switch (name) {
      case "portal_dashboard":        result = await getDashboard(); break;
      case "portal_inbox":            result = await getInbox(args as any); break;
      case "portal_evaluations":      result = await getEvaluations(args as any); break;
      case "portal_assignments":      result = await getAssignments(args as any); break;
      case "portal_exams":            result = await getExams(args as any); break;
      case "portal_materials":        result = await getMaterials(args as any); break;
      case "portal_lesson_plans":     result = await getLessonPlans(args as any); break;
      case "portal_terms":            result = await getTerms(); break;
      case "portal_timetable":        result = await getTimetable(args as any); break;
      case "portal_attendance":       result = await getAttendance(args as any); break;
      case "portal_excuse_absence":   result = await excuseAbsence(args as any); break;
      case "portal_report_absence":   result = await reportAbsence(args as any); break;
      case "portal_messages":         result = await getMessages(args as any); break;
      case "portal_get_message":      result = await getMessage(args as any); break;
      case "portal_send_message":     result = await sendMessage(args as any); break;
      case "portal_payments":         result = await getPayments(args as any); break;
      case "portal_discussions":      result = await getDiscussions(args as any); break;
      case "portal_courses":          result = await getCourses(args as any); break;
      case "portal_portfolios":       result = await getPortfolios(args as any); break;
      case "portal_library":          result = await getLibrary(); break;
      case "portal_consents":         result = await getConsents(); break;
      case "portal_search":           result = await searchPortal(args as any); break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("edookit-legacy-mcp running\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
