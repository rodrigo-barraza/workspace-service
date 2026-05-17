# ============================================================
# Workspace Service — Dockerfile (multi-stage)
# ============================================================
# Self-contained development environment — connects to a
# remote tools-service backend via WebSocket, forwarding
# file, shell, and git operations from the host workspace.
#
# The container IS the isolation boundary (like WSL).
# Users have full root access inside and can install
# packages, modify system files, etc. — but nothing
# escapes the container.
# ============================================================

# ── Stage 1: Install dependencies ─────────────────────────────
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./

RUN npm ci


# ── Stage 2: Build TypeScript ─────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build
# Prune devDependencies for the runtime image
RUN npm prune --omit=dev

# ── Stage 3: Runtime ──────────────────────────────────────────
FROM node:22-slim

# Rich base environment — users can install more via apt
RUN apt-get update && apt-get install -y --no-install-recommends \
    git wget curl \
    python3 python3-pip python3-venv \
    build-essential \
    jq tree htop nano vim-tiny \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-built node_modules from deps stage
COPY --from=build /app/node_modules ./node_modules

# Copy compiled application
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Create workspace directory
RUN mkdir -p /workspace

# NOTE: Intentionally running as root.
# The container IS the security boundary (like WSL).
# Users have full root access inside their environment
# but cannot escape the container.

EXPOSE 5605

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:5605/health || exit 1

CMD ["node", "dist/boot.js"]
