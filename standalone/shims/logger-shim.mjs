// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Logger Shim — Injectable logger for standalone bundle
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Drop-in replacement for src/logger.ts. Provides a default
// colorized console logger that can be overridden via setLogger()
// for environments like the Electron tray app (IPC transport).
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

let activeLogger = {
  info: (message) =>
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.blue}INFO${COLORS.reset}  ${message}`,
    ),
  success: (message) =>
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}  OK${COLORS.reset}  ${message}`,
    ),
  warn: (message) =>
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}  ${message}`,
    ),
  error: (message) =>
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red} ERR${COLORS.reset}  ${message}`,
    ),
  rpc: (direction, method, id) =>
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.magenta} RPC${COLORS.reset}  ${direction === "in" ? "←" : "→"} ${method} ${COLORS.dim}(${id})${COLORS.reset}`,
    ),
  debug: () => {},
};

export function setLogger(customLogger) {
  activeLogger = { ...activeLogger, ...customLogger };
}

// The default export matches the shape of src/logger.ts
const logger = new Proxy(
  {},
  {
    get(_target, property) {
      return activeLogger[property];
    },
  },
);

export default logger;
