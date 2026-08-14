# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript with devDependencies available ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: only compiled dist/ + production node_modules ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Named volume mount point for the SQLite state file (design doc section 1) -
# not baked into the image, and not a bind mount.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
USER node

# Prometheus /metrics endpoint (design doc section 1's METRICS_PORT default).
EXPOSE 9090

# Exec form (no shell) so node is PID 1 and receives SIGTERM directly -
# required for the graceful-shutdown handling in src/index.ts to run.
CMD ["node", "dist/index.js"]
