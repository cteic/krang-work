import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { asRecord, recordField, stringField } from "./json-record.ts";
import { isLoopback } from "./ollama.ts";

export { isLoopback };

// A small agent: a model on this machine, given the work store's MCP tools and
// nothing else. It has no shell and no file access, so the store's rules hold
// against it in full: it can read, create, claim and submit, and it cannot
// approve or mark done.
//
// Two halves. McpClient speaks the protocol to a server it starts as a child
// process, the same way any MCP client would. runAgent is the loop: ask the
// model, run the tool calls it makes, hand back the results, until it answers
// in words or runs out of steps.

interface Pending {
  resolve: (value: Map<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    // The server's stderr is its log. It is not the model's business.
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.on("close", () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error("the server closed"));
      this.pending.clear();
    });
  }

  private receive(line: string): void {
    let message: Map<string, unknown> | null;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    const id = message?.get("id");
    if (message === null || typeof id !== "number") return;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    this.pending.delete(id);
    const error = recordField(message, "error");
    if (error !== null) waiting.reject(new Error(stringField(error, "message") ?? "server error"));
    else waiting.resolve(recordField(message, "result") ?? new Map());
  }

  private request(method: string, params: unknown): Promise<Map<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<string> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "krang-local-agent", version: "0.1.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    return stringField(result, "instructions") ?? "";
  }

  async tools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    const raw = result.get("tools");
    const tools: McpTool[] = [];
    if (!Array.isArray(raw)) return tools;
    for (const item of raw) {
      const tool = asRecord(item);
      const name = tool === null ? null : stringField(tool, "name");
      if (tool === null || name === null) continue;
      tools.push({
        name,
        description: stringField(tool, "description") ?? "",
        inputSchema: tool.get("inputSchema") ?? { type: "object" },
      });
    }
    return tools;
  }

  // The text a tool returned. A refused call is text too: the model reads the
  // refusal and decides what to do next.
  async call(name: string, args: unknown): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args });
    const content = result.get("content");
    const first = Array.isArray(content) ? asRecord(content[0]) : null;
    return first === null ? "" : (stringField(first, "text") ?? "");
  }

  close(): void {
    this.child.stdin.end();
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown;
  tool_name?: string;
}

export interface ToolCall {
  name: string;
  arguments: unknown;
}

export interface ModelTurn {
  content: string;
  calls: ToolCall[];
  raw: ChatMessage;
}

// One turn of the model. Injected, so the loop can be tested without a model.
export type Chat = (messages: ChatMessage[], tools: McpTool[]) => Promise<ModelTurn>;

export function ollamaChat(host: string, model: string, timeoutMs = 600_000): Chat {
  // Refused rather than trusted: this is the one place an issue marked
  // sensitive reaches a model, so the address must be this machine.
  if (!isLoopback(host))
    throw new Error(`${host} is not this machine; a local agent only runs locally`);
  return async (messages, tools) => {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        options: { temperature: 0, num_ctx: 16384 },
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${text.slice(0, 300)}`);
    const message = recordField(asRecord(JSON.parse(text)) ?? new Map(), "message");
    if (message === null) throw new Error("Ollama sent no message");
    const calls: ToolCall[] = [];
    const rawCalls = message.get("tool_calls");
    if (Array.isArray(rawCalls)) {
      for (const item of rawCalls) {
        const fn = recordField(asRecord(item) ?? new Map(), "function");
        const name = fn === null ? null : stringField(fn, "name");
        if (fn !== null && name !== null)
          calls.push({ name, arguments: fn.get("arguments") ?? {} });
      }
    }
    const content = stringField(message, "content") ?? "";
    return { content, calls, raw: { role: "assistant", content, tool_calls: rawCalls } };
  };
}

export interface AgentEvent {
  kind: "call" | "result" | "answer" | "stopped";
  text: string;
}

export interface AgentOptions {
  task: string;
  actor: string;
  maxSteps: number;
  onEvent: (event: AgentEvent) => void;
}

export async function runAgent(
  client: McpClient,
  chat: Chat,
  options: AgentOptions,
): Promise<string> {
  const instructions = await client.start();
  const tools = await client.tools();
  const known = new Set(tools.map((tool) => tool.name));
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You work through a local issue tracker using the tools provided. You have no other tools.",
        instructions,
        `Your actor name is "${options.actor}". Pass it as the actor on every call that takes one.`,
        "Call tools to find out; do not guess what the tracker holds. When a tool refuses, read the reason and report it; do not retry the same call.",
        "When the task is done, or cannot be done, answer in plain words: what you did, and what is left for the owner.",
      ].join("\n"),
    },
    { role: "user", content: options.task },
  ];

  for (let step = 0; step < options.maxSteps; step++) {
    const turn = await chat(messages, tools);
    messages.push(turn.raw);
    if (turn.calls.length === 0) {
      options.onEvent({ kind: "answer", text: turn.content });
      return turn.content;
    }
    for (const call of turn.calls) {
      options.onEvent({ kind: "call", text: `${call.name} ${JSON.stringify(call.arguments)}` });
      // A tool the server does not have is answered here, not sent on.
      const result = known.has(call.name)
        ? await client.call(call.name, call.arguments)
        : JSON.stringify({ error: { code: "unknown_tool", message: `no tool ${call.name}` } });
      options.onEvent({ kind: "result", text: result });
      messages.push({ role: "tool", tool_name: call.name, content: result });
    }
  }
  const stopped = `Stopped after ${options.maxSteps} steps without a final answer.`;
  options.onEvent({ kind: "stopped", text: stopped });
  return stopped;
}
