// ─── Boot Sequence ──────────────────────────────────────────

import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";

await bootstrapEnv();

await import("./bin/workspace-service.js");
