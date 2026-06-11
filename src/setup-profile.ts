/**
 * One-shot script: sets up the Reddit profile for the configured account.
 * Run with: npx ts-node --esm scripts/setup-profile.ts
 * Or after build: node dist/scripts/setup-profile.js
 */
import { chromium } from "rebrowser-playwright";
import path from "node:path";
import { loadConfig } from "./config.js";

const PROFILE = {
  displayName: "WatchdogPlanning",
  bio: [
    "Spent several years doing paralegal work in estate & probate.",
    "Watched too many families scramble after a loss because nothing was in order.",
    "Now I try to help people get ahead of it — wills, trusts, POA, the whole picture.",
    "Happy to answer questions. Plain English, no jargon.",
  ].join(" "),
};

async function main() {
  const config = loadConfig();
  const userDataDir = path.resolve(config.browser.userDataDir);

  console.log("Launching browser with saved session…");
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
  });

  const page = await context.newPage();

  try {
    // Step 1: get modhash from reddit.com (needed for authenticated API calls)
    console.log("Fetching modhash…");
    await page.goto("https://www.reddit.com/api/me.json", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const meText = await page.evaluate(() => document.body.innerText);
    const meJson = JSON.parse(meText) as { data?: { modhash?: string; name?: string } };
    const modhash = meJson?.data?.modhash;
    const username = meJson?.data?.name;

    if (!modhash || !username) {
      console.error("Not logged in or modhash missing. me.json:", meText.slice(0, 200));
      return;
    }
    console.log(`Logged in as ${username}, modhash: ${modhash.slice(0, 8)}…`);

    // Step 2: get the user's profile subreddit fullname (needed for site_admin)
    const subredditName = `u_${username}`;
    const subInfoResp = await page.evaluate(
      async (subName: string) => {
        const r = await fetch(`https://www.reddit.com/r/${subName}/about.json`, { credentials: "include" });
        return { status: r.status, body: await r.text() };
      },
      subredditName
    );
    const subInfo = JSON.parse(subInfoResp.body) as { data?: { name?: string; display_name?: string } };
    const srFullname = subInfo?.data?.name; // e.g. "t5_abc123"
    console.log(`Profile subreddit fullname: ${srFullname ?? "not found"}`);

    // Step 3: update bio + display name via site_admin (the standard old-Reddit settings API)
    console.log("Updating profile bio and display name…");
    const updateResult = await page.evaluate(
      async ({ bio, displayName, modhash, srFullname, srName }: {
        bio: string; displayName: string; modhash: string; srFullname: string; srName: string;
      }) => {
        const body = new URLSearchParams({
          api_type: "json",
          uh: modhash,
          sr: srFullname,
          name: srName,
          title: displayName,         // display name shown on profile
          public_description: bio,     // bio visible on profile page
          description: bio,
          type: "user",               // mark as user-type subreddit
          link_type: "any",
          wikimode: "disabled",
          spam_links: "high",
          spam_selfposts: "high",
          spam_comments: "high",
        });
        const resp = await fetch("https://www.reddit.com/api/site_admin", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          credentials: "include",
        });
        return { status: resp.status, body: await resp.text() };
      },
      { bio: PROFILE.bio, displayName: PROFILE.displayName, modhash, srFullname: srFullname ?? "", srName: subredditName }
    );

    console.log(`site_admin status: ${updateResult.status}`);
    console.log(`site_admin response: ${updateResult.body.slice(0, 500)}`);

    if (updateResult.status === 200 && !updateResult.body.includes('"errors": [[')) {
      console.log("Profile bio/display name updated successfully!");
    } else {
      console.warn("Check response above for errors");
    }

    // Verify
    const currentUrl = page.url();
    console.log(`Final URL: ${currentUrl}`);
  } finally {
    await page.waitForTimeout(2000);
    await context.close();
  }
}

main().catch((err) => {
  console.error("Profile setup failed:", err);
  process.exit(1);
});
