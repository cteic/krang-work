import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { asRecord, recordField, stringField } from "../src/json-record.ts";
import { TOOLS, handleMessage } from "../src/mcp-server.ts";
import { WorkStore } from "../src/work-store.ts";
import type { Exposure } from "../src/work-store.ts";

const root = mkdtempSync(join(tmpdir(), "krang-work-mcp-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));

let count = 0;
function freshStore(): WorkStore {
  const store = new WorkStore(join(root, `m${++count}`));
  store.init("TST", false);
  return store;
}

let nextId = 0;
function send(
  store: WorkStore,
  exposure: Exposure,
  method: string,
  params: Record<string, unknown>,
): Map<string, unknown> {
  const reply = handleMessage(
    store,
    exposure,
    JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  );
  assert.notEqual(reply, null);
  return asRecord(JSON.parse(reply ?? "{}")) ?? new Map();
}

interface Called {
  isError: boolean;
  body: Map<string, unknown>;
  text: string;
}

function call(
  store: WorkStore,
  exposure: Exposure,
  name: string,
  args: Record<string, unknown>,
): Called {
  const reply = send(store, exposure, "tools/call", { name, arguments: args });
  const result = recordField(reply, "result");
  assert.notEqual(result, null, `no result: ${JSON.stringify([...reply])}`);
  const content = result?.get("content");
  const first = Array.isArray(content) ? asRecord(content[0]) : null;
  return {
    isError: result?.get("isError") === true,
    body: (result === null ? null : recordField(result, "structuredContent")) ?? new Map(),
    text: first === null ? "" : (stringField(first, "text") ?? ""),
  };
}

function issueId(called: Called): string {
  const issue = recordField(called.body, "issue");
  const id = issue === null ? null : stringField(issue, "id");
  assert.notEqual(id, null, called.text);
  return id ?? "";
}

function errorCode(called: Called): string | null {
  const error = recordField(called.body, "error");
  return error === null ? null : stringField(error, "code");
}

const NORMAL = {
  title: "Add a flag",
  description: "The flag exists.",
  project: "demo",
  acceptance_criteria: ["It prints the version"],
  sensitivity: "normal",
  actor: "agent-a",
};

test("initialize echoes a supported protocol version and falls back otherwise", () => {
  const store = freshStore();
  const known = send(store, "cloud", "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(recordField(known, "result")?.get("protocolVersion"), "2024-11-05");
  const unknown = send(store, "cloud", "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(recordField(unknown, "result")?.get("protocolVersion"), "2025-06-18");
});

test("tools/list offers exactly the seven tools, each with a closed schema", () => {
  const store = freshStore();
  const tools = recordField(send(store, "cloud", "tools/list", {}), "result")?.get("tools");
  assert.ok(Array.isArray(tools));
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    [
      "issue_list",
      "issue_get",
      "issue_create",
      "issue_update",
      "issue_claim",
      "project_list",
      "thought_capture",
    ],
  );
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
});

test("notifications get no reply; unknown methods and bad JSON get errors", () => {
  const store = freshStore();
  const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(handleMessage(store, "cloud", note), null);
  assert.equal(
    recordField(send(store, "cloud", "resources/list", {}), "error")?.get("code"),
    -32601,
  );
  const broken = asRecord(JSON.parse(handleMessage(store, "cloud", "{not json") ?? "{}"));
  assert.equal(broken === null ? null : recordField(broken, "error")?.get("code"), -32700);
});

test("there is no way to approve or finish an issue through the server", () => {
  const store = freshStore();
  const id = issueId(call(store, "local", "issue_create", NORMAL));

  const smuggled = call(store, "local", "issue_update", { id, actor: "agent-a", approved: true });
  assert.equal(errorCode(smuggled), "invalid_input");
  const finished = call(store, "local", "issue_update", { id, actor: "agent-a", status: "done" });
  assert.equal(errorCode(finished), "invalid_input");
  assert.equal(
    errorCode(call(store, "local", "issue_claim", { id, actor: "agent-a" })),
    "not_approved",
  );

  const after = store.get(id);
  assert.equal(after.approved, false);
  assert.equal(after.status, "backlog");
});

test("the workflow through the server once the owner has approved", () => {
  const store = freshStore();
  const id = issueId(call(store, "local", "issue_create", NORMAL));
  store.approve(id, "owner");

  assert.equal(call(store, "local", "issue_claim", { id, actor: "agent-a" }).isError, false);
  assert.equal(
    errorCode(call(store, "local", "issue_claim", { id, actor: "other" })),
    "already_claimed",
  );
  const submitted = call(store, "local", "issue_update", {
    id,
    actor: "agent-a",
    add_evidence: ["test output: 1 passed"],
    handoff: "Done in cli.js",
    status: "in_review",
  });
  assert.equal(submitted.isError, false);
  assert.equal(store.get(id).status, "in_review");
});

test("issue_list returns summaries, not descriptions, and project_list counts open issues", () => {
  const store = freshStore();
  store.writeProject({
    slug: "demo",
    id: null,
    name: "Demo",
    status: "in_progress",
    summary: "A demo project",
    lead: null,
    target: null,
    milestones: [],
    created: "",
    updated: "",
    body: "",
  });
  call(store, "local", "issue_create", { ...NORMAL, description: "a-long-description-marker" });
  const listed = call(store, "local", "issue_list", { project: "demo" });
  assert.equal(listed.body.get("count"), 1);
  assert.equal(listed.text.includes("a-long-description-marker"), false);
  assert.ok(listed.text.includes("Add a flag"));

  const projects = call(store, "local", "project_list", {});
  assert.ok(projects.text.includes('"open_issues": 1'));
});

test("thought_capture writes to the inbox and does not create an issue", () => {
  const store = freshStore();
  const captured = call(store, "cloud", "thought_capture", {
    text: "Could leases be shorter for local models?",
    tags: ["krang"],
    actor: "agent-a",
  });
  assert.equal(captured.isError, false);
  assert.equal(store.thoughts("inbox").length, 1);
  assert.equal(store.thoughts("inbox")[0].written_by, "agent-a");
  assert.equal(store.all().length, 0);
});

test("cloud exposure: a sensitive issue never leaves as more than a stub", () => {
  const store = freshStore();
  const secret = "the-private-sentence";
  const created = call(store, "cloud", "issue_create", {
    title: `Title with ${secret}`,
    description: `Goal with ${secret}`,
    project: "household",
    acceptance_criteria: [`Criterion with ${secret}`],
    actor: "agent-a",
  });
  const id = issueId(created);
  store.approve(id, "owner");
  store.claim(id, "local-agent", 60, "local");
  store.update(
    {
      id,
      actor: "local-agent",
      expected_version: null,
      title: null,
      description: null,
      project: null,
      priority: null,
      labels: null,
      acceptance_criteria: null,
      sensitivity: null,
      status: null,
      add_comment: `Comment with ${secret}`,
      add_evidence: [],
      handoff: null,
    },
    "local",
  );

  const responses = [
    created,
    call(store, "cloud", "issue_get", { id }),
    call(store, "cloud", "issue_list", {}),
    call(store, "cloud", "issue_list", { query: secret }),
    call(store, "cloud", "issue_update", { id, actor: "agent-a", sensitivity: "normal" }),
    call(store, "cloud", "issue_update", { id, actor: "agent-a", add_comment: "hello" }),
    call(store, "cloud", "issue_claim", { id, actor: "agent-a" }),
  ];
  for (const response of responses) {
    assert.equal(response.text.includes(secret), false, response.text);
    assert.equal(JSON.stringify([...response.body]).includes(secret), false);
  }
  assert.equal(recordField(responses[1].body, "issue")?.get("redacted"), true);
  assert.equal(errorCode(responses[4]), "forbidden");
  assert.equal(errorCode(responses[5]), "forbidden");
  assert.equal(errorCode(responses[6]), "forbidden");
  assert.equal(store.get(id).sensitivity, "sensitive");

  // The same issue through a local connection is whole.
  assert.ok(call(store, "local", "issue_get", { id }).text.includes(secret));
});

// The real thing: the CLI entry point as a child process, spoken to over its
// stdin and stdout exactly as an MCP client would.
test("krang-work mcp speaks the protocol over stdio and defaults to cloud exposure", async () => {
  const seed = freshStore();
  const sensitive = seed.create({
    title: "private-title",
    description: "private-goal",
    project: null,
    priority: "none",
    labels: [],
    acceptance_criteria: [],
    sensitivity: "sensitive",
    actor: "owner",
  });

  const cli = join(here, "..", "src", "cli.ts");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", cli, "mcp", "--dir", seed.root],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const replies: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => replies.push(line));

  const write = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  write({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  });
  write({ method: "notifications/initialized" });
  write({ id: 2, method: "tools/list" });
  write({ id: 3, method: "tools/call", params: { name: "issue_create", arguments: NORMAL } });
  write({
    id: 4,
    method: "tools/call",
    params: { name: "issue_get", arguments: { id: sensitive.id } },
  });
  child.stdin.end();

  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(replies.length, 4, "one reply per request, none for the notification");
  for (const line of replies) assert.equal(asRecord(JSON.parse(line))?.get("jsonrpc"), "2.0");
  assert.ok(replies[1].includes("issue_claim"));
  assert.ok(replies[2].includes("Add a flag"));
  assert.equal(replies[3].includes("private-"), false);
  assert.ok(replies[3].includes("redacted"));
  assert.equal(seed.all().length, 2);
});

// The local agent's two halves: a real MCP client against the real server as
// a child process, and the loop driven by a scripted stand-in for the model.
test("a local agent works through the server and is bound by its rules", async () => {
  const { McpClient, isLoopback, ollamaChat, runAgent } = await import("../src/local-agent.ts");
  assert.equal(isLoopback("http://127.0.0.1:11434"), true);
  assert.equal(isLoopback("https://api.example.com"), false);
  assert.throws(() => ollamaChat("https://api.example.com", "m"), /not this machine/);

  const store = freshStore();
  const issue = store.create({
    title: "private-title",
    description: "Sensitive, and a local agent may read it.",
    project: null,
    priority: "none",
    labels: [],
    acceptance_criteria: ["It is done"],
    sensitivity: "sensitive",
    actor: "owner",
  });
  store.approve(issue.id, "owner");

  const cli = join(here, "..", "src", "cli.ts");
  const client = new McpClient(process.execPath, [
    "--experimental-strip-types",
    cli,
    "mcp",
    "--exposure",
    "local",
    "--dir",
    store.root,
  ]);

  // The stand-in model: list, claim, try to approve itself, try a tool that
  // does not exist, submit, then answer.
  const script = [
    [{ name: "issue_list", arguments: {} }],
    [{ name: "issue_claim", arguments: { id: issue.id, actor: "local-agent" } }],
    [
      { name: "issue_update", arguments: { id: issue.id, actor: "local-agent", status: "done" } },
      { name: "run_shell", arguments: { command: "krang-work issue approve" } },
    ],
    [
      {
        name: "issue_update",
        arguments: {
          id: issue.id,
          actor: "local-agent",
          add_evidence: ["checked by hand"],
          status: "in_review",
        },
      },
    ],
  ];
  let turn = 0;
  let seen: string[] = [];
  const events: string[] = [];
  try {
    const answer = await runAgent(
      client,
      async (messages, tools) => {
        seen = messages.filter((m) => m.role === "tool").map((m) => m.content);
        assert.equal(tools.length, 7);
        const calls = script[turn++] ?? [];
        return {
          content: calls.length === 0 ? "Submitted for review." : "",
          calls,
          raw: { role: "assistant", content: "" },
        };
      },
      {
        task: "Do the approved work.",
        actor: "local-agent",
        maxSteps: 8,
        onEvent: (event) => events.push(event.kind),
      },
    );
    assert.equal(answer, "Submitted for review.");
  } finally {
    client.close();
  }

  const results = seen.join("\n");
  assert.ok(results.includes("private-title"), "local exposure: the agent reads the issue");
  assert.ok(results.includes("unknown_tool"), "a tool the server lacks is refused, not run");
  assert.ok(results.includes("invalid_input"), "it could not mark its own work done");
  const after = store.get(issue.id);
  assert.equal(after.status, "in_review");
  assert.equal(after.claimed_by, "local-agent");
  assert.deepEqual(
    events.filter((kind) => kind === "answer"),
    ["answer"],
  );
});
