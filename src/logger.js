// ─── Colorized Console Logger ───────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

const logger = {
  info: (...args) =>
    console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}ℹ${COLORS.reset}`, ...args),
  success: (...args) =>
    console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}✓${COLORS.reset}`, ...args),
  warn: (...args) =>
    console.warn(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}⚠${COLORS.reset}`, ...args),
  error: (...args) =>
    console.error(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red}✖${COLORS.reset}`, ...args),
  debug: (...args) =>
    process.env.DEBUG && console.log(`${COLORS.dim}${timestamp()} 🔍${COLORS.reset}`, ...args),
  rpc: (direction, method, id) =>
    console.log(
      `${COLORS.dim}${timestamp()}${COLORS.reset} ${direction === "in" ? `${COLORS.magenta}←` : `${COLORS.blue}→`}${COLORS.reset} ${method} ${COLORS.dim}(${id?.slice(0, 8) || "?"})${COLORS.reset}`,
    ),
};

export default logger;
