// ─── Boot Sequence ──────────────────────────────────────────

import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";

await bootstrapEnvironment();

await import("./bin/workspace-service.ts");
