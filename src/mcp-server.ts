import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { asRecord, stringField } from "./json-record.ts";
import {
  parseClaimInput,
  parseCreateInput,
  parseEmpty,
  parseGetInput,
  parseListFilter,
  parseThoughtInput,
  parseUpdateInput,
} from "./inputs.ts";
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LIST_LIMIT,
  MAX_LEASE_SECONDS,
  MAX_LIST_LIMIT,
  PRIORITIES,
  STATUSES,
  WorkError,
  redact,
} from "./work-store.ts";
import type { Exposure, Issue, IssueView, WorkStore } from "./work-store.ts";

// A Model Context Protocol server over stdio, written against the protocol
// rather than the SDK, so that there are no runtime dependencies. The
// surface is small enough for that to be honest: newline-delimited JSON-RPC
// 2.0, three lifecycle messages, tools/list and tools/call.
//
// stdout carries protocol messages and nothing else. Anything a human should
// see goes to stderr, or the client's parser reads it as a broken message.
//
// There is no tool here for approving an issue or marking one done. That is
// not an omission to fill in later: those are the owner's two decisions, and
// an agent that could make them would be reviewing its own work.

const SERVER_NAME = "krang-work";
const SERVER_VERSION = "0.2.0";

// Newest first. A client asking for one of these gets it back; a client asking
// for anything else gets the newest, and decides for itself whether to go on.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const ID = {
  type: "string",
  pattern: "^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}$",
  description: "Issue id, such as WORK-208.",
};
const ACTOR = {
  type: "string",
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._@-]*$",
  description: "A stable name for the agent making the call, such as build-agent or review-agent.",
};
const SENSITIVITY = { type: "string", enum: ["normal", "sensitive"] };
const PRIORITY = { type: "string", enum: PRIORITIES };
const PROJECT = {
  type: "string",
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9-]*$",
  description: "Project slug, as returned by project_list.",
};
const LABELS = { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 } };
const CRITERIA = {
  type: "array",
  maxItems: 20,
  items: { type: "string", maxLength: 500 },
  description: "Checkable statements. The owner reviews the result against these.",
};

function tool(
  name: string,
  description: string,
  required: string[],
  properties: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, required, properties },
  };
}

export const TOOLS: ToolDefinition[] = [
  tool(
    "issue_list",
    "List issues, most urgent first. Closed issues are left out unless include_closed is true or status names one. Returns a summary per issue; use issue_get for the full text. Sensitive issues may come back as stubs with redacted: true.",
    [],
    {
      project: PROJECT,
      status: { type: "string", enum: STATUSES },
      label: { type: "string", maxLength: 64 },
      query: {
        type: "string",
        maxLength: 200,
        description: "Text to find in id, title or description.",
      },
      include_closed: { type: "boolean", default: false },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT },
    },
  ),
  tool(
    "issue_get",
    "Read one issue in full: description, acceptance criteria, links to other issues, and its log of comments, evidence and handoffs. A sensitive issue may come back as a stub with redacted: true.",
    ["id"],
    { id: ID },
  ),
  tool(
    "issue_create",
    "Create an issue. It starts in backlog and unapproved: nobody can claim it until the owner approves it from the command line. Sensitivity defaults to sensitive.",
    ["title", "actor"],
    {
      title: { type: "string", maxLength: 200 },
      description: {
        type: "string",
        maxLength: 40000,
        description: "The outcome wanted, and why. Markdown.",
      },
      project: PROJECT,
      priority: PRIORITY,
      labels: LABELS,
      acceptance_criteria: CRITERIA,
      sensitivity: {
        ...SENSITIVITY,
        description:
          "Defaults to sensitive. A sensitive issue is returned to this client as a stub unless the server runs with local exposure.",
      },
      actor: ACTOR,
    },
  ),
  tool(
    "issue_update",
    'Change an issue. Any time: add_comment. While it is in backlog or todo: title, description, project, priority, labels, acceptance_criteria, sensitivity, or status "cancelled". Editing the title, description or criteria of an approved issue removes the approval. While you hold the claim: add_evidence, handoff, status "in_review" (needs evidence) or status "todo" (release the claim). You cannot approve an issue or mark it done; the owner does both.',
    ["id", "actor"],
    {
      id: ID,
      actor: ACTOR,
      expected_version: {
        type: "integer",
        description:
          "The version you last read. If the issue has changed since, the update is refused.",
      },
      title: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 40000 },
      project: PROJECT,
      priority: PRIORITY,
      labels: LABELS,
      acceptance_criteria: CRITERIA,
      sensitivity: SENSITIVITY,
      status: { type: "string", enum: ["todo", "in_review", "cancelled"] },
      add_comment: { type: "string", maxLength: 20000 },
      add_evidence: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 20000 },
        description:
          "What shows the work meets the criteria: a command and its output, a file path, a commit.",
      },
      handoff: {
        type: "string",
        maxLength: 20000,
        description: "What the reviewer or the next agent needs to know.",
      },
    },
  ),
  tool(
    "issue_claim",
    "Take an approved issue for a limited time. Exactly one caller wins. Calling again as the same actor renews the lease. A claim whose lease has run out can be taken by another actor. Refused while an issue it is blocked by is unfinished.",
    ["id", "actor"],
    {
      id: ID,
      actor: ACTOR,
      lease_seconds: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LEASE_SECONDS,
        default: DEFAULT_LEASE_SECONDS,
      },
    },
  ),
  tool(
    "project_list",
    "List projects with their status, summary and a count of open issues.",
    [],
    {},
  ),
  tool(
    "thought_capture",
    "Save a passing thought to the inbox, in the person's own words, for them to review later. It is not an issue and nobody will act on it. Use this when asked to jot something down.",
    ["text", "actor"],
    {
      text: { type: "string", maxLength: 20000 },
      tags: {
        type: "array",
        maxItems: 10,
        items: { type: "string", maxLength: 64, pattern: "^[a-z0-9][a-z0-9/_-]*$" },
      },
      actor: ACTOR,
    },
  ),
];

interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

function ok(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

// A refused call is a result, not a protocol error: the model reads the text
// and can act on it. The code is stable; the message is for reading.
function refused(code: string, message: string): ToolResult {
  const payload = { error: { code, message } };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

// A list is for choosing what to open. The description and log stay behind
// issue_get, so listing two hundred issues does not cost two hundred documents.
function summary(issue: Issue, exposure: Exposure): IssueView | Record<string, unknown> {
  const view = redact(issue, exposure);
  if ("redacted" in view) return view;
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    project: issue.project,
    priority: issue.priority,
    labels: issue.labels,
    sensitivity: issue.sensitivity,
    approved: issue.approved,
    claimed_by: issue.claimed_by,
    blocked_by: issue.blocked_by,
    updated: issue.updated,
  };
}

export function callTool(
  store: WorkStore,
  exposure: Exposure,
  name: string,
  args: unknown,
): ToolResult | null {
  try {
    if (name === "issue_create") {
      return ok({ issue: redact(store.create(parseCreateInput(args)), exposure) });
    }
    if (name === "issue_list") {
      const issues = store.list(parseListFilter(args)).map((issue) => summary(issue, exposure));
      return ok({ issues, count: issues.length });
    }
    if (name === "issue_get") {
      return ok({ issue: redact(store.get(parseGetInput(args)), exposure) });
    }
    if (name === "issue_update") {
      return ok({ issue: redact(store.update(parseUpdateInput(args), exposure), exposure) });
    }
    if (name === "issue_claim") {
      const input = parseClaimInput(args);
      const issue = store.claim(input.id, input.actor, input.lease_seconds, exposure);
      return ok({ issue: redact(issue, exposure) });
    }
    if (name === "project_list") {
      parseEmpty(args);
      const open = store
        .all()
        .filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
      const projects = store.projects().map((project) => ({
        slug: project.slug,
        name: project.name,
        status: project.status,
        summary: project.summary,
        open_issues: open.filter((issue) => issue.project === project.slug).length,
      }));
      return ok({ projects, count: projects.length });
    }
    if (name === "thought_capture") {
      const input = parseThoughtInput(args);
      const thought = store.jot(input.text, input.tags, input.actor);
      // The text is not echoed back: the caller already has it.
      return ok({ thought: { id: thought.id, file: thought.file, tags: thought.tags } });
    }
    return null;
  } catch (error) {
    if (error instanceof WorkError) return refused(error.code, error.message);
    // Anything else is a fault in the store. The detail goes to stderr for the
    // owner; the client gets a fixed sentence, so a stack trace or a file path
    // never reaches a model through an error message.
    console.error(`[${SERVER_NAME}] ${name} failed:`, error);
    return refused("internal_error", "the work store failed; see the server's stderr");
  }
}

type JsonRpcId = string | number;

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function result(id: JsonRpcId, value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: value });
}

function failure(id: JsonRpcId | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// One line in, at most one line out. Null means "no reply": the message was a
// notification, and JSON-RPC forbids answering those.
export function handleMessage(store: WorkStore, exposure: Exposure, line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, PARSE_ERROR, "message is not valid JSON");
  }
  const message = asRecord(parsed);
  if (message === null || message.get("jsonrpc") !== "2.0") {
    return failure(null, INVALID_REQUEST, "message is not a JSON-RPC 2.0 object");
  }
  const method = stringField(message, "method");
  const rawId = message.get("id");
  // A message with no method is a response to something this server never
  // asked. There is nothing to do with it.
  if (method === null) return null;
  if (rawId === undefined) return null;
  if (!isId(rawId)) return failure(null, INVALID_REQUEST, "id must be a string or a number");

  const params = asRecord(message.get("params")) ?? new Map<string, unknown>();

  if (method === "initialize") {
    const requested = stringField(params, "protocolVersion");
    const protocolVersion =
      requested !== null && PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0];
    return result(rawId, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        exposure === "cloud"
          ? "Local issue tracker. This connection is treated as a cloud model: sensitive issues are returned as stubs and cannot be changed or claimed here. Only the owner approves issues and marks them done."
          : "Local issue tracker, full local exposure. Only the owner approves issues and marks them done.",
    });
  }
  if (method === "ping") return result(rawId, {});
  if (method === "tools/list") return result(rawId, { tools: TOOLS });
  if (method === "tools/call") {
    const name = stringField(params, "name");
    if (name === null) return failure(rawId, INVALID_PARAMS, "params.name is required");
    const outcome = callTool(store, exposure, name, params.get("arguments") ?? {});
    if (outcome === null) return failure(rawId, INVALID_PARAMS, `unknown tool "${name}"`);
    return result(rawId, outcome);
  }
  return failure(rawId, METHOD_NOT_FOUND, `method "${method}" is not supported`);
}

export function serve(
  store: WorkStore,
  exposure: Exposure,
  input: Readable,
  output: Writable,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const reply = handleMessage(store, exposure, line);
    if (reply !== null) output.write(`${reply}\n`);
  });
  return new Promise((resolve) => {
    lines.on("close", () => resolve());
  });
}
