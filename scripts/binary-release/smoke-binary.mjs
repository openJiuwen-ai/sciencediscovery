#!/usr/bin/env node
// Release gate for the four public single-binary entry points. All temporary
// state lives beside the artifact so large payload extraction never uses /tmp.
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEA_CRASH_PATTERN = /SIGABRT|v8::ToLocalChecked|ToLocalChecked MaybeLocal|Aborted(?: \(core dumped\))?/i;
const USAGE = `Usage: smoke-binary.mjs --binary <file> [--timeout-ms <milliseconds>] [--keep-work]
`;

function parseArguments(argv) {
  const options = { keepWork: false, timeoutMs: 10 * 60 * 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    switch (argument) {
      case "--binary": options.binary = resolve(value()); break;
      case "--keep-work": options.keepWork = true; break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "-h": case "--help": process.stdout.write(USAGE); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${argument}\n\n${USAGE}`);
    }
  }
  if (!options.binary) throw new Error(USAGE);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return options;
}

export function assertNoSeaCrash(output, entryPoint) {
  const match = output.match(SEA_CRASH_PATTERN);
  if (match) throw new Error(`${entryPoint} emitted SEA crash signal: ${match[0]}`);
}

function firstMatchingLine(output, pattern) {
  return output.split(/\r?\n/).find((line) => pattern.test(line))?.trim();
}

async function runCommand(binary, args, context) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: context.cwd,
      env: context.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout}${result.stderr}`;
    assertNoSeaCrash(output, args[0]);
    return { ...result, output };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const output = `${stdout}${stderr}`;
    assertNoSeaCrash(output, args[0]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${args[0]} failed: ${detail}${output ? `\n${output}` : ""}`);
  }
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port === undefined) reject(new Error("Could not allocate a smoke-test port."));
        else resolvePort(port);
      });
    });
  });
}

async function availablePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await availablePort());
  return [...ports];
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function stopProcess(child, outcomePromise) {
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    outcomePromise,
    delay(20_000).then(() => undefined),
  ]);
  if (graceful) return graceful;
  child.kill("SIGKILL");
  return await outcomePromise;
}

async function runServe(binary, context, timeoutMs) {
  const [port, runnerPort, gatewayPort] = await availablePorts(3);
  const args = [
    "serve",
    "--data-dir", join(context.cwd, "data"),
    "--port", String(port),
    "--runner-port", String(runnerPort),
    "--gateway-port", String(gatewayPort),
    "--no-scientific-envs",
    "--skip-sandbox-check",
  ];
  const child = spawn(binary, args, {
    cwd: context.cwd,
    env: context.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let outcome;
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const outcomePromise = new Promise((resolveOutcome) => {
    child.once("error", (error) => resolveOutcome({ code: 127, error, signal: null }));
    child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
  }).then((result) => {
    outcome = result;
    return result;
  });

  const deadline = Date.now() + timeoutMs;
  let healthStatus;
  try {
    while (Date.now() < deadline) {
      assertNoSeaCrash(output, "serve");
      if (outcome) {
        const detail = outcome.error?.message ?? (outcome.signal ? `signal ${outcome.signal}` : `status ${outcome.code}`);
        throw new Error(`serve exited before readiness (${detail}).\n${output}`);
      }
      if (output.includes("ScienceDiscovery is ready at")) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          healthStatus = response.status;
          if (response.ok) break;
        } catch {
          // The banner and socket can become visible a few milliseconds apart.
        }
      }
      await delay(250);
    }
    if (healthStatus === undefined || healthStatus < 200 || healthStatus >= 300) {
      throw new Error(`serve did not become ready within ${timeoutMs} ms.\n${output}`);
    }
    const stopped = await stopProcess(child, outcomePromise);
    assertNoSeaCrash(output, "serve");
    if (stopped.code !== 0 || stopped.signal) {
      throw new Error(
        `serve did not stop cleanly after SIGTERM (${stopped.signal ? `signal ${stopped.signal}` : `status ${stopped.code}`}).\n${output}`,
      );
    }
    return {
      healthStatus,
      readyLine: firstMatchingLine(output, /ScienceDiscovery is ready at/) ?? "ready banner observed",
    };
  } catch (error) {
    if (!outcome) await stopProcess(child, outcomePromise);
    throw error;
  }
}

export async function smokeBinary(options) {
  await access(options.binary);
  const parent = dirname(options.binary);
  const smokeRoot = await mkdtemp(join(parent, `.smoke-${basename(options.binary)}-`));
  const context = {
    cwd: smokeRoot,
    env: {
      ...process.env,
      SCIENCE_AGENT_PAYLOAD_CACHE_DIR: join(smokeRoot, "payload-cache"),
    },
  };
  try {
    await mkdir(context.env.SCIENCE_AGENT_PAYLOAD_CACHE_DIR, { recursive: true });
    const help = await runCommand(options.binary, ["help"], context);
    const helpLine = firstMatchingLine(help.stdout, /^Usage: ScienceDiscovery/);
    if (!helpLine) throw new Error("help did not print the ScienceDiscovery usage line.");
    process.stdout.write(`PASS help exit=0: ${helpLine}\n`);

    const version = await runCommand(options.binary, ["version"], context);
    const versionLine = firstMatchingLine(version.stdout, /^ScienceDiscovery .+ \(linux-/);
    if (!versionLine || !/^\s*node\s+v\d+/m.test(version.stdout)) {
      throw new Error("version did not print the release and bundled Node versions.");
    }
    process.stdout.write(`PASS version exit=0: ${versionLine}\n`);

    const extractDirectory = join(smokeRoot, "extract");
    const extract = await runCommand(options.binary, ["extract", "--to", extractDirectory], context);
    await access(join(extractDirectory, "manifest.json"));
    const extractLine = firstMatchingLine(extract.output, /Unpacked the runtime payload into/)
      ?? "payload manifest extracted";
    process.stdout.write(`PASS extract exit=0: ${extractLine}\n`);

    const serve = await runServe(options.binary, context, options.timeoutMs);
    process.stdout.write(
      `PASS serve exit=0 after SIGTERM, health=${serve.healthStatus}: ${serve.readyLine}\n`,
    );
  } finally {
    if (!options.keepWork) await rm(smokeRoot, { recursive: true, force: true });
    else process.stdout.write(`Smoke work directory kept at ${smokeRoot}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  smokeBinary(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
