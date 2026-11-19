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
.venv/bin/uvicorn app.main:app --reload --port 8100
```

Defaults are the development profile: SQLite at `./.hub-api.db`, packages in
`./.hub-storage`, downloads served by the API itself. Open
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
| `HUB_SESSION_SECRET` | dev value | HMAC key for session tokens; set this in production |
| `HUB_SESSION_TTL_SECONDS` | `604800` | Login lifetime |
| `HUB_MAX_PACKAGE_BYTES` | `52428800` | Upload cap (50 MiB) |
| `HUB_MAX_UNCOMPRESSED_BYTES` | `536870912` | Zip-bomb ceiling |
| `HUB_ALLOW_REGISTRATION` | `false` | Whether anyone may create an account |
| `HUB_ADMIN_USERNAME` / `HUB_ADMIN_PASSWORD` | — | Optional administrator created at startup |
| `VITE_HUB_API_BASE` | — | Build-time, site only: API prefix (e.g. `/api/v1`) so downloads resolve through the service |

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

The host clock must be within fifteen minutes of real time: SigV4 rejects a
signature dated further ahead (`RequestTimeTooSkewed`). Run NTP on the server.
The smoke script measures and compensates for a drifting development host; the
service itself does not, on purpose.

`Dockerfile` builds the service; `docker-compose.yml` runs it beside MySQL.
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
| GET | `/api/v1/admin/reviews?state=` | admin | Review queue |
| POST | `/api/v1/admin/reviews/{id}/{version}` | admin | Approve or reject |
