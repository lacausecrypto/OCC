# Contributing to OCC

Thank you for your interest in contributing to OCC (Orchestrator Chain Chimera).

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/OCC.git`
3. Install dependencies: `cd mcp-server && npm install`
4. Run tests: `npm test`
5. Start dev server: `npm run rest`

## Development

### Project Structure

```
mcp-server/src/
  index.ts          # MCP server entry point
  rest.ts           # REST API + SSE server
  executor.ts       # Chain execution engine
  claude-runner.ts  # Claude CLI subprocess management
  pretool-executor.ts # Pre-tool execution (27 types)
  pretool-extras.ts # Advanced pre-tools (vectors, embeddings, etc.)
  gate-manager.ts   # Human-in-the-loop gate system
  loader.ts         # YAML chain loader + Zod validation
  pipeline-loader.ts # Pipeline YAML loader
  pipeline-executor.ts # Pipeline execution
  storage.ts        # SQLite persistence
  queue.ts          # Job queue with priority
  scheduler.ts      # Cron scheduling
  linter.ts         # Chain validation + security warnings
  utils.ts          # Variable resolution, condition evaluation
  mcp-client.ts     # External MCP server consumption
  types.ts          # TypeScript interfaces + Zod schemas
```

### Running Tests

```bash
# Backend (2344 tests, 59 files)
cd mcp-server
npm test              # Run all backend tests
npm test -- --watch   # Watch mode
npm test -- loader    # Run specific test file

# Frontend (899 tests, 52 files)
cd frontend-react
npm test              # Run all frontend tests
```

### Building

```bash
npm run build  # TypeScript compilation
```

## Pull Request Process

1. **Open an issue first** to discuss the change
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Write tests for new functionality
4. Ensure `npm test` passes
5. Ensure `npx tsc --noEmit` passes (type check)
6. Submit a PR with a clear description

### Code Style

- TypeScript strict mode
- Zod validation at API/YAML boundaries
- `execFileSync` instead of `execSync` for subprocess calls
- Parameterized SQL queries (never interpolate user input)
- `sanitizeName()` for all filesystem-facing name parameters

### Chain YAML Contributions

When contributing new chain YAML files:

- Run `occ validate ./chains` to lint your chains
- Review the linter output — warnings about `bash`/`db_query` are expected but should be justified
- Include a description and realistic input examples
- Test with `occ dry-run your-chain -i key=value`

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting. Do NOT open public issues for security vulnerabilities.

## License

MIT — see [LICENSE](LICENSE)
