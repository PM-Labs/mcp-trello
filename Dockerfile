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
