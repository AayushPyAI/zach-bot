/**
 * Generates a client-facing PDF summarising all bot features.
 * Run: node dist/generate-pdf.js
 */
import { chromium } from "rebrowser-playwright";
import path from "node:path";
import fs from "node:fs";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Reddit Growth Automation – Feature Summary</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px;
    color: #1a1a2e;
    background: #ffffff;
    line-height: 1.6;
  }

  /* ── Cover strip ── */
  .cover {
    background: linear-gradient(135deg, #ff4500 0%, #ff6534 60%, #ff8c00 100%);
    color: #fff;
    padding: 44px 48px 36px;
  }
  .cover .logo-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 28px;
  }
  .cover .dot {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: rgba(255,255,255,0.25);
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; font-weight: 700;
  }
  .cover .brand { font-size: 15px; font-weight: 600; opacity: 0.9; }
  .cover h1 { font-size: 28px; font-weight: 700; line-height: 1.2; margin-bottom: 10px; }
  .cover .subtitle { font-size: 14px; opacity: 0.85; }
  .cover .meta-row {
    margin-top: 24px;
    display: flex; gap: 32px;
    font-size: 12px; opacity: 0.8;
  }
  .cover .meta-item span { display: block; font-weight: 600; font-size: 13px; opacity: 1; color: #fff; }

  /* ── Body ── */
  .body { padding: 36px 48px 48px; }

  /* Intro blurb */
  .intro {
    background: #f8f9ff;
    border-left: 4px solid #ff4500;
    border-radius: 0 8px 8px 0;
    padding: 16px 20px;
    margin-bottom: 32px;
    font-size: 13.5px;
    color: #333;
    line-height: 1.7;
  }

  /* Section heading */
  .section-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #ff4500;
    margin-bottom: 16px;
    padding-bottom: 6px;
    border-bottom: 1px solid #ffe0d6;
  }

  /* Feature cards */
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 32px; }
  .card {
    border: 1px solid #e8e8f0;
    border-radius: 10px;
    padding: 18px 20px;
    position: relative;
    page-break-inside: avoid;
  }
  .card:hover { border-color: #ff4500; }
  .card .num {
    position: absolute; top: -10px; left: 16px;
    background: #ff4500; color: #fff;
    font-size: 11px; font-weight: 700;
    padding: 2px 8px; border-radius: 20px;
  }
  .card h3 {
    font-size: 13.5px; font-weight: 700;
    color: #1a1a2e; margin-bottom: 6px; margin-top: 4px;
  }
  .card p { font-size: 12.5px; color: #555; line-height: 1.65; margin-bottom: 8px; }
  .card .why {
    background: #fff8f5;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
    color: #cc3a00;
    font-style: italic;
  }

  /* Stats strip */
  .stats {
    display: flex; gap: 0;
    border: 1px solid #e8e8f0;
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 32px;
  }
  .stat {
    flex: 1;
    padding: 18px 20px;
    text-align: center;
    border-right: 1px solid #e8e8f0;
  }
  .stat:last-child { border-right: none; }
  .stat .val { font-size: 26px; font-weight: 700; color: #ff4500; }
  .stat .lbl { font-size: 11.5px; color: #777; margin-top: 2px; }

  /* Ramp table */
  table { width: 100%; border-collapse: collapse; margin-bottom: 32px; font-size: 12.5px; }
  th {
    background: #ff4500; color: #fff;
    padding: 9px 12px; text-align: left;
    font-weight: 600; font-size: 11.5px;
  }
  th:first-child { border-radius: 8px 0 0 0; }
  th:last-child  { border-radius: 0 8px 0 0; }
  td { padding: 9px 12px; border-bottom: 1px solid #f0f0f6; color: #444; }
  tr:last-child td { border-bottom: none; }
  tr:nth-child(even) td { background: #fafbff; }

  /* Safety list */
  .safety-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 32px; }
  .safety-item {
    display: flex; gap: 10px; align-items: flex-start;
    background: #f8f9ff; border-radius: 8px; padding: 12px 14px;
  }
  .safety-item .icon { font-size: 18px; flex-shrink: 0; }
  .safety-item .text h4 { font-size: 12.5px; font-weight: 600; color: #1a1a2e; margin-bottom: 2px; }
  .safety-item .text p  { font-size: 11.5px; color: #666; }

  /* Footer */
  .footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid #e8e8f0;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: #999;
  }
  .footer strong { color: #ff4500; }

  /* Page break helpers */
  .page-break { page-break-before: always; padding-top: 36px; }
</style>
</head>
<body>

<!-- COVER -->
<div class="cover">
  <div class="logo-row">
    <div class="dot">R</div>
    <div class="brand">Reddit Growth Automation</div>
  </div>
  <h1>Automated Reddit Marketing<br/>Feature Summary</h1>
  <div class="subtitle">Built for planningforms.com — estate planning document platform</div>
  <div class="meta-row">
    <div class="meta-item">Account<span>u/Watchdog3115</span></div>
    <div class="meta-item">Subreddits<span>102 active</span></div>
    <div class="meta-item">Audience Groups<span>9 categories</span></div>
    <div class="meta-item">Operation<span>24 / 7 automated</span></div>
  </div>
</div>

<div class="body">

  <!-- INTRO -->
  <div class="intro">
    We built a fully automated Reddit presence that runs 24/7 without any manual input. The bot behaves like
    a real, knowledgeable human — it reads threads, posts genuine helpful answers about estate planning, and
    naturally guides people toward planningforms.com. Below is a summary of every feature that is live today.
  </div>

  <!-- QUICK STATS -->
  <div class="section-title">At a Glance</div>
  <div class="stats">
    <div class="stat"><div class="val">102</div><div class="lbl">Subreddits monitored</div></div>
    <div class="stat"><div class="val">9</div><div class="lbl">Audience groups</div></div>
    <div class="stat"><div class="val">10</div><div class="lbl">Automated features</div></div>
    <div class="stat"><div class="val">24/7</div><div class="lbl">Always-on daemon</div></div>
    <div class="stat"><div class="val">6</div><div class="lbl">Competitor brands tracked</div></div>
  </div>

  <!-- CORE FEATURES -->
  <div class="section-title">Core Features</div>
  <div class="cards">

    <div class="card">
      <div class="num">01</div>
      <h3>Intelligent Comment Replies</h3>
      <p>The bot finds Reddit posts where people ask about wills, trusts, probate, power of attorney, and estate planning — then posts thoughtful, helpful replies. Only replies that score 8/10 or higher on relevance and quality are posted.</p>
      <div class="why">Drives trust and awareness every day, completely hands-free.</div>
    </div>

    <div class="card">
      <div class="num">02</div>
      <h3>Original Post Creation</h3>
      <p>The bot creates its own Reddit threads — not just replies. Four formats: personal story, educational guide, community discussion, and actionable checklist. Each post is AI-written fresh and tailored to the specific subreddit's audience.</p>
      <div class="why">Builds account authority and generates organic thread traffic.</div>
    </div>

    <div class="card">
      <div class="num">03</div>
      <h3>Competitor Mention Monitoring</h3>
      <p>Every session, the bot scans all of Reddit for threads mentioning LegalZoom, Trust &amp; Will, tomorrow.me, Willing, FreeWill, and Fabric. Complaint threads are flagged as buying-intent 9/10 and replied to first.</p>
      <div class="why">"LegalZoom was confusing" = someone actively looking for an alternative.</div>
    </div>

    <div class="card">
      <div class="num">04</div>
      <h3>Thread Follow-Up Queue</h3>
      <p>After every comment posted, the bot schedules automatic revisits at 48 hours and 7 days. If the original poster replied or new questions appeared, the bot follows up — keeping your account visible as the most helpful voice.</p>
      <div class="why">Estate planning threads get read for months. Follow-ups compound value.</div>
    </div>

    <div class="card">
      <div class="num">05</div>
      <h3>DM Invite CTA</h3>
      <p>On replies where buying intent is very high (score ≥ 8/10), the bot automatically appends a soft invite: <em>"Happy to walk through the specifics — feel free to DM me if you have more questions."</em></p>
      <div class="why">Converts public comment readers into direct 1-on-1 conversations.</div>
    </div>

    <div class="card">
      <div class="num">06</div>
      <h3>Reddit Polls</h3>
      <p>The bot creates native Reddit polls in your top subreddits — estate planning awareness questions like <em>"What's your biggest hesitation about estate planning?"</em> One poll per subreddit every 30 days.</p>
      <div class="why">Polls get 20–40% more engagement than regular posts and surface in feeds.</div>
    </div>

    <div class="card">
      <div class="num">07</div>
      <h3>Cross-Posting</h3>
      <p>When an original post is successful (e.g. in r/EstatePlanning), the bot automatically cross-posts it to 2–3 related subreddits with an AI-rewritten title tailored to each community. Minimum 48-hour delay between posts.</p>
      <div class="why">Multiplies the reach of your best content at zero extra effort.</div>
    </div>

    <div class="card">
      <div class="num">08</div>
      <h3>AMA Preparation Tracker</h3>
      <p>The bot monitors the account's karma and age toward the threshold needed for a credible AMA thread (90 days + 2,000 karma). When the account qualifies, it auto-generates a full AMA draft ready for you to review and post.</p>
      <div class="why">AMAs in r/personalfinance can generate hundreds of engaged replies and direct traffic.</div>
    </div>

  </div>

  <!-- PAGE 2 -->
  <div class="page-break"></div>

  <!-- ACCOUNT MATURITY RAMP -->
  <div class="section-title">Account Maturity System — How Activity Scales Safely</div>
  <table>
    <thead>
      <tr>
        <th>Stage</th>
        <th>Minimum Age</th>
        <th>Minimum Karma</th>
        <th>Daily Comment Cap</th>
        <th>Promotion Style</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>Warmup</td><td>0 days</td><td>Any</td><td>0 (lurk only)</td><td>None</td></tr>
      <tr><td>Cautious ← <strong>Active now</strong></td><td>7 days</td><td>Any</td><td>1 per day</td><td>Helpful, topical</td></tr>
      <tr><td>Steady</td><td>45 days</td><td>500</td><td>2 per day</td><td>Helpful, topical</td></tr>
      <tr><td>Active</td><td>90 days</td><td>2,000</td><td>3 per day</td><td>May name the brand</td></tr>
      <tr><td>Established</td><td>180 days</td><td>5,000</td><td>4 per day</td><td>Full soft-promotion</td></tr>
    </tbody>
  </table>

  <!-- AUDIENCES -->
  <div class="section-title">9 Audience Groups — 102 Subreddits</div>
  <div class="cards">
    <div class="card">
      <h3>🏛 Estate Planning &amp; Legal</h3>
      <p>r/EstatePlanning, r/legaladvice, r/personalfinance, r/Bogleheads, r/tax, r/LifeInsurance, r/RealEstate + 8 more</p>
    </div>
    <div class="card">
      <h3>🏦 Retirement Planning</h3>
      <p>r/retirement, r/financialindependence, r/FIRE, r/leanFIRE, r/fatFIRE, r/SocialSecurity, r/dividends + 4 more</p>
    </div>
    <div class="card">
      <h3>👴 Caring for Aging Parents</h3>
      <p>r/AgingParents, r/CaregiverSupport, r/eldercare, r/dementia, r/Alzheimers, r/medicare, r/hospice + 7 more</p>
    </div>
    <div class="card">
      <h3>🎓 Parents of College Students</h3>
      <p>r/CollegeParents, r/Parenting, r/paying_for_college, r/college, r/Adulting + 5 more</p>
    </div>
    <div class="card">
      <h3>🏥 Health &amp; Chronic Illness</h3>
      <p>r/CancerSupport, r/ChronicIllness, r/cancer, r/ALS, r/MultipleSclerosis, r/disability + 8 more</p>
    </div>
    <div class="card">
      <h3>🎖 Veterans &amp; Military</h3>
      <p>r/Veterans, r/Military, r/VeteransBenefits, r/navy, r/army, r/AirForce, r/Militaryfamilies + 3 more</p>
    </div>
    <div class="card">
      <h3>💔 Life Transitions &amp; Grief</h3>
      <p>r/divorce, r/GriefSupport, r/widowers, r/widows, r/SingleParents, r/greydivorce + 4 more</p>
    </div>
    <div class="card">
      <h3>💼 Small Business Owners</h3>
      <p>r/smallbusiness, r/Entrepreneur, r/selfemployed, r/freelance, r/startups, r/sweatystartup + 2 more</p>
    </div>
  </div>

  <!-- SAFETY -->
  <div class="section-title">Safety &amp; Anti-Ban Protection</div>
  <div class="safety-grid">
    <div class="safety-item">
      <div class="icon">🛡</div>
      <div class="text">
        <h4>Removal Rate Monitor</h4>
        <p>If Reddit starts silently removing comments, the bot automatically switches to draft-only mode for that session — protecting the account.</p>
      </div>
    </div>
    <div class="safety-item">
      <div class="icon">⏱</div>
      <div class="text">
        <h4>Randomised Session Timing</h4>
        <p>Sessions fire every 40–210 minutes at random. Occasional long breaks of 3–9 hours simulate a real human schedule.</p>
      </div>
    </div>
    <div class="safety-item">
      <div class="icon">🖥</div>
      <div class="text">
        <h4>Real Chrome Browser</h4>
        <p>Uses your actual installed Google Chrome — not a detectable headless browser — giving the account an authentic fingerprint.</p>
      </div>
    </div>
    <div class="safety-item">
      <div class="icon">⌨</div>
      <div class="text">
        <h4>Human Typing Simulation</h4>
        <p>Variable typing speed, reading pauses, and micro-breaks between actions. Every interaction looks like a real person.</p>
      </div>
    </div>
    <div class="safety-item">
      <div class="icon">🕐</div>
      <div class="text">
        <h4>Active Hours Gate</h4>
        <p>Only posts between 8am – 11pm. No activity in the early hours of the morning when no real human would be online.</p>
      </div>
    </div>
    <div class="safety-item">
      <div class="icon">🎲</div>
      <div class="text">
        <h4>Random Skip Sessions</h4>
        <p>Randomly skips some sessions entirely — just like a real person doesn't post every single day without exception.</p>
      </div>
    </div>
  </div>

  <!-- ACCOUNT PROFILE -->
  <div class="section-title">Account Profile — u/Watchdog3115</div>
  <div class="intro" style="border-color:#6c63ff; background:#f8f7ff;">
    <strong>Display name:</strong> WatchdogPlanning<br/><br/>
    <strong>Bio:</strong> "Spent several years doing paralegal work in estate &amp; probate. Watched too many families scramble after a loss because nothing was in order. Now I try to help people get ahead of it — wills, trusts, POA, the whole picture. Happy to answer questions. Plain English, no jargon."<br/><br/>
    <strong>Current stage:</strong> Cautious (account 10 days old) — live posting is active, 1 comment/day cap. Automatically scales up as karma and age grow — no manual changes needed.
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div>Confidential — prepared for <strong>planningforms.com</strong></div>
    <div>Reddit Growth Automation · u/Watchdog3115 · 24/7 Active</div>
  </div>

</div>
</body>
</html>`;

async function main() {
  const outPath = path.resolve("Reddit-Growth-Features.pdf");

  // Write HTML to a temp file then navigate to it (avoids setContent timeout)
  const tmpHtml = path.resolve("dist/_pdf_tmp.html");
  fs.writeFileSync(tmpHtml, HTML, "utf8");

  console.log("Launching headless Chrome for PDF rendering…");
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`file://${tmpHtml}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(800);

  await page.pdf({
    path: outPath,
    format: "A4",
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });

  await browser.close();
  fs.unlinkSync(tmpHtml);

  const size = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`PDF saved: ${outPath} (${size} KB)`);
}

main().catch((err) => {
  console.error("PDF generation failed:", err);
  process.exit(1);
});
