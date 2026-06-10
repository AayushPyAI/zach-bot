import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildCatalog } from "./site-scraper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const catalog = await buildCatalog(config);
  logger.info(
    {
      products: catalog.products.map((p) => ({ name: p.name, audience: p.audience })),
      blogTopics: catalog.blogTopics.length,
    },
    "Catalog built",
  );
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  logger.error({ err: detail }, "Scrape failed");
  process.exitCode = 1;
});
