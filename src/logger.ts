import fs from "node:fs";
import path from "node:path";

import pino from "pino";

function redactSecret(value: string): string {
  return value
    .replace(/sk-(?:proj-)?[A-Za-z0-9_\-]{10,}/g, "***REDACTED***")
    .replace(
      /(?:(api[_-]?key|password|token|authorization|secret)\s*[:=]\s*)([^\s'"]+)/gi,
      "$1=***REDACTED***",
    );
}

// Everything is logged to a date-stamped file at debug level for later
// debugging, while the console stays at the configured level. The file is the
// full audit trail of what the bot did, step by step.
const logsDir = path.resolve("logs");
fs.mkdirSync(logsDir, { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const logFile = path.join(logsDir, `bot-${day}.log`);

const consoleLevel = process.env.LOG_LEVEL ?? "info";

const streams: pino.StreamEntry[] = [
  { level: consoleLevel as pino.Level, stream: process.stdout },
  { level: "debug", stream: pino.destination({ dest: logFile, mkdir: true, sync: false }) },
];

export const logger = pino(
  {
    level: "debug",
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg) => (typeof arg === "string" ? redactSecret(arg) : arg));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  },
  pino.multistream(streams, { dedupe: false }),
);

logger.info({ logFile }, "Logging to file");
