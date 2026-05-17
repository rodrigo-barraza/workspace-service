import { createLogger } from "@rodrigo-barraza/utilities-library/node";

const base = createLogger("workspace");

// Extend with workspace-specific `rpc` method for LSP-like logging
const logger = {
  ...base,
  rpc: (direction, method, id) =>
    base.info(
      `${direction === "in" ? "←" : "→"} ${method} (${id?.slice(0, 8) || "?"})`,
    ),
};

export default logger;
