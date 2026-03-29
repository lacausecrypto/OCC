FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY mcp-server/package*.json ./mcp-server/
RUN cd mcp-server && npm ci --production

# Copy built source and chain definitions
COPY mcp-server/src ./mcp-server/src
COPY mcp-server/tsconfig.json ./mcp-server/
RUN cd mcp-server && npx tsc

COPY chains ./chains
COPY pipelines ./pipelines

ENV CHAINS_DIR=/app/chains
ENV PIPELINES_DIR=/app/pipelines
ENV REST_PORT=4242
ENV REST_HOST=0.0.0.0

EXPOSE 4242

CMD ["node", "mcp-server/dist/rest.js"]
