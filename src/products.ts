import fs from "node:fs";
import path from "node:path";

import { AppConfig, AudienceGroup } from "./config.js";
import { logger } from "./logger.js";
import { CatalogProduct, ProductCatalog } from "./types.js";

/**
 * Loads the scraped product catalog and resolves which product context to feed
 * the analyzer for a given audience group. Missing/empty catalog is non-fatal:
 * the bot simply falls back to generic helpful comments.
 */
export class ProductKnowledge {
  private readonly byAudience = new Map<string, CatalogProduct[]>();
  private readonly byName = new Map<string, CatalogProduct>();

  constructor(private readonly catalog: ProductCatalog | null) {
    for (const product of catalog?.products ?? []) {
      this.byName.set(product.name.toLowerCase(), product);
      const key = product.audience.toLowerCase();
      const list = this.byAudience.get(key) ?? [];
      list.push(product);
      this.byAudience.set(key, list);
    }
  }

  get isEmpty(): boolean {
    return this.byName.size === 0;
  }

  /** Best product match for an audience group: explicit `product`, else by label. */
  forAudience(group: AudienceGroup | undefined): CatalogProduct | null {
    if (!group) {
      return null;
    }
    if (group.product) {
      const named = this.byName.get(group.product.toLowerCase());
      if (named) {
        return named;
      }
    }
    return this.byAudience.get(group.label.toLowerCase())?.[0] ?? null;
  }

  /** Topical guidance block for the prompt, or null if there's nothing to add. */
  guidanceFor(group: AudienceGroup | undefined): string | null {
    const product = this.forAudience(group);
    if (!product || product.talkingPoints.length === 0) {
      return null;
    }
    const points = product.talkingPoints.map((p) => `- ${p}`).join("\n");
    return [
      `Relevant topic area for this audience (${product.audience}): ${product.description}`,
      "When it fits naturally, you may raise one of these angles — as genuine advice, never as a pitch, never naming a brand or product, never a URL:",
      points,
    ].join("\n");
  }
}

export function loadProductKnowledge(config: AppConfig): ProductKnowledge {
  const catalogPath = config.site?.catalogPath;
  if (!catalogPath) {
    return new ProductKnowledge(null);
  }
  const resolved = path.resolve(catalogPath);
  if (!fs.existsSync(resolved)) {
    logger.warn({ resolved }, "No product catalog found — run `npm run scrape`. Using generic comments.");
    return new ProductKnowledge(null);
  }
  try {
    const catalog = JSON.parse(fs.readFileSync(resolved, "utf8")) as ProductCatalog;
    logger.info({ products: catalog.products?.length ?? 0 }, "Loaded product catalog");
    return new ProductKnowledge(catalog);
  } catch (error) {
    logger.error({ error: String(error) }, "Failed to read product catalog");
    return new ProductKnowledge(null);
  }
}
