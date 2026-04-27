# Changelog

## [2.1.0] - 2026-04-27

### Added
- **Canvas item: Obsidian Note** — new kind with vault name, `.md` file picker, markdown preview rendering (purple Obsidian accent, headings/lists/wikilinks).
- **Canvas item: Connected context propagation** — Terminal Agent now reads its directly-connected canvas items (portal URL, file content, Obsidian markdown, sticky text, link, sibling agents…) and injects them as authoritative working context in the system prompt before each LLM call. New `utils/canvasContext.ts` module: `getConnectedCanvasNodes`, `formatNodeForLLM`, `buildConnectedContext`.
- **Canvas item: File Viewer file picker** — pick a local file via `<input type="file">` and store its contents directly on the node (FileReader-based, no backend roundtrip). Same picker reused by the Obsidian Note section.
- **Canvas item: Terminal Agent model selector** — `<select>` populated from `/providers/models` and filtered by the chosen provider, with a "(custom)" fallback option preserving any unlisted model already on the node. Free-text `<input>` kept for providers we can't enumerate (OpenRouter/OpenAI without API key).
- **Workflow Chat: explicit chain inputs in the canvas context** — the planner system prompt now lists detected `{input.X}` fields with their inferred type and tells the LLM to fill them via a JSON block on `[ACTION:RUN]`. The action handler validates against the chain schema and surfaces a clear "missing required input" / "needs file/image upload" message instead of silently posting `{}`.
- **Workflow Chat: planner MODIFY mode invariants** — explicit MODIFY example showing `preTools`, `advanced` (cache/retry/routes/criteria/items_var/browser_url/webhook_url…), `depends_on` rewire. Patch schema widened in both stages to accept those fields. `applyPlanToCanvas` pre-populates the label→id map with existing canvas nodes so `addSteps` wires into the existing chain instead of floating off as a disconnected subgraph.
- **Workflow Chat: floor-aware canvas context** — `buildCanvasContext` now reports the active floor and warns when other floors hold steps but the current one is empty (avoids the "y'a encore des chaînes ?" ghost-empty bug).
- 35 new tests covering `canvasContext`, `preToolsToData`, `detectInputs` (incl. type-inference matrix), tools/pre-tools serialization edge cases, and `pretoolFields` schema integrity.

### Changed
- **Canvas overlays scale uniformly with zoom** — Portal `<iframe>` and Terminal Agent overlay now render at the node's NATIVE pixel size and apply a single `transform: scale(camera.zoom)` at the wrapper, instead of multiplying every internal dimension by `camera.zoom`. Sites with responsive layouts (e.g. GitHub) no longer reflow into a mobile view at low zoom.
- **`detectInputs` (`canvasToYaml`)** — now returns `{ name, type, description }` (was just `string[]`). Heuristic type inference from field name (image/file/url/code/json/number/boolean/string/text). Bare `{input}` (no dot suffix) is surfaced as a synthetic `"input"` field of type `text` so the RUN modal renders a textarea instead of "0 required inputs". Emitted YAML now carries `description` and `type` for non-string fields.
- **Backend: `index.html` is served with `Cache-Control: no-store, must-revalidate` + `Pragma: no-cache` + `Expires: 0`**, both via `express.static` `setHeaders` and the SPA-fallback path. Stops the "'text/html' is not a valid JavaScript MIME type" recurrence after every frontend rebuild (the browser used to keep a stale `index.html` referencing removed asset hashes).
- **Font tokens: `--m-font-mono` and `--m-font` extended with symbol/emoji fallbacks** (`Apple Color Emoji`, `Segoe UI Symbol`, `Apple Symbols`, `Symbola`, `Noto Color Emoji`). Replaces every inline `fontFamily: "monospace"` with `var(--m-font-mono)` across `WorkflowChat`, `StepEditModal`, `RunModal`, `HuggingFaceSection`, and the `var(--m-mono)` references in `CanvasEditor.module.css` (the `--m-mono` variable was never defined). Em dashes / pause / lightning / refresh glyphs no longer render as missing-glyph "tofu" boxes.
- **Frontend dependencies bumped** to current `wanted` ranges (vite 8.0.5→8.0.10, react 19.2.4→19.2.5, vitest 4.1.2→4.1.5, tanstack/react-query, storybook, eslint-plugin-react-hooks, etc.). Major version bumps held for separate review (eslint 9→10, typescript 5→6, @types/node 24→25).
- **mcp-server dependencies bumped** (`@modelcontextprotocol/sdk` 1.27→1.29, `better-sqlite3` 12.8→12.9, `eslint` 10.2.0→10.2.1, vitest, etc.).

### Fixed
- **Workflow Chat planner no longer creates a disconnected parallel chain when asked to improve an existing one** — `applyPlanToCanvas` was building its `labelToId` map only from new steps, so any `addSteps` entry whose `depends_on` referenced an existing step had its edge silently dropped. Existing nodes are now pre-registered, and a sequential fallback attaches the first new step to the existing leaf when `depends_on` is omitted.
- **`preToolsToData` is now exported** from `StepEditModal` so the round-trip is testable in isolation.
- **Workflow Chat MODIFY action and plan-stage modifications** were ignoring `preTools`, `advanced`, `outputVar`, and `depends_on` patches. All four are now applied; `depends_on` rewires incoming edges atomically.
- Sticky / em-dash / arrow / pause / lightning glyphs in dark-mode chat textareas (see Changed section for the fix).

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
