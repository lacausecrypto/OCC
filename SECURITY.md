# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting Vulnerabilities

Email **security@lacausecrypto.com** with:
- Description and reproduction steps
- Impact assessment
- Suggested fix (if any)

Response targets: acknowledgment within 48 hours, fix within 7 days for critical issues.

## Authentication

- **API key authentication** via `Authorization: Bearer <key>` header.
- In production (`NODE_ENV=production`), the server **refuses to start** without `OCC_API_KEY`.
- In development (no `NODE_ENV`), auth is optional (warning logged if unset).
- Query parameter auth (`?api_key=`) has been **removed** — keys leak in server logs, browser history, and proxy caches.
- API key comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

## Encryption

- LLM provider API keys are encrypted at rest with **AES-256-GCM** (scrypt key derivation).
- In production, `OCC_ENCRYPTION_KEY` is **required** (server exits without it).
- In development without a key, an ephemeral per-process key is generated — stored keys won't survive restarts.
- No hardcoded default encryption key exists in the codebase.

## Network Security

| Setting | Default | Notes |
|---------|---------|-------|
| `REST_HOST` | `127.0.0.1` | Localhost only. Set `0.0.0.0` only behind a reverse proxy. |
| `CORS_ORIGIN` | localhost devs | Set to exact domain in production. Never `*` with auth. |
| TLS | None | Use nginx/Caddy as reverse proxy for HTTPS. |

If the server detects `REST_HOST=0.0.0.0` without `OCC_API_KEY`, it prints a **prominent warning banner** to stderr.

## Rate Limiting

| Endpoint | Default Limit | Notes |
|----------|---------------|-------|
| `POST /execute/*` | 20/min | Configurable via `RATE_LIMIT_EXEC` |
| `POST /generate-chain` | 5/min | Configurable via `RATE_LIMIT_GEN` |
| `GET/PUT /config` | 30/min | Prevents config hammering |
| `*/providers/*` | 30/min | Provider management |

Rate limiting keys use the API key (first 8 chars) when present, falling back to IP address.

## Pre-Tool Security

Some pre-tools have elevated risk. Review chain YAML carefully before running untrusted chains.

| Pre-tool | Risk | Mitigation |
|----------|------|------------|
| `bash` | Executes shell commands | Variable values are sanitized (metacharacters escaped). Command strings are NOT sanitized — they must come from trusted YAML. |
| `db_query` | SQL execution | SQLite uses `better-sqlite3` with **parameterized queries** and `readonly: true`. Only `SELECT`/`WITH` queries allowed. Destructive keywords blocked. |
| `write_file` | File system writes | Path validated before `mkdir` (TOCTOU-safe). Symlinks resolved. Restricted to `WORKSPACE_DIR` and `/tmp`. |
| `read_file` | File system reads | Same path validation as `write_file`. Symlink resolution prevents traversal. |
| `sandbox_exec` | Docker execution | Runs in isolated container. Mount is optional. |
| `http_fetch` | SSRF risk | DNS resolution with timeout, private IP blocking (RFC1918, link-local, loopback, IPv6 ULA). |
| `env_var` | Environment access | **Allowlist enforced.** Blocked patterns: `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `AWS_*`, `GITHUB_*`, `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`. |
| `email` | Sends emails | Recipient address validated (RFC format). Provider API keys from env vars only. |

## Path Traversal Protection

- `sanitizeName()` rejects names with `..`, `/`, `\`, null bytes, and non-alphanumeric characters.
- `read_file` / `write_file` resolve symlinks via `fs.realpathSync()` and verify the resolved path is within `WORKSPACE_DIR` or `/tmp`.
- `write_file` validates the path **before** creating parent directories (prevents TOCTOU race).

## Input Validation

- All chain definitions validated with **Zod schemas** at load time.
- REST request bodies validated before processing.
- All child processes use `execFileSync` (array args), never `exec` with string concatenation.
- No `eval()`, `new Function()`, or dynamic code execution anywhere in the codebase.

## Error Handling

- Error messages sent to clients are **sanitized**: internal file paths and stack traces are stripped.
- Full error details are logged server-side only.
- The global error handler returns generic `"Internal server error"` for unhandled exceptions.

## Security Headers

All responses include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `X-Powered-By` header removed

The React frontend includes a strict Content Security Policy:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' https: data:; object-src 'none'; frame-ancestors 'none'
```

## Claude CLI Security

- `CLAUDE_CLI` / `CLAUDE_BIN` environment variables are validated: only `"claude"` (default) or **absolute paths** are accepted.
- Relative paths, paths containing `..`, and paths with shell metacharacters are rejected (falls back to `"claude"`).

## Docker Hardening

- Non-root user (`occ:occ`)
- `security_opt: no-new-privileges:true`
- `cap_drop: ALL`
- `read_only: true` filesystem
- `tmpfs: /tmp:size=100M`
- Health check via `/health` endpoint
- `.dockerignore` excludes `.env`, `.git`, `*.db`, `node_modules`

## Production Hardening Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `OCC_API_KEY` (server exits without it)
- [ ] Set `OCC_ENCRYPTION_KEY` (unique per installation)
- [ ] Set `REST_HOST=0.0.0.0` only behind reverse proxy with TLS
- [ ] Set `CORS_ORIGIN` to your exact domain
- [ ] Set `LOG_LEVEL=info` (not `debug`)
- [ ] Review all chain YAML files for `bash` and `db_query` pre-tools
- [ ] Run `npm audit` and check for vulnerabilities
- [ ] Set up firewall to block direct access to port 4242
- [ ] Configure reverse proxy (nginx/Caddy) with TLS certificates
- [ ] Set `EXECUTION_MAX_AGE_DAYS` to auto-purge old data

## Known Limitations

- **Single API key** — no per-user or per-role access control.
- **No audit log** — API actions are logged but not in a structured audit trail.
- **Bash pre-tool** — chains with `bash` can execute arbitrary commands. Power feature, requires trust in chain authors.
- **BLOB sessions** — autonomous mode can trigger executions without user approval. Configure budget limits.
- **No request signing** — API key is the only auth mechanism. Consider mTLS at proxy level for high-security environments.
