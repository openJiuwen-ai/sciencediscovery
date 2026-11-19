# Hub backend: design

> Scope: the service in [`services/hub-api`](../services/hub-api) — the step
> from the static hub (browse + download) to a hub with accounts, uploads,
> version history and review. It is written against the openJiuwen Agentic Hub
> reference (`openJiuwen-ai/skillhub`) and keeps the parts of its contract that
> clients can see; it does not copy its stack wholesale.

## Why a backend now

The static hub stores everything in OBS and reads one `catalog.json`. That is
the right shape while the repository is the only publisher: no server, no
database, no account system, downloads are permanent public links.

The moment any one of these is true, the static shape stops working:

1. a user publishes an asset (the truth is no longer a merged PR);
2. an asset must be invisible until someone approves it;
3. an asset is private to a person or a group;
4. someone needs version history or "who downloaded what".

`services/hub-api` implements those four with the smallest state that can
carry them: one database, one private bucket, no Redis, no message queue.

## Reference: what was studied

| Reference file | What it establishes | What we do with it |
|---|---|---|
| `marketplace/plugins_market/models/market_assets.py` | Asset + version tables, review state per version, `public_latest_version`, visibility | Same split: metadata on the asset, artifact and review state on the version |
| `marketplace/plugins_market/core/s3_storage_client.py` | Private S3-compatible storage, presigned download, STS or static credentials | Presign with static IAM keys; STS is a later option |
| `marketplace/plugins_market/routers/plugin.py` | `/plugins`, `/artifacts/{id}`, publish as multipart, files listing with `with_content` | Same public surface under `/assets` and `/artifacts/{id}` |
| `marketplace/plugins_market/schemas/*` | Response envelope `{code, message, data}` | Same envelope |
| `docker/k8s/marketplace-deploy.yaml` | Backend requests 250m/512Mi, limits 2 CPU/2Gi | Sizing input for the single-host deployment |

Deliberate differences:

- **Own data model.** The reference has six asset types and no session
  packages. The hub publishes five kinds in one lifecycle — `skill`, `team`,
  `specialist`, `connector`, `session` — so there is one `assets` table with a
  `kind` column rather than one model per type.
- **No plugin schema validation.** The reference validates `plugin.yaml`,
  icons and previews per type. The hub accepts a zip or `.sdresearch` package
  and validates what a server must: size, traversal, zip bombs, per-entry
  digests. Domain checks stay in the exporter until a type needs them.
- **Stateless sessions.** The reference keeps OAuth sessions in Redis. This
  service signs its own HMAC tokens, so the only stateful dependency is the
  database (SQLite in development, MySQL in production).
- **No recommendation, retrieval, playground or counts beyond downloads.**
  Those are separate services in the reference; none is needed to publish and
  download.

## Architecture

```text
browser / desktop app
        │  HTTPS
        ▼
┌──────────────────────────────┐
│ reverse proxy (TLS)          │  serves the static site and /api
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐        ┌───────────────────────┐
│ services/hub-api (FastAPI)   │───────▶│ MySQL (metadata)      │
│  auth · assets · artifacts   │        └───────────────────────┘
│  review · files              │        ┌───────────────────────┐
└──────────────┬───────────────┘───────▶│ OBS, private bucket   │
               │ presigned URL          └───────────────────────┘
               ▼
        browser downloads bytes
```

The bucket never serves an anonymous request. `GET /api/v1/artifacts/{id}`
resolves the version, checks visibility, and returns a URL that expires
(`HUB_PRESIGN_SECONDS`, default 10 minutes). A second route,
`/api/v1/artifacts/{id}/content`, streams the same bytes through the service;
the browser's save dialog uses it because a cross-origin read of a presigned
URL would require a bucket CORS rule, which the hub's credentials do not
include. This is the same trade the
reference makes: control and auditability in exchange for a server on the read
path and no CDN caching of downloads.

## Data model

```text
users            id, username, password_hash, display_name, role, created_at
assets           id, kind, name, display_name, summary, description,
                 publisher_id, category, tags, visibility,
                 latest_version, public_latest_version,
                 download_count, created_at, updated_at
asset_versions   id, asset_id, version, filename, storage_key, sha256, size,
                 manifest (JSON), changelog, moderation_status,
                 reject_reason, reviewed_by, reviewed_at, created_at
audit_log        id, actor_id, action, asset_id, version, detail, created_at
```

Rules:

- Asset ids are not always slugs: external skills use a path
  (`chemistry_and_materials/real_world_workstations/dual-station-…`, up to 88
  characters), so id columns are 191, storage keys validate the id segment by
  segment, and the API routes the id with a path converter.
- `(publisher_id, kind, name)` is unique: one publisher cannot have two
  `skill`s with the same name.
- `(asset_id, version)` is unique and **write-once**. A rejected version is not
  overwritten; the publisher uploads the next version number. History stays
  truthful.
- `public_latest_version` is null until a version is approved. The public list,
  the public detail page and an unversioned download all resolve through it.
- `manifest` is the inventory computed at upload time: every entry's path,
  size and sha256. The Files tab renders it without unpacking in the browser,
  matching the static exporter's contract.

## API

The envelope and paths follow the reference so a client can be repointed.
Full table: [`services/hub-api/README.md`](../services/hub-api/README.md).

Highlights:

- `GET /api/v1/assets` — approved public assets; `mine=true` returns the
  caller's drafts.
- `POST /api/v1/assets/{id}/versions` — multipart (`version`, `changelog`,
  `file`); runs validation before writing.
- `GET /api/v1/artifacts/{id}?version=` — `{url, sha256, size, expires_in}`.
- `GET /api/v1/assets/{id}/versions/{v}/files?with_content=SKILL.md` — the
  inventory plus one file's text, or `null` for binaries.
- `POST /api/v1/admin/reviews/{id}/{version}` — `approve` or `reject` with a
  reason; approval is what moves `public_latest_version`.

## Storage

```text
assets/<kind>/<publisher_id>/<asset_id>/<version>/<filename>
```

One bucket, private throughout. The key is composed in exactly one function
(`app/storage.py:package_key`), so a later move to versioned prefixes or a
different layout is a one-line change plus a migration script.

The bucket policy grants the IAM sub-user `PutObject` and the service nothing
else at the anonymous level: there is no anonymous read at all. If public
static assets remain published to the bucket by the existing workflow, they
live under their own prefix (`site/`) and keep their own policy; the backend
never reads them.

## Security decisions

| Decision | Reason |
|---|---|
| Private bucket + presigned URL | No object is enumerable or permanently linkable; a rejected/withdrawn asset stops being downloadable when its version is unapproved |
| Size checked after reading the body | `Content-Length` is advisory; the service re-checks the bytes |
| Traversal, absolute paths, backslashes rejected | The archive is untrusted; the same rule the exporter applies to the external snapshot |
| Uncompressed-size ceiling | A 1 MiB zip can expand to gigabytes; refuse before writing |
| Per-entry sha256 in the manifest | The client can verify a single file without trusting the server |
| Scrypt password hashing, HMAC tokens | No native crypto dependency, no session table |
| Registration closed after the first account | The first account is the administrator; later accounts come from the administrator |
| Every review and upload in `audit_log` | Who published, who approved, when |

## Deployment

`docker-compose.yml` runs the API beside MySQL on one host. OBS is external.
TLS terminates in front of the stack (reverse proxy or load balancer), which
is also what serves the static site.

A 4 vCPU / 8 GiB host is the sensible start: MySQL takes 1–2 GiB, the API
process is measured in hundreds of MiB, and image builds are the only CPU
spike. The reference's own container limits (2 CPU / 2 GiB for the backend)
agree with that sizing.

Required environment is listed in `.env.example`; the only secret that must be
generated is `HUB_SESSION_SECRET`.

## Migration from the static hub

1. Deploy the API and MySQL; create the bucket prefix or use the same bucket
   under a private prefix.
2. Import the existing catalogue:
   [`services/hub-api/scripts/import_catalog.py`](../services/hub-api/scripts/import_catalog.py)
   reads `catalog.json`, preserves every id, verifies each artifact against
   the catalogue's sha256, uploads it and records the version as approved.
   It is idempotent, so it can be re-run after a failed pass, and
   `--dry-run` validates without writing.
3. Keep the static site as the front page during the transition. Build it
   with `VITE_HUB_API_BASE=/api/v1` and every download resolves through the
   API (which is what a private bucket requires); without that variable the
   site behaves exactly as before, so the switch is a build flag, not a fork.
4. Once every published asset exists in the database, the exporter's
   `catalog.json` becomes a cache the API can regenerate instead of the source
   of truth.

The importer covers all five kinds. Specialists and connectors ship a single
JSON file; the importer wraps it in a one-entry archive so every version has
the same shape, and checks the catalogue digest against the file, not the
wrapper.

## Not in this iteration

- OAuth / SSO (the reference uses GitCode OAuth; the hub can add an OIDC
  provider behind the same token interface)
- Search and category trees (the static exporter's tree can move server-side)
- Rate limiting and abuse controls on login, upload and download
- Download analytics beyond a counter
- Group permissions (the reference's `visibility=private` plus groups)
- The admin UI; until then the API's `/docs` page is the operator console
- An upload form in the site: the download path is wired to the API, but
  publishing still goes through the API or `curl` until the UI lands
