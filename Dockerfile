FROM node:20-slim AS frontend-build

WORKDIR /app/frontend-react
COPY frontend-react/package*.json ./
RUN npm ci
COPY frontend-react/ ./
RUN npm run build

FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY mcp-server/package*.json ./mcp-server/
RUN cd mcp-server && npm ci

# Copy source and build
COPY mcp-server/src ./mcp-server/src
COPY mcp-server/tsconfig.json ./mcp-server/
RUN cd mcp-server && npx tsc

# Remove dev dependencies after build
RUN cd mcp-server && npm prune --production

COPY chains ./chains
COPY pipelines ./pipelines

# Copy built frontend into static serving directory
COPY --from=frontend-build /app/frontend-react/dist ./frontend-react/dist

# Run as non-root user for security
RUN groupadd -r occ && useradd -r -g occ -d /app occ && chown -R occ:occ /app
USER occ

ENV CHAINS_DIR=/app/chains
ENV PIPELINES_DIR=/app/pipelines
ENV REST_PORT=4242
ENV REST_HOST=0.0.0.0

EXPOSE 4242

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4242/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "mcp-server/dist/rest.js"]
