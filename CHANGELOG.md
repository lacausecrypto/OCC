# Changelog

## [0.5.0] - 2026-04-28

Release notes follow the npm package version (`occ-orchestrator`).
33 commits since `v0.4.0`. Roll-up of every change since the last
release; per-feature detail lives in the section below + the older
2.x notes that document the earlier platform additions still kept on
disk for reference.

### Headline features

- **Interactive canvas overhaul** — Obsidian Note kind, Terminal Agent
  with model selector + connected-context propagation (Portal URL,
  File content, Sticky text, Obsidian markdown all flow into the
  agent's system prompt), Portal/Terminal overlays render at native
  size with a single `transform: scale(zoom)` so SPAs stop reflowing
  at low zoom, File Viewer file picker, right-click no longer arms a
  phantom box-select / node-drag, custom-fontFamily CSS tokens with
  emoji/symbol fallbacks (no more "tofu" boxes for ⏸ ⚡ ↺ ▶).
- **Server platform** — `codex` CLI runner (mirrors `claude-runner`,
  no API key needed), customizable system prompts (`/system-prompts`
  GET/PUT/reset, hot-reloaded JSON), generic `/agent-chat` endpoint
  that routes through any configured provider, execution time-travel
  via `GET /executions/:id/timeline` (per-step checkpoint history).
- **Pipelines from canvas** — `canvasToPipelineChains` decomposes a
  multi-stage canvas into `PipelineChainRef[]`; `SaveChainModal`
  detects pipeline canvases via `isPipelineCanvas` and routes through
  `savePipeline`. New `summarize_output` field on `PipelineChainRef`
  to control how a stage's output flows downstream.
- **Canvas-only chains** — chains with zero steps and one or more
  non-step canvas items (Portal / Sticky / Terminal / File / Link /
  Free Text / Obsidian) save and reload exactly via the new
  `canvas_items?: CanvasItemSerialized[]` side-car. Loader's Zod
  schema accepts empty `steps`; executor refuses to run them with a
  clear "open in canvas editor" error.
- **Floor color slot palette** — replaces hardcoded `color: "#hex"`
  on `FloorData` with a `colorSlot: 0..6` index into a design-space-
  derived palette resolved at render time, so floor colors stay in
  sync with the active theme. Persistence layer auto-migrates legacy
  hex records via `inferSlotFromHex`.
- **Settings UI refactor** — collapsible sections (state persisted in
  localStorage), system prompts editor (`SystemPromptsSection`),
  provider section gains the codex provider type, MCP/schedule
  sections light tweaks.
- **Workflow chat planner — concrete bug fixes**: planner respects
  existing canvas (no more disconnected parallel chains on
  "améliore"), MODIFY mode patches `preTools` / `advanced` /
  `outputVar` / `depends_on` rewires atomically, named-input
  detection drives the RUN modal and the `[ACTION:RUN]` JSON inputs
  block, floor-aware canvas context.
- **Test coverage push +1075→1233 (frontend 27.6% → 49.4%
  statements)** across 12 new test files: canvasContext,
  preToolsToData, detectInputs type-inference matrix, tools/pre-tools
  serialization, pretoolFields schema integrity, canvasRenderer
  helpers + main render, connectionHit (100%), useCanvasInteractions
  (regression for the right-click bug + drag/keyboard branches —
  86%), workflowChat applyPlanToCanvas + buildCanvasContext,
  workflowChat sessions / persistence (90%+), floors store,
  physarumSim (72%), blobRenderer (75%), workflowChat actions
  (`[ACTION:ANALYZE/MODIFY/RUN]`).
- **Misc dev quality** — frontend deps bumped to current `wanted`
  range (vite, react, vitest, storybook, react-query…), mcp-server
  deps bumped (`@modelcontextprotocol/sdk` 1.27→1.29, better-sqlite3,
  eslint…), `index.html` served `Cache-Control: no-store` so the
  browser stops holding stale asset hashes after every rebuild,
  `.gitignore` excludes `system-prompts.json` runtime artifact.

### Removed

- **Interactive Portal mode (Playwright + WebSocket screencast)** —
  added in 2.2.0 / commit `96675f2`, removed before npm release.
  See the explanatory section in the older 2.x notes below for the
  full rationale (anti-bot detection at the binary level kept finding
  new signals; macOS Dock-icon UX was hard to make invisible). Portal
  nodes keep only the static iframe proxy via `GET /portal?url=…`.
  Surface dropped: `mcp-server/src/portal-sessions.ts`,
  `mcp-server/src/portal-ws.ts`, `frontend-react/src/api/portal.ts`,
  `InteractivePortalOverlayItem`, the async live-snapshot path in
  `canvasContext.ts`, REST endpoints (`POST /portal/session`,
  `GET /portal/sessions`, `POST /portal/session/:id/navigate`,
  `DELETE /portal/session/:id`, `GET /portal/snapshot`), deps `ws`
  + `@types/ws`, types `portalMode` / `portalPersistKey`, vite proxy
  `ws: true` on `/portal`. **Net diff: −1473 / +35 lines.**

### Notes

- Versioning: this is the first OCC release that's published from a
  CI-validated `main`. Every commit since `v0.4.0` was tested on the
  full matrix (ubuntu/macos/windows × Node 20/22).
- Historical 2.x section below is preserved as a reference for the
  earlier platform additions; future releases will use 0.x semver
  matching the npm package version.

## [Unreleased — pre-release notes for v0.5.0, kept for historical reference]

### Removed — Interactive Portal mode (Playwright screencast)

The interactive Portal mode (Playwright session streamed over WebSocket
with per-node persistent profiles, browser selector, headed-off-screen
launching, etc. — added in 2.2.0 and extended through "Portal v2") has been
**removed**. After extensive testing on real-world login flows (X.com,
Cloudflare-protected sites), the value/complexity ratio didn't justify
keeping it: anti-bot detection at the binary level kept finding new
signals to flag (window fingerprint, audio, WebGL, mouse cadence, …) and
the macOS UX of an always-visible Dock icon for each active node was
hard to make invisible without invasive workarounds.

Portal nodes now keep only the **static** mode: server-side fetch via
`GET /portal?url=…`, X-Frame-Options stripped, rendered in a sandboxed
iframe. No cookies, no JS cross-origin, no login — but rock-solid for
read-only embeds (docs, blog posts, dashboards that don't need auth).
For sites that need a real session, the "Open in browser" fallback
remains.

**Surface dropped**:

- Backend modules: `portal-sessions.ts`, `portal-ws.ts`, `browser-detect.ts`.
- REST endpoints: `POST /portal/session`, `GET /portal/sessions`,
  `POST /portal/session/:id/navigate`, `DELETE /portal/session/:id`,
  `GET /portal/snapshot`, `GET /portal/browsers`, `GET /portal/profiles`,
  `DELETE /portal/profile/:persistKey`.
- Backend tests: `portal-sessions.test.ts`, `browser-detect.test.ts`.
- Backend deps: `ws`, `@types/ws`.
- Frontend: `api/portal.ts`, `BrowserSelector` + `BrowserInstallWarning`
  helpers in the modal, `Settings/PortalProfilesSection.tsx`, the
  interactive overlay (`CanvasOverlays.InteractivePortalOverlayItem`),
  the async live-snapshot path in `canvasContext.ts`, the per-node
  toolbar pills (`CHROME 147`, `HEADED`, etc.), the per-node "Reset
  login" button.
- Canvas types: `portalMode`, `portalPersistKey`, `portalBrowserId`.
- Vite proxy: `ws: true` on `/portal`.
- Disk: `~/.occ-portals/` and `mcp-server/portal-sessions/` directories
  wiped on cleanup.

**Kept**:

- `GET /portal?url=…` static iframe proxy.
- Canvas `portal` node kind with `portalUrl / Title / Description /
  Favicon / Status / Screenshot` fields.
- `StaticPortalOverlayItem` rendering (now the only path).
- `canvas_items:` YAML round-trip for portal nodes (no longer carries
  the dropped fields).

## [2.2.0] - 2026-04-27

### Added
- **Interactive Portal canvas item (Playwright + WebSocket screencast)** — companion to the existing static `/portal?url=…` proxy. Lazy-launches a shared Chromium and creates one `BrowserContext` per session (cookie jar + storageState persisted per `persistKey` so logins survive). Two WebSocket channels per session: `/portal/:id/screencast` streams JPEG frames + url notifications, `/portal/:id/input` accepts mouse / keyboard / wheel events normalized to 0..1 viewport coords. New REST endpoints: `POST /portal/session`, `GET /portal/sessions`, `POST /portal/session/:id/navigate`, `DELETE /portal/session/:id`. Frontend `CanvasOverlays` now picks between `StaticPortalOverlayItem` (iframe) and `InteractivePortalOverlayItem` based on `node.portalMode`.
- **Portal live DOM snapshot for Terminal Agents** — when a Terminal Agent is connected to an interactive Portal, every outgoing message now inlines the live page content (`document.body.innerText`, capped at 8000 chars) into the agent's context. New `GET /portal/snapshot?persistKey=…|sessionId=…` endpoint, `getPortalSnapshot` server function (resolves either id or persistKey via `findPortalSession`), `getPortalSnapshot` API client, and an async render path in `utils/canvasContext.ts` (`formatNodeForLLMAsync`, `buildConnectedContextAsync`). Sync versions preserved for callers that can't await — existing 25 canvasContext tests still pass.
- **Chrome stealth profile for the interactive Portal** — Playwright contexts now launch with anti-detection flags (drop `--enable-automation`, add `--disable-blink-features=AutomationControlled`, `IsolateOrigins`, `site-per-process`, `no-default-browser-check`, etc.) and an init script that patches the four classic bot-detection signals (`navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `window.chrome.runtime`, `permissions.query("notifications")`). Realistic Chrome 123 / macOS user agent + `sec-ch-ua` headers + en-US locale + America/Los_Angeles timezone (overridable via `PORTAL_LOCALE` / `PORTAL_TIMEZONE`). Lets X.com / Cloudflare-protected logins go through.
- **Codex CLI runner** (`mcp-server/src/codex-runner.ts`) — mirrors `claude-runner.ts`. Spawns `codex exec --json -m <model> -- <prompt>`, streams JSON-line events, captures token usage. Plumbed into `providers.ts` as a new `"codex"` provider type — auth handled by the CLI itself (`codex login` / OAuth) so OCC stores no API key.
- **Customizable system prompts** (`mcp-server/src/system-prompts.ts`) — JSON-backed prompts file with hot-reload. Six contexts: `blobChat`, `blobOrchestrator`, `agentChat`, `workflowChatChat`, `workflowChatPlanner`, `terminalAgent`. New REST endpoints: `GET /system-prompts`, `PUT /system-prompts`, `POST /system-prompts/reset`. Frontend `Settings/SystemPromptsSection.tsx` lets the user edit each prompt with live diff against built-in defaults and a per-prompt reset button.
- **Generic `/agent-chat` endpoint** — multi-provider chat without the BLOB persona / knowledge graph. The canvas Terminal Agent now uses this endpoint so each terminal can pick its own provider+model independent of the BLOB chat stack.
- **Execution time-travel** — `GET /executions/:id/timeline` returns per-step checkpoint history (status, durations, token counts). Frontend `ExecResultModal` gains a Replay tab driven by `fetchExecutionTimeline`.
- **Pipelines from a single canvas** — `canvasToPipelineChains` decomposes a multi-stage canvas (pipeline-stage subchain references) into `PipelineChainRef[]`; `SaveChainModal` detects pipeline canvases via `isPipelineCanvas` and routes the save through `savePipeline` + `buildPipelineDefinition`. New `summarize_output` field on `PipelineChainRef` (true / N / undefined) controls how a stage's output flows downstream.
- **Floor color slot palette** — replaces the hardcoded `color: "#hex"` field on `FloorData` with a `colorSlot: 0..6` index into a design-space-derived palette (`utils/floorColors.ts`). Slot resolves to a real hex via `getComputedStyle` at render time, so floor colors stay in sync with the active theme / accent / dark mode. Persistence layer auto-migrates legacy hex records via `inferSlotFromHex`.
- **Collapsible Settings sections** (`Collapsible.tsx` + `collapse-state.ts`) — animated foldable wrapper with state persisted in localStorage so panels stay collapsed across reloads.
- **Per-chain context budget** (`max_context_chars`) — older variables auto-summarized via Haiku above the threshold. Falls back to a global default.
- **Browser step advanced fields** — `browser_port`, `browser_page_name`, `browser_scroll_strategy`, `browser_cookies_domain` on `StepAdvancedConfig` (companion to the Playwright-based browser step).
- **`image_gen` step type + `image_generate` pre-tool** — provider/model/size/format/quality/style/negative_prompt fields in `pretoolFields.ts`, OpenAI / HuggingFace / Stability dispatch routes. New step type icon (picture frame with mountain + sun) in `nodeIcons.ts`.
- **Canvas-only chains** — chains with zero steps and one or more non-step canvas items (Portal / Sticky / Terminal / File Viewer / Link Bookmark / Free Text / Obsidian) save and reload exactly. New `canvas_items?: CanvasItemSerialized[]` side-car on `ChainDefinition`. The loader's Zod schema accepts empty `steps`, the executor refuses to run them with a clear "open in canvas editor" error.

### Changed
- **`canvasToYaml` emits `steps: []` placeholder** that's promoted to a real sequence header only when at least one step block is emitted (empty `steps:` parses as null and broke the loader). `output:` is now only emitted when there are steps. Non-step nodes flow into the new `canvas_items:` block.
- **`stores/canvas.ts loadChainToCanvas`** restores `canvas_items` BEFORE steps so reloaded portals/stickies/etc. don't end up under a re-laid-out step grid.
- **`mcp-server/src/loader.ts ChainSchema`** — `steps` and `output` are now optional with defaults; new `CanvasItemSchema` is `passthrough` to tolerate forward-compatible extras.
- **`Settings.tsx` SOURCES** — `agentChat` added to the TokenDashboard chart sources.
- **`TerminalOverlay.tsx`** — calls `/agent-chat` instead of `/blobs/:id/chat` so each terminal is provider-pickable, independent of the BLOB chat stack.
- **+50 tests in Phase 2** (1233 total): `physarumSim` (16), `blobRenderer` (15), `workflowChat-actions` (19) covering `[ACTION:ANALYZE/MODIFY/RUN]`. Frontend coverage bumped from 43.9% → 49.4% statements.
- **+108 tests in Phase 1** (1183 total): `floors` (29), `workflowChat-sessions` (29), `useCanvasInteractions-extra` (29), `canvasRenderer-render` (21). Frontend coverage went from 34.7% → 43.9% statements.
- **+82 tests in Phase 1 quick-wins** (1075 total): `canvasContext` (25), `connectionHit` (15), `useCanvasInteractions` (18), `workflowChat-applyPlan` (17), `Settings.test.tsx` mock fix.

### Fixed
- **Interactive Portal: session no longer torn down on every redirect inside a multi-step auth funnel** (X.com login etc.). The lifecycle effect now binds to the URL captured once via `useRef` on mount instead of the live `node.portalUrl`. The address bar still triggers `navigatePortalSession` on the existing session without a remount; a fresh URL only requires opening a new node.
- **`SaveChainModal` versionMessage was dropped** by a stale-closure bug in `doSave` — the typed-in note now reaches `saveChain`/`savePipeline` correctly.
- **`executeChain` no longer crashes on zero-step chains** — early-rejected with a clear error pointing back to the canvas editor.

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
