import { loadConfig } from "./config.js";
import { runDaemon } from "./daemon.js";
import { logger } from "./logger.js";
import { runWorkflow } from "./workflow.js";

interface CliOptions {
  forcePosting: boolean | null;
  loop: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { forcePosting: null, loop: false };
  for (const arg of argv) {
    switch (arg) {
      case "--dry-run":
        options.forcePosting = false;
        break;
      case "--live":
        options.forcePosting = true;
        break;
      case "--loop":
        options.loop = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        logger.warn({ arg }, "Ignoring unknown argument");
    }
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Reddit automation bot",
      "",
      "Usage: npm run dev -- [options]",
      "",
      "Options:",
      "  --loop      Run 24/7 as a daemon, starting sessions at randomized intervals",
      "  --dry-run   Force draft-only mode (never posts), overriding config.yaml",
      "  --live      Force live posting on, overriding config.yaml",
      "  -h, --help  Show this help",
      "",
      "With no flag, runs a single session and posting follows config.yaml.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // CLI intent is passed to the run (not pre-applied), so the account ramp can
  // make the final, safe posting decision. --dry-run always forces draft-only.
  const runOpts = { forcePosting: options.forcePosting };

  logger.info({
    audiences: config.audiences.map((a) => a.label),
    forcePosting: options.forcePosting,
    rampEnabled: config.ramp.enabled,
    promotionLevel: config.ai.promotionLevel,
    liveSearch: config.ai.liveSearch,
    model: config.ai.model,
    mode: options.loop ? "daemon (24/7)" : "single run",
  }, "Starting Reddit automation bot");

  if (options.loop) {
    await runDaemon(config, runOpts);
  } else {
    await runWorkflow(config, runOpts);
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  logger.error({ err: detail }, "Fatal error");
  process.exitCode = 1;
});
