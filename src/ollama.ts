import { asRecord, stringField } from "./json-record.ts";

// One request to a model served by Ollama on this machine. The host is checked
// before anything is sent: this function is how private notes reach a model,
// so a host that is not loopback is an error, not a setting.

export interface GenerateOptions {
  host: string;
  model: string;
  prompt: string;
  keepAlive: string;
  think: boolean;
  options: Record<string, unknown>;
  timeoutMs?: number;
}

export interface GenerateResult {
  response: string;
}

export function isLoopback(host: string): boolean {
  try {
    const name = new URL(host).hostname;
    return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  } catch {
    return false;
  }
}

export async function generate(request: GenerateOptions): Promise<GenerateResult> {
  if (!isLoopback(request.host)) {
    throw new Error(`${request.host} is not this machine. Nothing was sent.`);
  }
  let response: Response;
  try {
    response = await fetch(`${request.host}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(request.timeoutMs ?? 300_000),
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        stream: false,
        think: request.think,
        keep_alive: request.keepAlive,
        options: request.options,
      }),
    });
  } catch {
    throw new Error(
      `Ollama is not answering at ${request.host}. Start it with \`ollama serve\`, then retry. Nothing was sent anywhere else.`,
    );
  }
  const text = await response.text();
  if (!response.ok)
    throw new Error(`Ollama returned ${response.status}: ${text.trim().slice(0, 300)}`);
  const record = asRecord(JSON.parse(text));
  return { response: record === null ? "" : (stringField(record, "response") ?? "") };
}
