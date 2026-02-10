function formatMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(meta)}`;
}

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}${formatMeta(meta)}`;
  // eslint-disable-next-line no-console
  console.log(line);
}

const logger = {
  info(message, meta) {
    log("INFO", message, meta);
  },
  warn(message, meta) {
    log("WARN", message, meta);
  },
  error(message, meta) {
    log("ERROR", message, meta);
  },
  debug(message, meta) {
    log("DEBUG", message, meta);
  },
};

module.exports = {
  logger,
};
