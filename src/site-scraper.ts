import fs from "node:fs";
import path from "node:path";

import OpenAI from "openai";
import { chromium, type Browser } from "rebrowser-playwright";

import { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { CatalogProduct, ProductCatalog } from "./types.js";

const PAGE_TEXT_JS = `(() => {
  const el = document.querySelector('main') || document.body;
  return (el ? el.innerText : '').replace(/\\s+\\n/g, '\\n').trim();
})()`;

const MAX_TEXT_PER_PAGE = 1800;
const MAX_CORPUS_CHARS = 45_000;

/**
 * Crawl the client's product site, extract readable text from each page, and
 * distill it with OpenAI into a structured product catalog the analyzer uses to
 * keep comments on-topic per audience. Idempotent — overwrites the catalog file.
 */
export async function buildCatalog(config: AppConfig): Promise<ProductCatalog> {
  if (!config.site) {
    throw new Error("No `site` configured in config.yaml — cannot scrape a product catalog.");
  }
  const { baseUrl, maxPages, catalogPath } = config.site;
  const origin = new URL(baseUrl).origin;

  logger.info({ baseUrl }, "Scraping product site");
  const channel = config.browser.channel;
  const urls = await discoverUrls(origin, baseUrl, maxPages, channel);
  logger.info({ count: urls.length }, "Discovered URLs to crawl");

  const pages = await crawlPages(config, urls);
  logger.info({ crawled: pages.length }, "Crawled pages");

  if (pages.length === 0) {
    throw new Error(`Crawled 0 readable pages from ${baseUrl}. Check the site is reachable.`);
  }

  const audiences = config.audiences.map((a) => a.label);
  const products = await distill(config, pages, audiences);

  const catalog: ProductCatalog = {
    source: baseUrl,
    generatedAt: new Date().toISOString(),
    products,
  };

  const resolved = path.resolve(catalogPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(catalog, null, 2), "utf8");
  logger.info({ path: resolved, products: catalog.products.length }, "Wrote product catalog");
  return catalog;
}

/** Collect same-origin URLs from sitemap.xml, falling back to homepage links. */
async function discoverUrls(
  origin: string,
  baseUrl: string,
  maxPages: number,
  channel: string,
): Promise<string[]> {
  const found = new Set<string>([baseUrl]);

  for (const sitemap of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
    for (const url of await readSitemap(sitemap, origin)) {
      found.add(url);
    }
  }

  if (found.size <= 1) {
    for (const url of await linksFromPage(baseUrl, origin, channel)) {
      found.add(url);
    }
  }

  return [...found].slice(0, maxPages);
}

async function readSitemap(sitemapUrl: string, origin: string, depth = 0): Promise<string[]> {
  if (depth > 2) {
    return [];
  }
  try {
    const response = await fetch(sitemapUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        Accept: "application/xml,text/xml,*/*",
      },
    });
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);
    const nested = locs.filter((u) => u.endsWith(".xml"));
    const pages = locs
      .filter((u) => !u.endsWith(".xml") && sameDomain(u, origin))
      .map((u) => normalizeUrl(u, origin));

    for (const sitemap of nested.slice(0, 5)) {
      pages.push(...(await readSitemap(sitemap, origin, depth + 1)));
    }
    return pages;
  } catch (error) {
    logger.warn({ sitemapUrl, error: String(error) }, "Sitemap read failed");
    return [];
  }
}

async function linksFromPage(url: string, origin: string, channel: string): Promise<string[]> {
  const browser = await launch(channel);
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const hrefs = (await page.evaluate(
      `Array.from(document.querySelectorAll('a[href]')).map(a => a.href)`,
    )) as string[];
    // Keep same-domain links (ignoring www / trailing slash), re-rooted to our origin.
    const out = new Set<string>();
    for (const href of hrefs) {
      if (sameDomain(href, origin)) {
        out.add(normalizeUrl(href, origin));
      }
    }
    return [...out];
  } catch (error) {
    logger.warn({ url, error: String(error) }, "Homepage link extraction failed");
    return [];
  } finally {
    await browser.close();
  }
}

function bareHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

function sameDomain(url: string, origin: string): boolean {
  try {
    return bareHost(new URL(url).host) === bareHost(new URL(origin).host);
  } catch {
    return false;
  }
}

/** Re-root a same-domain URL onto our canonical origin and drop fragments. */
function normalizeUrl(url: string, origin: string): string {
  try {
    const parsed = new URL(url);
    const base = new URL(origin);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function crawlPages(
  config: AppConfig,
  urls: string[],
): Promise<Array<{ url: string; title: string; text: string }>> {
  const browser = await launch(config.browser.channel);
  const out: Array<{ url: string; title: string; text: string }> = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(25_000);
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        const title = await page.title();
        const text = ((await page.evaluate(PAGE_TEXT_JS)) as string).slice(0, MAX_TEXT_PER_PAGE);
        if (text.length > 80) {
          out.push({ url, title, text });
        }
      } catch (error) {
        logger.warn({ url, error: String(error) }, "Skipping page");
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function launch(channel?: string): Promise<Browser> {
  const ch = channel?.trim();
  try {
    return await chromium.launch({ headless: true, ...(ch ? { channel: ch } : {}) });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function distill(
  config: AppConfig,
  pages: Array<{ url: string; title: string; text: string }>,
  audiences: string[],
): Promise<CatalogProduct[]> {
  const client = new OpenAI({ apiKey: config.openAiApiKey, timeout: 120_000, maxRetries: 2 });

  let corpus = "";
  for (const page of pages) {
    const block = `URL: ${page.url}\nTITLE: ${page.title}\n${page.text}\n\n`;
    if (corpus.length + block.length > MAX_CORPUS_CHARS) {
      break;
    }
    corpus += block;
  }

  const audienceList = audiences.length > 0 ? audiences.join(", ") : "general";
  const system = `You analyze a company's website content and produce a concise product knowledge base for a marketing assistant that writes helpful, non-promotional Reddit comments.

Map every product to the single best-fit audience from this fixed list: ${audienceList}.

Return strict JSON:
{
  "products": [
    {
      "name": string,
      "description": string,
      "audience": one of [${audienceList}],
      "topics": string[],
      "talkingPoints": string[]
    }
  ]
}

Rules:
- "talkingPoints" are short, topical angles a knowledgeable person could naturally raise in a discussion (e.g. "an 18-year-old needs their own healthcare proxy because parents lose automatic access"). They must NOT name the company, brand, or any URL.
- Prefer 3-8 products. Keep descriptions under 200 chars.
- Base everything strictly on the provided content; do not invent products.`;

  const response = await client.chat.completions.create({
    model: config.ai.model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Website content:\n\n${corpus}` },
    ],
  });

  const raw = response.choices[0]?.message.content ?? "{}";
  let parsed: { products?: CatalogProduct[] };
  try {
    parsed = JSON.parse(raw) as { products?: CatalogProduct[] };
  } catch (error) {
    logger.error({ error, raw }, "Catalog distillation returned invalid JSON");
    return [];
  }

  return (parsed.products ?? [])
    .filter((p): p is CatalogProduct => Boolean(p && p.name))
    .map((p) => ({
      name: String(p.name).trim(),
      description: String(p.description ?? "").trim(),
      audience: String(p.audience ?? "").trim(),
      topics: Array.isArray(p.topics) ? p.topics.map(String) : [],
      talkingPoints: Array.isArray(p.talkingPoints) ? p.talkingPoints.map(String) : [],
    }));
}
