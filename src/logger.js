const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level = "info") {
  const threshold = levels[level] ?? levels.info;

  function log(name, args) {
    if ((levels[name] ?? 100) < threshold) {
      return;
    }

    const prefix = `[${new Date().toISOString()}] [${name.toUpperCase()}]`;
    console[name === "debug" ? "log" : name](prefix, ...args);
  }

  return {
    debug: (...args) => log("debug", args),
    info: (...args) => log("info", args),
    warn: (...args) => log("warn", args),
    error: (...args) => log("error", args),
  };
}
