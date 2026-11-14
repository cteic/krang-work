import { asRecord, numberField, stringArrayField, stringField } from "./json-record.ts";
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LIST_LIMIT,
  STATUSES,
  WorkError,
  isIssueStatus,
  isPriority,
  isSensitivity,
} from "./work-store.ts";
import type { CreateInput, ListFilter, Priority, Sensitivity, UpdateInput } from "./work-store.ts";

// Reading arguments the MCP server did not write. An unknown key is an error
// rather than ignored: a caller that sends `approved: true` should be told it
// did nothing, not left believing it worked.

function toRecord(value: unknown): Map<string, unknown> {
  const record = asRecord(value);
  if (record === null) throw new WorkError("invalid_input", "arguments must be an object");
  return record;
}

function only(record: Map<string, unknown>, allowed: string[]): void {
  for (const key of record.keys()) {
    if (!allowed.includes(key)) throw new WorkError("invalid_input", `unknown field "${key}"`);
  }
}

function required(record: Map<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value === null) throw new WorkError("invalid_input", `${key} is required, as a string`);
  return value;
}

function optional(record: Map<string, unknown>, key: string): string | null {
  if (!record.has(key)) return null;
  const value = stringField(record, key);
  if (value === null) throw new WorkError("invalid_input", `${key} must be a string`);
  return value;
}

function optionalList(record: Map<string, unknown>, key: string): string[] | null {
  if (!record.has(key)) return null;
  const value = stringArrayField(record, key);
  if (value === null) throw new WorkError("invalid_input", `${key} must be a list of strings`);
  return value;
}

function optionalInteger(record: Map<string, unknown>, key: string): number | null {
  if (!record.has(key)) return null;
  const value = numberField(record, key);
  if (value === null || !Number.isInteger(value)) {
    throw new WorkError("invalid_input", `${key} must be a whole number`);
  }
  return value;
}

function optionalBoolean(record: Map<string, unknown>, key: string): boolean | null {
  if (!record.has(key)) return null;
  const value = record.get(key);
  if (typeof value !== "boolean")
    throw new WorkError("invalid_input", `${key} must be true or false`);
  return value;
}

function sensitivity(record: Map<string, unknown>): Sensitivity | null {
  const value = optional(record, "sensitivity");
  if (value === null) return null;
  if (!isSensitivity(value)) {
    throw new WorkError("invalid_input", 'sensitivity must be "normal" or "sensitive"');
  }
  return value;
}

function priority(record: Map<string, unknown>): Priority | null {
  const value = optional(record, "priority");
  if (value === null) return null;
  if (!isPriority(value)) {
    throw new WorkError("invalid_input", "priority must be urgent, high, medium, low or none");
  }
  return value;
}

export function parseCreateInput(value: unknown): CreateInput {
  const record = toRecord(value);
  only(record, [
    "title",
    "description",
    "project",
    "priority",
    "labels",
    "acceptance_criteria",
    "sensitivity",
    "actor",
  ]);
  return {
    title: required(record, "title"),
    description: optional(record, "description") ?? "",
    project: optional(record, "project"),
    priority: priority(record) ?? "none",
    labels: optionalList(record, "labels") ?? [],
    acceptance_criteria: optionalList(record, "acceptance_criteria") ?? [],
    // Sensitive unless the caller says otherwise. The safe mistake is an issue
    // a cloud client cannot read back, not one it can.
    sensitivity: sensitivity(record) ?? "sensitive",
    actor: required(record, "actor"),
  };
}

export function parseUpdateInput(value: unknown): UpdateInput {
  const record = toRecord(value);
  only(record, [
    "id",
    "actor",
    "expected_version",
    "title",
    "description",
    "project",
    "priority",
    "labels",
    "acceptance_criteria",
    "sensitivity",
    "status",
    "add_comment",
    "add_evidence",
    "handoff",
  ]);
  const status = optional(record, "status");
  if (status !== null && status !== "todo" && status !== "in_review" && status !== "cancelled") {
    throw new WorkError(
      "invalid_input",
      'status must be "todo" (release a claim), "in_review" or "cancelled"; claiming is issue_claim, and done is the owner\'s',
    );
  }
  return {
    id: required(record, "id"),
    actor: required(record, "actor"),
    expected_version: optionalInteger(record, "expected_version"),
    title: optional(record, "title"),
    description: optional(record, "description"),
    project: optional(record, "project"),
    priority: priority(record),
    labels: optionalList(record, "labels"),
    acceptance_criteria: optionalList(record, "acceptance_criteria"),
    sensitivity: sensitivity(record),
    status,
    add_comment: optional(record, "add_comment"),
    add_evidence: optionalList(record, "add_evidence") ?? [],
    handoff: optional(record, "handoff"),
  };
}

// A filter left empty filters nothing. Some models fill every optional field
// with "", and read literally that would match no issue at all.
function filter(record: Map<string, unknown>, key: string): string | null {
  const value = optional(record, key);
  return value === null || value.trim() === "" ? null : value;
}

export function parseListFilter(value: unknown): ListFilter {
  const record = toRecord(value);
  only(record, ["project", "status", "label", "query", "include_closed", "limit"]);
  const status = filter(record, "status");
  if (status !== null && !isIssueStatus(status)) {
    throw new WorkError(
      "invalid_input",
      `unknown status "${status}"; use one of ${STATUSES.join(", ")}, or leave it out`,
    );
  }
  return {
    project: filter(record, "project"),
    status,
    label: filter(record, "label"),
    query: filter(record, "query"),
    // Closed issues are left out unless asked for, or a status names them.
    open_only: status === null && optionalBoolean(record, "include_closed") !== true,
    limit: optionalInteger(record, "limit") ?? DEFAULT_LIST_LIMIT,
  };
}

export interface ClaimInput {
  id: string;
  actor: string;
  lease_seconds: number;
}

export function parseClaimInput(value: unknown): ClaimInput {
  const record = toRecord(value);
  only(record, ["id", "actor", "lease_seconds"]);
  return {
    id: required(record, "id"),
    actor: required(record, "actor"),
    lease_seconds: optionalInteger(record, "lease_seconds") ?? DEFAULT_LEASE_SECONDS,
  };
}

export function parseGetInput(value: unknown): string {
  const record = toRecord(value);
  only(record, ["id"]);
  return required(record, "id");
}

export interface ThoughtInput {
  text: string;
  tags: string[];
  actor: string;
}

export function parseThoughtInput(value: unknown): ThoughtInput {
  const record = toRecord(value);
  only(record, ["text", "tags", "actor"]);
  return {
    text: required(record, "text"),
    tags: optionalList(record, "tags") ?? [],
    actor: required(record, "actor"),
  };
}

export function parseEmpty(value: unknown): void {
  only(toRecord(value), []);
}
