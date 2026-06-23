export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(verbose = false): Logger {
  return {
    debug: (...args) => {
      if (verbose) console.error("[DEBUG]", ...args);
    },
    info: (...args) => console.error("[INFO]", ...args),
    warn: (...args) => console.error("[WARN]", ...args),
    error: (...args) => console.error("[ERROR]", ...args),
  };
}
