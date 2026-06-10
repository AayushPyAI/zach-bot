import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { runWorkflow, RunOptions } from "./workflow.js";

/**
 * 24/7 operation. Instead of a fixed cron time, we keep one process alive and
 * start human-like sessions at randomized intervals, with the occasional longer
 * "offline" break. Each session is a full {@link runWorkflow} (fresh browser
 * session, lurk → discover → read → maybe comment), and the workflow's own
 * gates (active hours, daily cap, gaps, random skips) keep volume safe.
 *
 * Nothing happens on a predictable cadence: every gap is randomized so the
 * activity pattern reads like a person, not a scheduler.
 */
export async function runDaemon(config: AppConfig, opts: RunOptions = {}): Promise<void> {
  let stopping = false;
  const stop = (signal: string): void => {
    logger.info({ signal }, "Shutdown signal received; will stop after the current session");
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  logger.info(
    {
      sessionGap: [config.daemon.sessionGapMinMinutes, config.daemon.sessionGapMaxMinutes],
      longBreakProbability: config.daemon.longBreakProbability,
      postingEnabled: config.posting.enabled,
    },
    "Starting 24/7 daemon",
  );

  let cycle = 0;
  while (!stopping) {
    cycle += 1;
    const startedAt = Date.now();
    logger.info({ cycle }, "Session starting");
    try {
      await runWorkflow(config, opts);
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      logger.error({ cycle, err: detail }, "Session failed; continuing daemon");
    }
    logger.info({ cycle, durationSec: Math.round((Date.now() - startedAt) / 1000) }, "Session finished");

    if (stopping) {
      break;
    }

    const waitMs = nextDelayMs(config);
    logger.info(
      { cycle, nextInMinutes: Math.round(waitMs / 60_000) },
      "Idle until next session",
    );
    await interruptibleSleep(waitMs, () => stopping);
  }

  logger.info({ cycles: cycle }, "Daemon stopped");
}

/** Randomized gap until the next session, with an occasional long break. */
function nextDelayMs(config: AppConfig): number {
  const d = config.daemon;
  if (Math.random() < d.longBreakProbability) {
    const hours = randomFloat(d.longBreakMinHours, Math.max(d.longBreakMinHours, d.longBreakMaxHours));
    return Math.round(hours * 3_600_000);
  }
  const minutes = randomInt(
    d.sessionGapMinMinutes,
    Math.max(d.sessionGapMinMinutes, d.sessionGapMaxMinutes),
  );
  return minutes * 60_000;
}

/** Sleep in short slices so a shutdown signal is honored promptly. */
async function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const slice = 5_000;
  let remaining = ms;
  while (remaining > 0 && !shouldStop()) {
    const chunk = Math.min(slice, remaining);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
