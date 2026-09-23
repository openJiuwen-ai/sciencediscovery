import { appendFile, chmod, rename, stat } from "node:fs/promises";
import type { ModelTurn } from "@sciencediscovery/model";

// Serialize rotation across concurrent main/child gateways. Never retain turns in the queue.
let writes = Promise.resolve();
export async function recordInvalidArguments(turn: ModelTurn, requestId: string): Promise<void> {
  const invalid = turn.toolCalls.filter((call) => call.argsParseError);
  if (!invalid.length) return;
  const metadata = {
    event: "model.invalid_tool_arguments", timestamp: new Date().toISOString(), requestId,
    truncated: turn.truncated === true, usage: turn.usage,
    invalidCount: invalid.length,
    calls: invalid.slice(0, 20).map((call) => ({ toolCallId: call.id.slice(0, 128), tool: call.name.slice(0, 128) })),
  };
  // JSON.parse error messages can quote user content: keep them out of ordinary logs.
  console.warn(`[model-arguments] ${JSON.stringify(metadata)}`);
  const file = process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE;
  if (!file) return;
  const wire = Array.isArray(turn.assistantMessage.tool_calls)
    ? turn.assistantMessage.tool_calls as Array<{ id?: string; function?: { arguments?: string } }> : [];
  const line = JSON.stringify({ ...metadata, calls: invalid.slice(0, 20).map((call) => {
    const raw = wire.find((item) => item.id === call.id)?.function?.arguments;
    return {
      toolCallId: call.id.slice(0, 128), tool: call.name.slice(0, 128), error: call.argsParseError?.slice(0, 2048),
      rawAvailable: typeof raw === "string", argumentChars: raw?.length,
      // Preserve both ends of very large payloads without unbounded disk/memory use.
      rawArguments: raw && raw.length > 16384 ? undefined : raw,
      head: raw && raw.length > 16384 ? raw.slice(0, 8192) : undefined,
      tail: raw && raw.length > 16384 ? raw.slice(-8192) : undefined,
      clipped: typeof raw === "string" && raw.length > 16384,
    };
  }) }) + "\n";
  writes = writes.then(async () => {
    const size = await stat(file).then((s) => s.size, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    if (size) await chmod(file, 0o600);
    if (size + Buffer.byteLength(line) > 5 * 1024 * 1024) await rename(file, `${file}.1`);
    await appendFile(file, line, { mode: 0o600 });
  }).catch(() => { console.warn("[model-arguments] diagnostic file write failed"); });
  await writes;
}
