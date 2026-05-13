# ============================================================
# Workspace Service — Dockerfile (multi-stage)
# ============================================================
# Remote development sidecar — connects to a remote
# tools-service backend via WebSocket, forwarding file,
# shell, and git operations from the host workspace.
# ============================================================

# ── Stage 1: Install dependencies ─────────────────────────────
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./

RUN mkdir -p -m 0700 ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts
RUN --mount=type=ssh npm ci --omit=dev

# ── Stage 2: Runtime ──────────────────────────────────────────
FROM node:22-slim

# Git is needed for agentic git operations on the workspace
# Bubblewrap provides kernel-level filesystem isolation (mount namespaces)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git wget bubblewrap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-built node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Non-root user for security
RUN groupadd --system --gid 1001 workspace && \
    useradd --system --uid 1001 --gid workspace workspace && \
    mkdir -p /workspace && \
    chown -R workspace:workspace /app /workspace
USER workspace

EXPOSE 5605

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 -O /dev/null http://127.0.0.1:5605/health || exit 1

CMD ["node", "bin/workspace-service.js"]
