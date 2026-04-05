# Changelog

## [2.0.0] - 2026-04-04

### Added
- **API key authentication** via `OCC_API_KEY` env var (Bearer token + query param)
- **Rate limiting** on execution and generation endpoints (20 req/min and 5 req/min)
- **SSRF protection** on `http_fetch` pre-tool (blocks private/internal IPs)
- **Security headers** (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- **Structured logging** with `logger.ts` (JSON/text format, configurable level)
- **Linter security warnings** for dangerous pre-tools (bash, db_query, write_file, sandbox_exec)
- **Input injection detection** in linter (warns when `{input.*}` flows into shell/SQL)
- **Global error handler** prevents stack trace leaks
- **Unhandled rejection/exception handlers** for crash resilience
- **Path traversal protection** via `sanitizeName()` on all chain/pipeline CRUD
- **Symlink protection** on `/download` endpoint
- **SSRF protection** on Python frontend proxy (blocks private IPs, port-restricted localhost)
- **Docker HEALTHCHECK** instruction
- **Docker Compose** security hardening (read-only rootfs, no-new-privileges, cap_drop ALL)
- **Dependabot** configuration for weekly npm updates
- `SECURITY.md` with vulnerability reporting policy + hardening checklist
- `CONTRIBUTING.md` with setup guide + code style
- `CODE_OF_CONDUCT.md`
- GitHub issue/PR templates
- `npm audit` in CI pipeline
- `/events` global SSE endpoint for live monitoring
- **Frontend (Chimera)**: Design Space with real-time style morphing
- **Frontend**: Chain Editor with canvas, decompose Grid/Flow layouts
- **Frontend**: Live Monitor with SSE streaming
- **Frontend**: Run modal with input fields + dry-run
- **Frontend**: Execution result modal with Rendered/Raw/Steps views + MD/HTML export
- **Frontend**: Live execution overlays on canvas (glow, terminal, badges)
- 5 new chains: security-audit, seo-analyzer, startup-pitch, incident-response, data-pipeline-builder
- 2 new pipelines: full-security-review, startup-launch
- New step types used: debate, webhook, subchain, browser

### Changed
- Default `REST_HOST` changed from `0.0.0.0` to `127.0.0.1` (localhost only)
- Default `CORS_ORIGIN` changed from `*` to `http://localhost:8888`
- Claude CLI validation uses `execFileSync` instead of shell interpolation
- `runningExecutionCount` guards against negative values
- SSE client map auto-cleanup on execution complete
- Prototype pollution guard on pre-tool result merging

### Security
- Fixed path traversal on raw YAML POST /chains/:name and /pipelines/:name
- Fixed symlink traversal on /download endpoint
- Fixed SSRF bypass via 0.0.0.0 and non-4242 localhost ports
- Fixed XSS in HTML export (chainName escaped)
- Fixed command injection in Claude CLI version check
- Added global `esc()` function for HTML escaping on all server data in innerHTML
- Fixed `mdToHtml` javascript: link injection (only http/https allowed)

## [1.0.0] - 2026-03-15

### Added
- Initial release
- Chain execution engine with 11 step types
- 27 pre-tool types
- MCP integration (28 tools exposed + external server consumption)
- REST API with 40+ endpoints
- SSE streaming per execution
- CLI with 17 commands
- SQLite persistence with WAL mode
- Job queue with priority
- Cron scheduling
- Per-step checkpointing and crash recovery
- 553 tests across 18 files
