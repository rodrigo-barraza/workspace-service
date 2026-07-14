import { createLogger } from "@rodrigo-barraza/utilities-library/node";

const base = createLogger("workspace");

// Extend with workspace-specific `rpc` method for LSP-like logging
const logger = {
  ...base,
  rpc: (direction: string, method: string, id: string | number | undefined) =>
    base.info(
      `${direction === "in" ? "←" : "→"} ${method} (${id === undefined || id === null ? "?" : String(id).slice(0, 8)})`,
    ),
};

export default logger;
