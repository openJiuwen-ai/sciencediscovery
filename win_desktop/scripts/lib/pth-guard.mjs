// [windows-desktop] The envs-template venvs carry editable-install `.pth`
// files whose entries are absolute paths into the checkout that built them.
// Shipping those unchanged is how a payload looks healthy on the build
// machine and dies with ModuleNotFoundError everywhere else, so the assembly
// either rewrites an entry into the runtime placeholder the shell resolves at
// first run, or refuses to build.
//
// Two conventions ship and both are matched by CONTENT, not by file name:
//   `_editable_impl_<pkg>.pth`  a workspace member (uv's editable finder)
//   `<name>.pth`                the standalone idea-tree project's source dir
// Matching by name alone left the second convention unguarded: a plain
// `<name>.pth` still pointing at a previous checkout was copied verbatim, and
// the payload smoke import could not catch it because it sets PYTHONPATH to
// the shipped sources instead of importing through the venv's site-packages.
//
// Entries that carry no checkout path stay as they are: import-style shims
// (`distutils-precedence.pth`, `_virtualenv.pth`, the `__editable__*_finder`
// loaders) and relative entries. Anything absolute outside the repo is a
// stale editable target, whatever the file is called, and is reported to the
// caller so the build fails.
//
// Field incident (stale editable venv): the envs came from a data dir carried
// over after a repo migration; their .pth files still pointed at the old
// checkout path. The earlier guard only warned and shipped anyway, and every
// Python sidecar died on the installed machine.

/** Placeholder the first-run shell replaces with the unpacked payload root. */
export const SD_BACKEND_PLACEHOLDER = "@@SD_BACKEND_ROOT@@";

/** Forward slashes, no trailing separator: the mapping files are written by
 *  Python on this host, so the separator and the drive-letter case of an entry
 *  need not match the value we get from the assembly's `--repo` argument. */
const slashed = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "");

/** Windows absolute path (`C:\x`, `C:/x`), POSIX absolute, or UNC (`\\host`). */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/**
 * Rewrite one `.pth` file's text for the payload.
 *
 * @param {{ text: string, repo: string, placeholder?: string }} input
 * @returns {{ lines: string[], placeholdered: boolean, outside: string[] }}
 *   `lines` is the rewritten content (comments and blank lines dropped, as the
 *   placeholder form has no use for them), `placeholdered` tells the caller
 *   whether the file must be written back, and `outside` lists absolute
 *   entries that escape the repo — a non-empty list must fail the build.
 */
export function rewritePthText({ text, repo, placeholder = SD_BACKEND_PLACEHOLDER }) {
  const repoSlash = slashed(repo).toLowerCase();
  // A directory boundary has to follow the prefix: `repo` is also a prefix of
  // `repo-something-else`, and that sibling would otherwise slice into a wrong
  // tail (e.g. `-something-else\...`) instead of being reported.
  const repoPrefix = `${repoSlash}/`;
  const lines = [];
  const outside = [];
  let placeholdered = false;
  for (const raw of text.split(/\r?\n/)) {
    const entry = raw.trim();
    if (!entry || entry.startsWith("#")) continue;
    const entrySlash = slashed(entry);
    if (entrySlash.toLowerCase().startsWith(repoPrefix)) {
      const tail = entrySlash.slice(repoSlash.length).replace(/^\/+/, "").replace(/\//g, "\\");
      lines.push(`${placeholder}\\${tail}`);
      placeholdered = true;
      continue;
    }
    if (ABSOLUTE.test(entry)) outside.push(entry);
    lines.push(entry);
  }
  return { lines, placeholdered, outside };
}
