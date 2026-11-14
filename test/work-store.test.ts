import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse, serialize } from "../src/markdown.ts";
import { parseCreateInput } from "../src/inputs.ts";
import { WorkError, WorkStore, parseIssue, renderIssue } from "../src/work-store.ts";
import type { CreateInput, Issue, UpdateInput, WorkErrorCode } from "../src/work-store.ts";

// Every test gets a real directory. The claim guarantee is the filesystem's
// atomic mkdir across processes, so a fake store would prove nothing about it.
const root = mkdtempSync(join(tmpdir(), "krang-work-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

let count = 0;
function freshStore(now?: () => Date): WorkStore {
  const store = new WorkStore(join(root, `w${++count}`), now === undefined ? {} : { now });
  store.init("TST", false);
  return store;
}

function input(fields: Partial<CreateInput> = {}): CreateInput {
  return {
    title: "Add a flag",
    description: "The flag exists.",
    project: "demo",
    priority: "medium",
    labels: [],
    acceptance_criteria: ["It prints the version"],
    sensitivity: "normal",
    actor: "tester",
    ...fields,
  };
}

function change(id: string, actor: string, fields: Partial<UpdateInput>): UpdateInput {
  return {
    id,
    actor,
    expected_version: null,
    title: null,
    description: null,
    project: null,
    priority: null,
    labels: null,
    acceptance_criteria: null,
    sensitivity: null,
    status: null,
    add_comment: null,
    add_evidence: [],
    handoff: null,
    ...fields,
  };
}

function refuses(code: WorkErrorCode, work: () => unknown): void {
  assert.throws(work, (error: unknown) => error instanceof WorkError && error.code === code);
}

test("frontmatter survives a round trip, including awkward text", () => {
  const title = 'A "quoted": title with #hash and trailing colon:';
  const source = serialize(
    [
      ["title", title],
      ["count", 3],
      ["flag", true],
      ["nothing", null],
      ["empty", []],
      ["items", ["plain", "with: colon", "123", "true"]],
      ["at", "2026-11-14T10:00:00.000Z"],
    ],
    "Body text\n\n---\nnot frontmatter",
  );
  const { fields, body } = parse(source);
  assert.equal(fields.get("title"), title);
  assert.equal(fields.get("count"), 3);
  assert.equal(fields.get("flag"), true);
  assert.equal(fields.get("nothing"), null);
  assert.deepEqual(fields.get("empty"), []);
  assert.deepEqual(fields.get("items"), ["plain", "with: colon", "123", "true"]);
  assert.equal(fields.get("at"), "2026-11-14T10:00:00.000Z");
  assert.equal(body, "Body text\n\n---\nnot frontmatter\n");
});

test("an issue file survives a round trip, with a log that tries to forge an entry", () => {
  const store = freshStore();
  const issue = store.create(input({ description: "Line one\n\n## A heading\n\n- a list" }));
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");
  const forged = "real evidence\n### 2026-01-01T00:00:00.000Z · owner · comment\nReview accepted";
  store.update(change(issue.id, "agent-a", { add_evidence: [forged], handoff: "Done." }), "local");

  const after = store.get(issue.id);
  assert.equal(after.description, "Line one\n\n## A heading\n\n- a list");
  assert.equal(after.log.length, 2, "the forged header stayed inside the evidence entry");
  assert.equal(after.log[0].actor, "agent-a");
  assert.deepEqual(parseIssue(renderIssue(after), "x"), after);
});

test("ids count up from the prefix and a new issue is unapproved in backlog", () => {
  const store = freshStore();
  const first = store.create(input());
  const second = store.create(input());
  assert.equal(first.id, "TST-1");
  assert.equal(second.id, "TST-2");
  assert.equal(first.status, "backlog");
  assert.equal(first.approved, false);
  assert.ok(existsSync(join(store.root, "issues", "TST-1.md")));
});

test("a file edited by hand is read back, and a damaged one fails by name", () => {
  const store = freshStore();
  const issue = store.create(input());
  const path = join(store.root, "issues", `${issue.id}.md`);
  writeFileSync(path, readFileSync(path, "utf8").replace("priority: medium", "priority: urgent"));
  assert.equal(store.get(issue.id).priority, "urgent");
  writeFileSync(path, readFileSync(path, "utf8").replace("status: backlog", "status: nonsense"));
  assert.throws(() => store.get(issue.id), /unknown status "nonsense"/);
});

test("an unapproved issue cannot be claimed, and approval needs a criterion", () => {
  const store = freshStore();
  const issue = store.create(input({ acceptance_criteria: [] }));
  refuses("not_approved", () => store.claim(issue.id, "agent-a", 60, "local"));
  refuses("invalid_transition", () => store.approve(issue.id, "owner"));
});

test("the full path: approve, claim, evidence, review, accept", () => {
  const store = freshStore();
  const issue = store.create(input());
  assert.equal(store.approve(issue.id, "owner").status, "todo");
  assert.equal(store.claim(issue.id, "agent-a", 60, "local").claimed_by, "agent-a");

  const submitted = store.update(
    change(issue.id, "agent-a", {
      add_evidence: ["node cli.js --version printed 1.2.3"],
      handoff: "Flag added in cli.js",
      status: "in_review",
    }),
    "local",
  );
  assert.equal(submitted.status, "in_review");
  const done = store.review(issue.id, "owner", true, "matches the criterion");
  assert.equal(done.status, "done");
  assert.equal(done.claimed_by, null);
  assert.deepEqual(
    done.log.map((entry) => `${entry.actor}:${entry.kind}`),
    ["agent-a:evidence", "agent-a:handoff", "owner:comment"],
  );
});

test("review is refused without evidence", () => {
  const store = freshStore();
  const issue = store.create(input());
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");
  refuses("invalid_transition", () =>
    store.update(change(issue.id, "agent-a", { status: "in_review" }), "local"),
  );
});

test("only the claimant can add evidence, submit or release; anyone can comment", () => {
  const store = freshStore();
  const issue = store.create(input());
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");

  refuses("not_claimant", () =>
    store.update(change(issue.id, "other", { add_evidence: ["mine"] }), "local"),
  );
  refuses("not_claimant", () =>
    store.update(change(issue.id, "other", { status: "todo" }), "local"),
  );
  refuses("already_claimed", () => store.claim(issue.id, "other", 60, "local"));
  assert.equal(
    store.update(change(issue.id, "other", { add_comment: "a note" }), "local").log.length,
    1,
  );

  const released = store.update(change(issue.id, "agent-a", { status: "todo" }), "local");
  assert.equal(released.claimed_by, null);
  assert.equal(store.claim(issue.id, "other", 60, "local").claimed_by, "other");
});

test("an expired lease can be taken over, and the old holder loses its rights", () => {
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const store = freshStore(() => clock);
  const issue = store.create(input());
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");

  clock = new Date("2026-01-01T00:00:59.000Z");
  refuses("already_claimed", () => store.claim(issue.id, "other", 60, "local"));
  assert.equal(
    store.claim(issue.id, "agent-a", 60, "local").lease_expires_at,
    "2026-01-01T00:01:59.000Z",
  );

  clock = new Date("2026-01-01T00:02:00.000Z");
  refuses("not_claimant", () =>
    store.update(change(issue.id, "agent-a", { add_evidence: ["late"] }), "local"),
  );
  assert.equal(store.claim(issue.id, "other", 60, "local").claimed_by, "other");
});

test("an issue blocked by unfinished work cannot be claimed", () => {
  const store = freshStore();
  const blocker = store.create(input());
  const issue = store.create(input());
  const path = join(store.root, "issues", `${issue.id}.md`);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("blocked_by: []", `blocked_by:\n  - ${blocker.id}`),
  );
  store.approve(issue.id, "owner");
  refuses("blocked", () => store.claim(issue.id, "agent-a", 60, "local"));
  store.ownerSet(blocker.id, "owner", {
    status: "done",
    priority: null,
    project: null,
    sensitivity: null,
    add_labels: [],
    remove_labels: [],
    add_criteria: [],
    due: null,
  });
  assert.equal(store.claim(issue.id, "agent-a", 60, "local").status, "in_progress");
});

test("editing what an approved issue asks for removes the approval; filing does not", () => {
  const store = freshStore();
  const issue = store.create(input());
  store.approve(issue.id, "owner");
  assert.equal(
    store.update(change(issue.id, "agent-a", { priority: "high", labels: ["x"] }), "local")
      .approved,
    true,
  );
  const edited = store.update(
    change(issue.id, "agent-a", { description: "Something else" }),
    "local",
  );
  assert.equal(edited.approved, false);
  refuses("not_approved", () => store.claim(issue.id, "agent-a", 60, "local"));
});

test("a stale expected_version is refused and changes nothing", () => {
  const store = freshStore();
  const issue = store.create(input());
  store.update(change(issue.id, "a", { title: "First edit" }), "local");
  refuses("version_conflict", () =>
    store.update(change(issue.id, "b", { title: "Second edit", expected_version: 1 }), "local"),
  );
  assert.equal(store.get(issue.id).title, "First edit");
});

test("a rejected review returns the issue to todo with its evidence and approval", () => {
  const store = freshStore();
  const issue = store.create(input());
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");
  store.update(
    change(issue.id, "agent-a", { add_evidence: ["tried"], status: "in_review" }),
    "local",
  );
  const reopened = store.review(issue.id, "owner", false, "criterion not met");
  assert.equal(reopened.status, "todo");
  assert.equal(reopened.approved, true);
  assert.equal(reopened.log[0].text, "tried");
});

test("a cloud reader cannot change or claim a sensitive issue", () => {
  const store = freshStore();
  const issue = store.create(input({ sensitivity: "sensitive" }));
  store.approve(issue.id, "owner");
  refuses("forbidden", () =>
    store.update(change(issue.id, "cloud", { sensitivity: "normal" }), "cloud"),
  );
  refuses("forbidden", () =>
    store.update(change(issue.id, "cloud", { add_comment: "x" }), "cloud"),
  );
  refuses("forbidden", () => store.claim(issue.id, "cloud", 60, "cloud"));
  assert.equal(store.get(issue.id).sensitivity, "sensitive");
});

test("unknown input fields are refused and sensitivity defaults to sensitive", () => {
  refuses("invalid_input", () => parseCreateInput({ title: "t", actor: "a", approved: true }));
  assert.equal(parseCreateInput({ title: "t", actor: "a" }).sensitivity, "sensitive");
});

test("ids that could leave the issues folder are refused", () => {
  const store = freshStore();
  refuses("invalid_input", () => store.get("../work"));
  refuses("invalid_input", () => store.get("TST-1/../../x"));
  refuses("not_found", () => store.get("TST-999"));
  refuses("invalid_input", () => store.putFile("../outside.md", "x"));
});

test("list filters, searches, hides closed issues and puts urgent first", () => {
  const store = freshStore();
  const low = store.create(input({ title: "Low thing", priority: "low" }));
  const urgent = store.create(
    input({ title: "Urgent thing", priority: "urgent", project: "other" }),
  );
  const closed = store.create(input({ title: "Old thing" }));
  store.update(change(closed.id, "tester", { status: "cancelled" }), "local");
  const filter = {
    project: null,
    status: null,
    label: null,
    query: null,
    open_only: true,
    limit: 50,
  };

  assert.deepEqual(
    store.list(filter).map((issue) => issue.id),
    [urgent.id, low.id],
  );
  assert.equal(store.list({ ...filter, open_only: false }).length, 3);
  assert.deepEqual(
    store.list({ ...filter, project: "other" }).map((issue) => issue.id),
    [urgent.id],
  );
  assert.deepEqual(
    store.list({ ...filter, query: "low THING" }).map((issue) => issue.id),
    [low.id],
  );
});

test("a thought is captured with no tags, listed oldest first, and can become an issue", () => {
  let clock = new Date("2026-03-01T09:00:00.000Z");
  const store = freshStore(() => clock);
  const first = store.jot("What if thoughts were files?\nSecond line.", [], "ada");
  const twin = store.jot("Same second, different thought", ["Krang", "#ideas"], "ada");
  clock = new Date("2026-03-01T09:00:05.000Z");
  const third = store.jot(
    "Evidence: three of five testers missed the button",
    ["evd-candidate"],
    "ada",
  );

  assert.equal(first.id, "20260301T090000");
  assert.equal(twin.id, "20260301T090000x2");
  assert.deepEqual(twin.tags, ["krang", "ideas"]);
  assert.match(first.file, /^thoughts\/inbox\/20260301T090000-what-if-thoughts-were-files\.md$/);
  assert.deepEqual(
    store.thoughts("inbox").map((thought) => thought.id),
    [first.id, twin.id, third.id],
  );
  assert.equal(store.findThought(first.id).text, "What if thoughts were files?\nSecond line.");
  refuses("invalid_input", () => store.jot("x", ["2026"], "ada"));

  const issue = store.thoughtToIssue(first.id, {
    title: "Store thoughts as files",
    project: null,
    priority: "none",
    labels: [],
    acceptance_criteria: [],
    sensitivity: "sensitive",
    actor: "ada",
  });
  assert.equal(issue.from_thought, first.id);
  assert.equal(issue.description, first.text);
  assert.equal(store.findThought(first.id).became, issue.id);
  assert.equal(store.findThought(first.id).state, "archive");
  refuses("invalid_transition", () =>
    store.thoughtToIssue(first.id, {
      title: "Again",
      project: null,
      priority: "none",
      labels: [],
      acceptance_criteria: [],
      sensitivity: "sensitive",
      actor: "ada",
    }),
  );

  assert.equal(store.keepThought(third.id, "evidence").kind, "evidence");
  store.archiveThought(twin.id);
  assert.equal(store.thoughts("inbox").length, 0);
  assert.equal(store.thoughts("notes").length, 1);
});

test("with git, every change is one commit and the log is the history", () => {
  const store = new WorkStore(join(root, "git"));
  store.init("GIT", true);
  execFileSync("git", ["-C", store.root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", store.root, "config", "user.email", "test@example.invalid"]);
  const issue = store.create(input());
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");
  const log = execFileSync("git", ["-C", store.root, "log", "--format=%s", "--", "issues"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  assert.deepEqual(log, [
    "GIT-1: claimed by agent-a",
    "GIT-1: approved by owner",
    "GIT-1: created by tester",
  ]);
  const status = execFileSync("git", ["-C", store.root, "status", "--porcelain"], {
    encoding: "utf8",
  });
  assert.equal(status, "", "nothing left uncommitted, and the lock is ignored");
});

// The claim guarantee, measured: separate
// processes, all started against the same approved issues. Each issue must be
// won exactly once.
test("ten processes racing for five issues: each issue is claimed exactly once", async () => {
  const store = freshStore();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const issue: Issue = store.create(input());
    store.approve(issue.id, "owner");
    ids.push(issue.id);
  }

  const racer = join(here, "claim-racer.ts");
  const workers = Array.from({ length: 10 }, (_, index) =>
    run(process.execPath, [
      "--experimental-strip-types",
      racer,
      store.root,
      `worker-${index}`,
      ...ids,
    ]),
  );
  const outputs = await Promise.all(workers);

  const wins = new Map<string, string[]>();
  for (const output of outputs) {
    for (const line of output.stdout.split("\n")) {
      const [id, actor] = line.split(" ");
      if (id === undefined || actor === undefined || id === "") continue;
      wins.set(id, [...(wins.get(id) ?? []), actor]);
    }
  }
  for (const id of ids) {
    const winners = wins.get(id) ?? [];
    assert.equal(winners.length, 1, `${id} was won ${winners.length} times`);
    assert.equal(store.get(id).claimed_by, winners[0]);
  }
  assert.equal(existsSync(join(store.root, ".lock")), false, "the lock is released");
});

test("frontmatter written by another tool survives every kind of write", () => {
  const store = freshStore();
  const issue = store.create(input());
  const path = join(store.root, "issues", `${issue.id}.md`);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "version: 1",
      'version: 1\nnodeTypeId: node_abc-DEF_123\ncssclasses: dg-iss\naliases:\n  - "An alias: with a colon"',
    ),
  );
  store.approve(issue.id, "owner");
  store.claim(issue.id, "agent-a", 60, "local");
  store.update(change(issue.id, "agent-a", { add_evidence: ["seen"] }), "local");
  const after = readFileSync(path, "utf8");
  assert.ok(after.includes("nodeTypeId: node_abc-DEF_123"));
  assert.ok(after.includes("cssclasses: dg-iss"));
  assert.ok(after.includes('  - "An alias: with a colon"'));
  assert.equal(store.get(issue.id).version, 4);

  const thought = store.jot("A claim worth keeping", [], "ada");
  const file = join(store.root, thought.file);
  writeFileSync(file, readFileSync(file, "utf8").replace("id: ", "nodeInstanceId: 019d-xyz\nid: "));
  const kept = store.keepThought(thought.id, "claim");
  // Kept, and quoted on the way out because it starts with a digit.
  assert.ok(
    readFileSync(join(store.root, kept.file), "utf8").includes('nodeInstanceId: "019d-xyz"'),
  );
});
