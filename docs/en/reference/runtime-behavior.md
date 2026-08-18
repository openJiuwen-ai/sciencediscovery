# Runtime Behavior Reference

The root [README](../../../README.md) covers basic use. This page documents models, setting inheritance, skills, permissions and review, timeouts, session lifecycle, execution limits, and paper-reader limits.

## Models

Each model configuration has a display name, base URL such as `https://api.openai.com/v1`, model ID, optional **Vision capable** flag, and API token.

- The **task model** runs chat and agent work.
- The **evidence-review model** is an optional separate semantic reviewer.
- Provider tokens are encrypted at rest with AES-256-GCM and the owner-readable `model-secrets.key`. The API never returns the raw token.
- Protect and back up the data directory and key together. This is not an OS keychain.

## Runtime settings and inheritance

Task model, evidence-review model, enabled connectors, and semantic-review setting are each resolved independently: Global defaults, then Project override, then Session override. An **Inherit** field follows later parent changes and the editor displays the effective value and source. Connector lists replace the whole parent list; an explicit empty list disables all inherited connectors.

Skill selection starts at Project scope. Its default **all** mode exposes every installed skill to runs and `/`; Global has no skill setting. Project can select a whitelist and Session can inherit or override it. In selected mode, `/` suggests only effective skills and runs reject attachments outside the whitelist.

New Sessions inherit by default, but creation still requires a resolved task model with a saved provider token. A run snapshots settings at startup; later parent changes do not rewrite running or historical configuration.

## Skill management

**System configuration → Skills** contains built-in skills and local packages. Portable packages use:

```text
my-skill/
  SKILL.md          # required YAML frontmatter and Markdown instructions
  scripts/          # optional; retained but never auto-executed
  references/       # optional text resources
  assets/           # optional package resources
```

`SKILL.md` requires a lowercase kebab-case `name` matching the directory and a non-empty `description`. The manager supports editing, natural-language drafts, reviewable Session distillation, local Markdown/ZIP import, and Git import from HTTPS/SSH URL with optional ref/subdirectory. Git credentials stay in the local credential helper or SSH configuration and are not placed in URLs or model context. Registries, marketplaces, signatures, and automatic updates are unsupported.

There is one global skill library. New/imported skills are immediately available in all mode; narrow them at Project or Session scope. Each managed edit creates an immutable revision, runs freeze selected revisions, and Prompt Manifest records IDs, revisions, versions, and package hashes. Only selected-mode references prevent deletion.

Imports are untrusted. ZIP validation rejects traversal, symlinks, encryption, duplicates, and excess limits: 25 MiB upload, 50 MiB expanded, 500 files, 10 MiB per resource, and 512 KiB `SKILL.md`. Prompts initially list only name, description, and revision. The model uses `describe_skill`, then `read_skill`, and optionally bounded `read_skill_resource`. `scripts/` are preserved for portability but never installed, run, or copied to the Python workspace automatically.

## Managed scientific environments

Runner startup and health do not wait for environment installation. A new data directory downloads and verifies application-owned micromamba in the background and creates only the Python base. **System configuration → Environments** shows state, phase, description, failure, and timestamps and permits retry. R is downloaded only on the first explicit named-R environment creation; existing R bases survive upgrades.

The environment catalog is instance-global, not per Project. Python/R bases are read-only and undeletable. Package changes require a named environment, use controlled APIs, create immutable revisions, and advance `currentRevisionId`. Direct conda/mamba/micromamba/pip mutation through `run_shell` is unsupported and bypasses provenance.

## Permissions and reviewer

Enabling a connector or runtime does not authorize its execution. The first matching code or connector action pauses for a permission card unless a non-revoked grant exists. Persistent grants are managed under **System configuration → Permissions**. Directory tools remain inside the workspace; permission never disables Bubblewrap isolation and never changes the effective sandbox network policy, which only the system setting decides.

Reviewer Specialist is off by default. Once enabled, **Run review** or an explicit request reviews an Artifact. Quick review checks citation format and computation provenance, persists a separate card, and supplies it to later main-agent context without blocking the current conversation. Text versions expose a diff while both immutable versions remain stored.

## Timeouts and run status

**System configuration → Timeouts** controls agent idle, full agent turn, runner execution, persistent-kernel idle, and permission-wait wall-clock limits. Agent idle stops a turn with no stream output or progress; agent turn bounds model, tools, and streaming together. Every field supports **Unlimited** (`0` in API/environment variables). The default idle timeout is 240 seconds and the other four are unlimited. Environment variables seed a new data directory; persisted UI values then take precedence. Internal request-signature freshness windows are deliberately not exposed.

**System configuration → Runtime status** auto-refreshes active Session runs, runner queue/running tasks, and persistent kernels. A timeout reports its reason and duration in the stream and Session history. **Stop run** cancels the run through gateway and callbacks, kills in-flight Bubblewrap execution, and removes queued runner work. Runtime status can **Teardown** a kernel by ID. Downstream HTTP guards for reviewer, paper worker, and connector IO are separate from these product settings.

## Session lifecycle and deletion

Use **Active**, **Archived**, or **All** filters. Archiving preserves messages, files, papers, and audit history but makes a Session read-only until restored: runs, settings, uploads, connector calls, paper changes, and permission changes are rejected.

**Delete** is irreversible. The UI requests a server-side impact preview and requires the exact resource name. Session deletion removes its workspace and history; Project deletion cascades to all active and archived Sessions and Project settings. Back up the data directory first if it might be needed.

## Execution limits

There are no compute tiers or CPU/memory quotas. Guardrails are a configurable execution wall clock (unlimited locally by default), 10 GiB runner workspace, 1 GiB retained stdout+stderr per execution with truncation, and one global execution worker. There is no separate runner per-file limit. API upload limits are instead 1 GiB per file, 10 GiB per request, and 10 GiB cumulative workspace. See [Quota levels](configuration.md#quota-levels). Isolation remains Bubblewrap namespaces, seccomp, and only the Session workspace visible from the host filesystem. Network is a policy, not a constant: it defaults to `none` (no interface in the sandbox), and when an administrator enables a **domain allowlist** under **System configuration → Sandbox network** the sandbox still has no interface — outbound traffic leaves only through this deployment's egress gateway, filtered by the allowed domains. The effective policy is snapshotted into the Permission Epoch and reported at `/api/health.sandboxNetwork`; see [Sandbox execution](../explanation/sandbox-execution.md#31-sandbox-network-access).

## Paper reader limits

PDFs are limited to 50 MiB and 200 pages; extraction caps are 20 million text characters, 256 tables, 128 figures, and 24 page previews. There is **no OCR**. Pages with little embedded text may be marked for a vision-capable model, which analyzes at most four images. Vision output is model interpretation, not authoritative transcription.

Article-level license constraints are reused. The Europe PMC open-access PDF path still uses the legacy PMC OA Web Service/HTTPS layout scheduled for retirement in August 2026.
