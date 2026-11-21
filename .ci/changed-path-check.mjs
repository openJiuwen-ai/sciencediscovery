import { spawnSync } from "node:child_process";
import { loadSourceTestMap } from "./source-test-map.mjs";
import { classifySource, isInventorySource } from "./source-scope.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const headIndex = args.indexOf("--head");
const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.CI_BASE_SHA;
const head = headIndex >= 0 ? args[headIndex + 1] : process.env.CI_HEAD_SHA;
const optionValueIndexes = new Set();
if (baseIndex >= 0) { optionValueIndexes.add(baseIndex); optionValueIndexes.add(baseIndex + 1); }
if (headIndex >= 0) { optionValueIndexes.add(headIndex); optionValueIndexes.add(headIndex + 1); }
const explicitPaths = args.filter((value, index) => value && !optionValueIndexes.has(index) && !value.startsWith("--"));
// Explicit paths are treated as additions for direct policy checks.
let changed = explicitPaths.map(path => ({ status: "A", path: path.replaceAll("\\", "/") }));
const hasBase = base && !/^0+$/u.test(base);
if (!changed.length && head && (hasBase || process.env.CI_FORK_UPSTREAM)) {
  let comparisonBase = base;
  const forkUpstream = process.env.CI_FORK_UPSTREAM;
  if (forkUpstream) {
    // A rebased fork push includes commits already accepted upstream. Check
    // the fork's full contribution using its common ancestor with upstream.
    const fetch = spawnSync("git", ["fetch", "--no-tags", "--no-recurse-submodules", forkUpstream, "refs/heads/main"], {
      cwd: root, encoding: "utf8",
    });
    if (fetch.status !== 0) throw new Error(`Unable to fetch upstream main: ${fetch.stderr || fetch.error || fetch.status}`);
    const mergeBase = spawnSync("git", ["merge-base", "FETCH_HEAD", head], { cwd: root, encoding: "utf8" });
    if (mergeBase.status !== 0) throw new Error(`Unable to find the fork's upstream base: ${mergeBase.stderr || mergeBase.error || mergeBase.status}`);
    comparisonBase = mergeBase.stdout.trim();
    console.log(`Checking fork changes from upstream merge base ${comparisonBase}`);
  } else if (process.env.CI_FETCH_PUSH_BASE === "1" && /^[0-9a-f]{40}$/iu.test(base) && !/^0+$/u.test(base)) {
    // Other force pushes still use the previous tip, which may need fetching.
    const present = spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root });
    if (present.status !== 0) {
      console.log(`Fetching previous push tip ${base} from origin`);
      const fetch = spawnSync("git", ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", base], {
        cwd: root, encoding: "utf8",
      });
      if (fetch.status !== 0) {
        throw new Error(`Unable to fetch previous push tip ${base}: ${fetch.stderr || fetch.error || fetch.status}`);
      }
    }
  }
  // Renames are represented as deletion + addition: a new path needs its own mapping.
  const diff = spawnSync("git", ["diff", "--no-ext-diff", "--no-renames", "--name-status", "--diff-filter=AMT", "-z", comparisonBase, head, "--"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new Error(`Unable to compare ${comparisonBase}..${head}: ${diff.stderr || diff.error || diff.status}`);
  const fields = diff.stdout.split("\0").slice(0, -1);
  for (let i = 0; i < fields.length; i += 2) changed.push({ status: fields[i], path: fields[i + 1] });
} else if (!changed.length) {
  console.log("Changed-path source-test policy not applicable: no comparison range");
  process.exit(0);
}

const map = await loadSourceTestMap(root);
const mapped = new Set(map.entries.map(entry => entry.source));
const candidates = changed.filter(({ path }) => isInventorySource(path));
const missing = candidates.filter(({ path }) => !mapped.has(path));
const enforce = process.env.CI_ENFORCE_SOURCE_MAP === "1";
const blocking = [];
const warnings = [];
for (const { status, path } of missing) {
  const added = status === "A";
  const message = `${added ? "added" : "existing changed"} source has no test mapping: ${path}`;
  const mustMap = added && enforce && classifySource(root, path) === "behavioral";
  (mustMap ? blocking : warnings).push(message);
}
if (warnings.length) console.warn(`Changed-path source-test policy warning:\n- ${warnings.join("\n- ")}`);
if (blocking.length) {
  console.error(`Changed-path source-test policy failed:\n- ${blocking.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Changed-path source-test policy OK: ${candidates.length - missing.length}/${candidates.length} mapped`);
}
