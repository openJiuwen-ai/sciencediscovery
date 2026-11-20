# ScienceDiscovery Hub API

Accounts, uploads, version history, review and signed downloads for the asset
hub. This is the service the static site grows into when the hub needs more
than "browse and download": a private bucket, per-user publishing, approval
before an asset is visible, and a stable API the desktop app and the site can
both call.

The design and its mapping to the openJiuwen Agentic Hub reference are in
[`docs/hub-backend-design.md`](../../docs/hub-backend-design.md).

## Run it locally

```bash
cd services/hub-api
uv venv .venv
uv pip install -e '.[dev]'
export HUB_SESSION_SECRET=$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')
.venv/bin/uvicorn app.main:create_app --factory --reload --port 8100
```

Defaults are the development profile: SQLite at `./.hub-api.db`, packages in
`./.hub-storage`, downloads served by the API itself. That profile refuses to
start with the committed default `HUB_SESSION_SECRET`, because the signed
development download URL would otherwise be forgeable. The guard does not
depend on the backend: session tokens use the same key, so an `s3` profile with
the default or empty secret refuses to start for the same reason, and a bare
image built from `Dockerfile` must be given `HUB_SESSION_SECRET` (plus its
database and storage settings) before it will start. Open
<http://127.0.0.1:8100/docs> for the OpenAPI page.

The first account to register becomes an administrator. After that,
registration is closed unless `HUB_ALLOW_REGISTRATION=true`.

## Test

```bash
.venv/bin/python -m pytest
```

The suite covers the lifecycle end to end: register, upload, review, publish,
resolve a download, fetch the exact bytes, read the Files tab, and the limits
a server must enforce (size, traversal, zip bombs).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HUB_DATABASE_URL` | `sqlite:///./.hub-api.db` | SQLAlchemy URL. Production: `mysql+pymysql://user:pass@host/db` |
| `HUB_STORAGE_BACKEND` | `local` | `local` or `s3` |
| `HUB_LOCAL_STORAGE_ROOT` | `./.hub-storage` | Directory for the `local` backend |
| `HUB_S3_ENDPOINT` | — | e.g. `https://obs.cn-north-4.myhuaweicloud.com` |
| `HUB_S3_REGION` | — | e.g. `cn-north-4` |
| `HUB_S3_BUCKET` | — | The private bucket |
| `HUB_S3_ACCESS_KEY` / `HUB_S3_SECRET_KEY` | — | IAM sub-user credentials; never commit them |
| `HUB_PRESIGN_SECONDS` | `600` | Download link lifetime |
| `HUB_SESSION_SECRET` | dev value | HMAC key for session tokens and development download URLs; the service refuses to start on an empty or default value unless `HUB_ALLOW_DEV_SECRET=1` |
| `HUB_SESSION_TTL_SECONDS` | `604800` | Login lifetime |
| `HUB_MAX_PACKAGE_BYTES` | `52428800` | Upload cap (50 MiB). A declared `Content-Length` above it is rejected before the multipart parser runs; a chunked body is still spooled and stopped by the running limit |
| `HUB_MAX_UNCOMPRESSED_BYTES` | `536870912` | Archive-expansion ceiling |
| `HUB_PREVIEW_MAX_BYTES` | `2097152` | Largest single file the Files tab previews |
| `HUB_ALLOW_DEV_SECRET` | `false` | Explicit opt-in for running with the default/empty session secret |
| `HUB_ALLOW_REGISTRATION` | `false` | Whether anyone may create an account |
| `HUB_ADMIN_USERNAME` / `HUB_ADMIN_PASSWORD` | — | Optional administrator created at startup |
| `VITE_HUB_API_BASE` | — | Build-time, site only: API prefix (e.g. `/api/v1`) so downloads resolve through the service |

## Run the site against the local API

```bash
pnpm hub:export
HUB_BASE_PATH=/site/ VITE_HUB_API_BASE=/api/v1 \
  pnpm --filter @sciencediscovery/hub build
```

`dist/` then contains the catalogue, the skill READMEs and the packages,
because Vite copies `public/` into it. A workspace-wide `pnpm build` rebuilds
`dist/` without those env vars and without the exporter's output, so run the
two commands again after one; otherwise `/site/catalog.json` falls back to
`index.html` and the page reports a JSON parse error.

## Service-hosted site (API mode)

When the database is the source of truth, the site reads `GET /api/v1/catalog`
instead of a build artifact. Build it without the exporter:

```bash
VITE_HUB_API_BASE=/api/v1 pnpm hub:build:api --root
```

`/api/v1/catalog` returns the same `{assets, categories}` shape the static file
had, with `readme` and `resources[].url` pointing at
`/api/v1/assets/{id}/readme?format=text` and
`/api/v1/assets/{id}/versions/{v}/files/content?path=…`. Asset rows now carry
`readme` (the rendered description) and `extra` (kind-specific fields: hardware,
members, tools, benchmark, contents, run). An existing database needs:

```sql
ALTER TABLE assets ADD COLUMN readme LONGTEXT NOT NULL;
ALTER TABLE assets ADD COLUMN extra JSON NOT NULL;
```

then the importer backfills both.

## Import the existing catalogue

```bash
.venv/bin/python -m scripts.import_catalog \
  --catalog ../../apps/hub/public/catalog.json \
  --assets-root ../../apps/hub/public \
  --sessions-root /srv/hub/sessions \
  --publisher hub-publisher \
  --dry-run
```

Drop `--dry-run` to write. The importer preserves catalogue ids, verifies each
artifact's sha256, wraps single-file assets (specialists, connectors) in a
zip, marks every imported version approved and is safe to re-run.

## Deploy

Before deploying, prove the bucket and the credentials:

```bash
set -a; . ./.env; set +a
.venv/bin/python -m scripts.storage_smoke
```

It uploads a few bytes, presigns a URL, downloads it anonymously, checks the
digest, confirms an unsigned GET is refused, and deletes the object.

The site's save dialog (`showSaveFilePicker`, Chrome and Edge) writes from
`GET /api/v1/artifacts/{id}/content`, not from the presigned bucket URL: a
cross-origin read needs a bucket CORS rule, and the same-origin endpoint needs
none. Direct downloads still navigate to the presigned URL, so the bucket's
bandwidth stays off the server for the common case.

The host clock must be within fifteen minutes of real time: SigV4 rejects a
signature dated further ahead (`RequestTimeTooSkewed`). Run NTP on the server.
The smoke script measures and compensates for a drifting development host; the
service itself does not, on purpose.

`Dockerfile` builds the service; `docker-compose.yml` runs it beside MySQL and
an nginx container that serves `apps/hub/dist` and proxies `/api/` to the
service. Build the site for the root path first:

```bash
pnpm hub:build:api --root   # HUB_BASE_PATH=/, no exporter, no catalog.json
```

Then `docker compose --env-file .env up -d --build` and open
`http://127.0.0.1:8080/`.
The bucket is expected to be **private**: every download is a presigned URL
issued by `GET /api/v1/artifacts/{id}`. Do not put credentials in the image;
pass them as environment variables from the host's secret store.

## API

All responses use the envelope `{"code": 200, "message": "ok", "data": …}`,
the same shape the reference marketplace returns.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | — | Liveness and storage backend |
| POST | `/api/v1/auth/register` | — | First account or, when open, a new account |
| POST | `/api/v1/auth/login` | — | Token |
| GET | `/api/v1/auth/me` | user | Current account |
| GET | `/api/v1/assets` | optional | Public catalogue; `mine=true` for your drafts |
| POST | `/api/v1/assets` | user | Create asset metadata |
| GET | `/api/v1/assets/{id}` | optional | Detail; owner sees drafts |
| PATCH | `/api/v1/assets/{id}` | owner/admin | Edit metadata |
| GET | `/api/v1/assets/{id}/versions` | optional | Approved versions, or all for the owner |
| POST | `/api/v1/assets/{id}/versions` | owner/admin | Upload a package (multipart) |
| GET | `/api/v1/assets/{id}/versions/{v}/files` | optional | Inventory; `with_content=<path>` for text |
| GET | `/api/v1/artifacts/{id}?version=` | optional | Signed download URL + digest |
| GET | `/api/v1/artifacts/{id}/content?version=` | optional | Streams the bytes same-origin, for the browser's save dialog |
| GET | `/api/v1/admin/reviews?state=` | admin | Review queue |
| POST | `/api/v1/admin/reviews/{id}/{version}` | admin | Approve or reject |
