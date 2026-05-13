<<<<<<< HEAD
FROM oven/bun:1-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json bun.lock ./
RUN bun install --frozen
COPY . .
RUN bun run build

FROM oven/bun:1-alpine AS release
WORKDIR /app
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./
COPY --from=builder /app/server.js ./
RUN bun install --production --frozen
RUN bun add express
ENV NODE_ENV=production
CMD ["bun", "server.js"]
=======
# Use official Bun image as builder
FROM oven/bun:1-alpine AS builder
LABEL org.opencontainers.image.source=https://github.com/delorenj/mcp-server-trello

# Set the working directory to /app
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files first to leverage Docker cache
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies)
RUN bun install --frozen

# Copy the rest of the code
COPY . .

# Build TypeScript
RUN bun run build

# Use official Bun image for runtime
FROM oven/bun:1-alpine AS release

# Set the working directory to /app
WORKDIR /app

# Copy only the necessary files from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./

# Install only production dependencies without running scripts
RUN bun install --production --frozen

# The environment variables should be passed at runtime, not baked into the image
# They can be provided via docker run -e or docker compose environment section
ENV NODE_ENV=production

# Run the MCP server using Bun
CMD ["bun", "build/index.js"]
>>>>>>> upstream/main
