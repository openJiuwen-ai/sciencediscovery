#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const sourceRoot = resolve(process.env.E2E_REPLAY_CAPTURE_ROOT || "/home/zjc/master/sciencediscovery/work/model-replay/captures");
const outputRoot = resolve(process.env.E2E_REPLAY_COMPACT_ROOT || "/home/zjc/master/sciencediscovery/work/model-replay/flow-compact");
const prefixes = [
  "drb-58-serial120-", "drb-59-serial-", "drb-62-serial120-", "drb-64-serial-", "drb-75-newtoken-",
  "tc-e2e-01-newtoken120-", "puct-compress-newtoken-deepseek-", "j5-legacy-capture3-", "inline-plan-",
  "inline-markdown-", "biomni-da-13-3-newtoken-", "biomni-da-14-1-newtoken-",
];

function scrub(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/chatcmpl-[A-Za-z0-9_-]+/g, "<completion-id>")
    .replace(/(?:shell|task|execution):[A-Za-z0-9_-]+/g, "<execution-id>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<datetime>")
    .replace(/\b\d{13}\b/g, "<timestamp>")
    .replace(/\bws_[A-Za-z0-9_-]+\b/g, "<workspace>")
    .replace(/\/home\/zjc\/[^"\\]+/g, "<absolute-path>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<hash>");
}

function compactRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const compact = {
    model: body?.model,
    stream: body?.stream,
    messages: messages.filter((message) => message?.role !== "tool" && message?.role !== "system")
      .map((message) => {
        const compact = { role: message.role, content: scrub(message.content) };
        // Assistant tool calls are part of the conversation state that determines
        // the next request. Keep their stable function payload while dropping the
        // per-request id, which is regenerated on every run.
        if (Array.isArray(message.tool_calls)) {
          compact.tool_calls = message.tool_calls.map((call) => ({
            type: call?.type,
            function: call?.function ? {
              name: call.function.name,
              arguments: scrub(call.function.arguments),
            } : undefined,
          }));
        }
        if (message.function_call) {
          compact.function_call = {
            name: message.function_call.name,
            arguments: scrub(message.function_call.arguments),
          };
        }
        return compact;
      }),
  };
  // Keep a private affinity hint so independent subagent conversations stay
  // on their recorded response stream. It is ignored by request fingerprints.
  const stream = JSON.stringify(body ?? {}).match(/(?:agent-workspaces|sessions)\/([^"/]+)/)?.[1];
  if (stream) compact._replay_stream = stream;
  return compact;
}

async function filesIn(directory) {
  const out = [];
  async function visit(current, relative = "") {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = join(relative, entry.name);
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, rel);
      else out.push({ path, relative: rel });
    }
  }
  await visit(directory);
  return out;
}

async function compactCapture(source, target) {
  await mkdir(join(target, "model-calls"), { recursive: true });
  await mkdir(join(target, "runtime", "data", "projects"), { recursive: true });
  await writeFile(join(target, "metadata.env"), await readFile(join(source, "metadata.env"), "utf8"));
  const names = (await readdir(join(source, "model-calls"))).filter((name) => name.endsWith(".json")).sort();
  const responseHashes = new Map();
  let responseBytes = 0;
  for (const name of names) {
    const record = JSON.parse(await readFile(join(source, "model-calls", name), "utf8"));
    const body = typeof record.response?.body === "string" ? record.response.body : JSON.stringify(record.response?.body ?? null);
    const hash = createHash("sha256").update(body).digest("hex");
    responseHashes.set(hash, (responseHashes.get(hash) || 0) + 1);
    responseBytes += Buffer.byteLength(body);
    const compact = {
      request: { body: compactRequest(record.request?.body) },
      response: { status: record.response?.status, headers: record.response?.headers, body },
      compact: { source: basename(source), response_sha256: hash },
    };
    await writeFile(join(target, "model-calls", name), JSON.stringify(compact));
  }
  const projects = join(source, "runtime", "data", "projects");
  try { await cp(projects, join(target, "runtime", "data", "projects"), { recursive: true, force: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const projectFiles = await filesIn(join(target, "runtime", "data", "projects"));
  const manifest = {
    source: basename(source),
    calls: names.length,
    response_bytes: responseBytes,
    unique_responses: responseHashes.size,
    duplicate_response_records: names.length - responseHashes.size,
    retained_workspace_files: projectFiles.length,
    omitted: ["runtime/data/versioning", "runtime/data/scientific-envs", "runtime/data/run-events", "runtime/data/*sqlite", "logs", "browser caches"],
  };
  await writeFile(join(target, "compact-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

await mkdir(outputRoot, { recursive: true });
const summaries = [];
for (const prefix of prefixes) {
  const matches = (await readdir(sourceRoot)).filter((name) => name.startsWith(prefix));
  if (matches.length !== 1) throw new Error(prefix + ": expected one source capture, found " + matches.length);
  const source = join(sourceRoot, matches[0]);
  const target = join(outputRoot, matches[0]);
  const manifest = await compactCapture(source, target);
  summaries.push(manifest);
  console.log(matches[0] + ": " + manifest.calls + " calls, " + manifest.unique_responses + " unique responses, " + manifest.retained_workspace_files + " workspace files");
}
const index = {
  schema: 1,
  profile: "flow-compact",
  created_at: new Date().toISOString(),
  purpose: "Preserve key model/UI workflow interactions while removing runtime snapshots and compacting repeated request context.",
  execution: "Replay semantics are preserved; this profile reduces storage. A shorter-turn smoke profile requires a separate bounded recapture.",
  captures: summaries,
};
await writeFile(join(outputRoot, "index.json"), JSON.stringify(index, null, 2) + "\n");
await writeFile(join(outputRoot, "README.md"), "# Daily flow compact replay\n\nThis fixture keeps recorded model responses and project/session workspace files used by the replay seeder. It removes versioning blobs, scientific environments, run-event logs, caches and database snapshots. Request bodies retain only stable user/assistant messages and stream metadata.\n\nThe fixture preserves replay semantics and therefore does not by itself reduce the number of workflow turns. A shorter daily smoke run should be captured separately with bounded subagent/search budgets.\n");
