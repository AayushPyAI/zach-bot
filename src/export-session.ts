/**
 * One-shot: log into Reddit using the existing RedditBrowser login flow,
 * export session cookies to /tmp/reddit_session_cookies.json.
 * Run with: npx tsx src/export-session.ts
 */
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { RedditBrowser } from "./reddit-browser.js";

async function main() {
  const config = loadConfig();

  // Access the internal Playwright context via a thin subclass
  class CookieExporter extends RedditBrowser {
    async exportCookies() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (this as any).context;
      if (!ctx) throw new Error("Browser context not started");
      const cookies = await ctx.cookies(["https://www.reddit.com", "https://reddit.com"]);
      return cookies.filter((c: { domain?: string }) => c.domain?.includes("reddit"));
    }
  }

  const browser = new CookieExporter(config);

  console.log("Starting browser…");
  await browser.start();

  try {
    console.log("Logging in as", config.redditUsername, "…");
    await browser.login();

    const cookies = await browser.exportCookies();
    console.log(`\n✓ Got ${cookies.length} Reddit cookies`);
    cookies.forEach((c: { name: string; domain: string; httpOnly: boolean }) =>
      console.log(`  ${c.name} @ ${c.domain} (httpOnly=${c.httpOnly})`));

    const outPath = "/tmp/reddit_session_cookies.json";
    fs.writeFileSync(outPath, JSON.stringify(cookies, null, 2));
    console.log(`\n✓ Saved to ${outPath}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
