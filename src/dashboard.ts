/**
 * Live web dashboard for the Reddit bot.
 * Run: npm run dashboard   →  open http://localhost:3000
 */
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";

const PORT = 3000;

// ── DB helpers ────────────────────────────────────────────────────────────────

function openDb() {
  const config = loadConfig();
  const dbPath = path.resolve(config.runtime.databasePath);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function getStats() {
  const db = openDb();
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
  const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

  // Funnel
  const funnel = one<{ seen: number; analyzed: number; drafted: number; live: number; dry: number; skipped: number }>(`
    SELECT COUNT(*) AS seen,
      SUM(CASE WHEN relevance IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,
      SUM(CASE WHEN draft_comment IS NOT NULL THEN 1 ELSE 0 END) AS drafted,
      SUM(CASE WHEN commented=1 AND dry_run=0 THEN 1 ELSE 0 END) AS live,
      SUM(CASE WHEN commented=1 AND dry_run=1 THEN 1 ELSE 0 END) AS dry,
      SUM(CASE WHEN skipped_reason IS NOT NULL THEN 1 ELSE 0 END) AS skipped
    FROM posts`);

  // Removal health
  const health = one<{ checked: number; removed: number }>(`
    SELECT SUM(CASE WHEN removed IS NOT NULL THEN 1 ELSE 0 END) AS checked,
           SUM(CASE WHEN removed=1 THEN 1 ELSE 0 END) AS removed
    FROM posts WHERE commented=1 AND dry_run=0`);

  // AI quality
  const quality = one<{ avgRel: number; avgIntent: number }>(`
    SELECT ROUND(AVG(relevance),1) AS avgRel, ROUND(AVG(intent),1) AS avgIntent
    FROM posts WHERE relevance IS NOT NULL`);

  // Account snapshots
  const snapshots = all<{ ts: number; age_days: number; total_karma: number; comment_karma: number; stage: string; daily_cap: number }>(`
    SELECT ts, age_days, total_karma, comment_karma, stage, daily_cap
    FROM account_snapshots ORDER BY ts ASC`);

  const latestSnap = snapshots.length ? snapshots[snapshots.length - 1]! : null;

  // Daily comments (last 14 days)
  const daily = all<{ day: string; count: number }>(`
    SELECT date(commented_ts,'unixepoch') AS day, COUNT(*) AS count
    FROM posts
    WHERE commented=1 AND dry_run=0
      AND commented_ts >= strftime('%s','now','-14 days')
    GROUP BY day ORDER BY day ASC`);

  // Subreddits
  const bySubreddit = all<{ subreddit: string; drafted: number; live: number; avg_intent: number }>(`
    SELECT subreddit,
      SUM(CASE WHEN draft_comment IS NOT NULL THEN 1 ELSE 0 END) AS drafted,
      SUM(CASE WHEN commented=1 AND dry_run=0 THEN 1 ELSE 0 END) AS live,
      ROUND(AVG(CASE WHEN intent IS NOT NULL THEN intent END),1) AS avg_intent
    FROM posts GROUP BY subreddit HAVING drafted > 0
    ORDER BY live DESC, drafted DESC LIMIT 20`);

  // Recent live comments
  const recentLive = all<{ title: string; subreddit: string; draft_comment: string; commented_ts: number; url: string }>(`
    SELECT title, subreddit, draft_comment, commented_ts, url
    FROM posts WHERE commented=1 AND dry_run=0
    ORDER BY commented_ts DESC LIMIT 8`);

  // Original posts
  const origPosts = one<{ total: number; live: number }>(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN dry_run=0 THEN 1 ELSE 0 END) AS live
    FROM created_posts`);

  // Cross posts
  let crossPosts = { total: 0, live: 0 };
  try {
    crossPosts = one<{ total: number; live: number }>(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN dry_run=0 THEN 1 ELSE 0 END) AS live
      FROM cross_posts`) ?? { total: 0, live: 0 };
  } catch { /* table may not exist yet */ }

  // Polls
  let polls = { total: 0, live: 0 };
  try {
    polls = one<{ total: number; live: number }>(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN dry_run=0 THEN 1 ELSE 0 END) AS live
      FROM polls_created`) ?? { total: 0, live: 0 };
  } catch { /* */ }

  // Follow-ups
  let followUps = { total: 0, done: 0 };
  try {
    followUps = one<{ total: number; done: number }>(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN checked_48h=1 AND checked_7d=1 THEN 1 ELSE 0 END) AS done
      FROM follow_up_queue`) ?? { total: 0, done: 0 };
  } catch { /* */ }

  // AMA kv
  let amaDraft = false;
  try {
    const kv = one<{ value: string } | undefined>(`SELECT value FROM kv_store WHERE key='ama_draft'`);
    amaDraft = Boolean(kv?.value);
  } catch { /* */ }

  db.close();

  return {
    funnel, health, quality,
    snapshots: snapshots.map(s => ({ ts: s.ts, karma: s.total_karma, age: Math.round(s.age_days), stage: s.stage })),
    latestSnap,
    daily,
    bySubreddit,
    recentLive,
    origPosts: origPosts ?? { total: 0, live: 0 },
    crossPosts,
    polls,
    followUps,
    amaDraft,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function buildHtml(s: ReturnType<typeof getStats>): string {
  const snap = s.latestSnap;
  const removalRate = s.health.checked > 0
    ? ((s.health.removed / s.health.checked) * 100).toFixed(0) + "%"
    : "0%";

  const amaAgePct   = Math.min(100, Math.round(((snap?.age_days ?? 0) / 90) * 100));
  const amaKarmaPct = Math.min(100, Math.round(((snap?.total_karma ?? 0) / 2000) * 100));
  const amaReady    = (snap?.age_days ?? 0) >= 90 && (snap?.total_karma ?? 0) >= 2000;

  const dailyLabels = s.daily.map(d => d.day.slice(5)).join(",");
  const dailyData   = s.daily.map(d => d.count).join(",");

  const karmaLabels = s.snapshots.map(s => new Date(s.ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })).join(",");
  const karmaData   = s.snapshots.map(s => s.karma).join(",");

  const subRows = s.bySubreddit.map(r => `
    <tr>
      <td><a href="https://reddit.com/r/${r.subreddit}" target="_blank">r/${r.subreddit}</a></td>
      <td class="num">${r.drafted}</td>
      <td class="num live">${r.live}</td>
      <td class="num">${r.avg_intent ?? "—"}</td>
    </tr>`).join("");

  const recentRows = s.recentLive.map(r => {
    const date = new Date(r.commented_ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const snippet = (r.draft_comment ?? "").slice(0, 100) + "…";
    return `
    <div class="feed-item">
      <div class="feed-meta"><a href="${r.url}" target="_blank">r/${r.subreddit}</a> · ${date}</div>
      <div class="feed-title">${escHtml(r.title)}</div>
      <div class="feed-body">${escHtml(snippet)}</div>
    </div>`;
  }).join("") || '<div class="empty">No live comments yet — bot is warming up.</div>';

  const stageColor: Record<string, string> = {
    warmup: "#999", cautious: "#f5a623", steady: "#4caf50", active: "#2196f3", established: "#9c27b0",
  };
  const stageBadgeColor = stageColor[snap?.stage ?? "warmup"] ?? "#999";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Reddit Bot Dashboard — Watchdog3115</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d0d;color:#e8e8e8;font-size:14px;line-height:1.5}
  a{color:#ff6534;text-decoration:none}a:hover{text-decoration:underline}

  /* Header */
  .header{background:linear-gradient(135deg,#1a0500 0%,#2d0a00 100%);border-bottom:1px solid #3a1500;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  .header-left{display:flex;align-items:center;gap:16px}
  .logo{width:40px;height:40px;background:#ff4500;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#fff;flex-shrink:0}
  .header h1{font-size:18px;font-weight:700;color:#fff}
  .header .sub{font-size:12px;color:#aaa;margin-top:1px}
  .header-right{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  .badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .refresh-note{font-size:11px;color:#666}
  .ngrok-banner{display:none;align-items:center;gap:10px;background:#0a1a0a;border:1px solid #1a4a1a;border-radius:8px;padding:10px 18px;margin:0 28px 0 0;flex-wrap:wrap}
  .ngrok-banner .ngrok-label{font-size:11px;font-weight:700;letter-spacing:.5px;color:#4caf50;text-transform:uppercase;white-space:nowrap}
  .ngrok-banner a{font-size:13px;font-weight:600;color:#66bb6a;word-break:break-all}
  .ngrok-banner .copy-btn{background:#1a4a1a;border:1px solid #2a6a2a;color:#4caf50;padding:3px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap}
  .ngrok-banner .copy-btn:hover{background:#2a6a2a}

  /* Layout */
  .page{padding:24px 28px;max-width:1400px;margin:0 auto}

  /* Metric cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:18px 20px}
  .card .label{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#777;margin-bottom:8px}
  .card .value{font-size:28px;font-weight:700;line-height:1}
  .card .sub-value{font-size:12px;color:#666;margin-top:4px}
  .card.highlight .value{color:#ff4500}
  .card.green .value{color:#4caf50}
  .card.blue .value{color:#2196f3}
  .card.purple .value{color:#9c27b0}
  .card.orange .value{color:#ff9800}

  /* Section */
  .section{margin-bottom:28px}
  .section-header{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#ff4500;margin-bottom:14px;padding-bottom:6px;border-bottom:1px solid #2a2a2a}

  /* Two-col grid */
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
  @media(max-width:900px){.two-col{grid-template-columns:1fr}}

  /* Chart boxes */
  .chart-box{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px}
  .chart-box h3{font-size:13px;font-weight:600;color:#ccc;margin-bottom:16px}
  .chart-box canvas{max-height:200px}

  /* Table */
  .table-box{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#222;color:#888;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;padding:10px 14px;text-align:left}
  td{padding:9px 14px;border-top:1px solid #222;color:#ccc}
  tr:hover td{background:#1f1f1f}
  td.num{text-align:right;color:#aaa}
  td.live{color:#4caf50;font-weight:600}

  /* Funnel */
  .funnel{display:flex;gap:0;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden;margin-bottom:24px}
  .funnel-step{flex:1;padding:18px 16px;text-align:center;border-right:1px solid #2a2a2a;position:relative}
  .funnel-step:last-child{border-right:none}
  .funnel-step .f-label{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#666;margin-bottom:6px}
  .funnel-step .f-value{font-size:24px;font-weight:700;color:#fff}
  .funnel-step .f-arrow{position:absolute;right:-10px;top:50%;transform:translateY(-50%);color:#333;font-size:18px;z-index:1}
  .funnel-step:last-child .f-arrow{display:none}
  .funnel-step.active .f-value{color:#ff4500}
  .funnel-step.live .f-value{color:#4caf50}

  /* Feed */
  .feed{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;overflow:hidden}
  .feed-item{padding:14px 18px;border-bottom:1px solid #222}
  .feed-item:last-child{border-bottom:none}
  .feed-meta{font-size:11px;color:#666;margin-bottom:4px}
  .feed-title{font-size:13px;font-weight:600;color:#ddd;margin-bottom:4px}
  .feed-body{font-size:12px;color:#888;line-height:1.5}
  .empty{padding:24px;text-align:center;color:#555;font-style:italic}

  /* Progress bars */
  .progress-row{margin-bottom:12px}
  .progress-label{display:flex;justify-content:space-between;font-size:12px;color:#888;margin-bottom:5px}
  .progress-track{background:#222;border-radius:20px;height:8px;overflow:hidden}
  .progress-fill{height:100%;border-radius:20px;transition:width .3s}

  /* Growth features grid */
  .feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}
  .feature-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:16px 18px;display:flex;align-items:center;gap:14px}
  .feature-icon{font-size:26px;flex-shrink:0}
  .feature-info .f-title{font-size:12px;color:#888;margin-bottom:2px}
  .feature-info .f-num{font-size:20px;font-weight:700;color:#fff}
  .feature-info .f-sub{font-size:11px;color:#555;margin-top:1px}

  /* Health strip */
  .health-strip{display:flex;gap:14px;margin-bottom:24px;flex-wrap:wrap}
  .health-item{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:14px 18px;flex:1;min-width:160px}
  .health-item .h-label{font-size:11px;color:#666;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
  .health-item .h-value{font-size:18px;font-weight:700}
  .h-good{color:#4caf50}.h-warn{color:#ff9800}.h-bad{color:#f44336}

  /* AMA box */
  .ama-box{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px 24px}
  .ama-box h3{font-size:13px;font-weight:600;color:#ccc;margin-bottom:16px}
  .ama-ready{background:#1a3a1a;border:1px solid #2a6a2a;border-radius:8px;padding:12px 16px;color:#4caf50;font-weight:600;text-align:center}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-left">
    <div class="logo">R</div>
    <div>
      <div class="header h1" style="font-size:18px;font-weight:700;color:#fff">Reddit Bot Dashboard</div>
      <div class="sub">u/Watchdog3115 · planningforms.com · Auto-refreshes every 60s</div>
    </div>
  </div>
  <div class="header-right">
    <span class="badge" style="background:${stageBadgeColor}22;color:${stageBadgeColor};border:1px solid ${stageBadgeColor}44">
      Stage: ${snap?.stage ?? "—"}
    </span>
    <span class="badge" style="background:#ff450022;color:#ff4500;border:1px solid #ff450044">
      ${snap?.total_karma ?? 0} Karma
    </span>
    <span class="badge" style="background:#2196f322;color:#2196f3;border:1px solid #2196f344">
      Day ${snap?.age_days ?? 0}
    </span>
    <span class="refresh-note" id="last-updated">Updated just now</span>
  </div>
</div>

<!-- NGROK BANNER -->
<div id="ngrok-banner" class="ngrok-banner" style="padding:10px 28px;margin:0">
  <span class="ngrok-label">Public URL</span>
  <a id="ngrok-link" href="#" target="_blank"></a>
  <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('ngrok-link').href).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
</div>

<div class="page">

  <!-- FUNNEL -->
  <div class="section">
    <div class="section-header">Activity Funnel — All Time</div>
    <div class="funnel">
      <div class="funnel-step">
        <div class="f-label">Posts Seen</div>
        <div class="f-value">${s.funnel.seen ?? 0}</div>
        <div class="f-arrow">›</div>
      </div>
      <div class="funnel-step active">
        <div class="f-label">AI Analyzed</div>
        <div class="f-value">${s.funnel.analyzed ?? 0}</div>
        <div class="f-arrow">›</div>
      </div>
      <div class="funnel-step active">
        <div class="f-label">Drafts Written</div>
        <div class="f-value">${s.funnel.drafted ?? 0}</div>
        <div class="f-arrow">›</div>
      </div>
      <div class="funnel-step live">
        <div class="f-label">Posted Live</div>
        <div class="f-value">${s.funnel.live ?? 0}</div>
        <div class="f-arrow">›</div>
      </div>
      <div class="funnel-step">
        <div class="f-label">Draft-Only</div>
        <div class="f-value">${s.funnel.dry ?? 0}</div>
        <div class="f-arrow">›</div>
      </div>
      <div class="funnel-step">
        <div class="f-label">Skipped</div>
        <div class="f-value">${s.funnel.skipped ?? 0}</div>
      </div>
    </div>
  </div>

  <!-- TOP METRICS -->
  <div class="section">
    <div class="section-header">Key Numbers</div>
    <div class="cards">
      <div class="card highlight">
        <div class="label">Live Comments</div>
        <div class="value">${s.funnel.live ?? 0}</div>
        <div class="sub-value">posted to Reddit</div>
      </div>
      <div class="card green">
        <div class="label">Original Posts</div>
        <div class="value">${s.origPosts?.live ?? 0}</div>
        <div class="sub-value">${s.origPosts?.total ?? 0} total incl. drafts</div>
      </div>
      <div class="card blue">
        <div class="label">Cross-Posts</div>
        <div class="value">${s.crossPosts.live}</div>
        <div class="sub-value">${s.crossPosts.total} total incl. drafts</div>
      </div>
      <div class="card orange">
        <div class="label">Polls Created</div>
        <div class="value">${s.polls.live}</div>
        <div class="sub-value">${s.polls.total} total incl. drafts</div>
      </div>
      <div class="card purple">
        <div class="label">Follow-Ups</div>
        <div class="value">${s.followUps.total}</div>
        <div class="sub-value">${s.followUps.done} completed</div>
      </div>
      <div class="card">
        <div class="label">Avg Relevance</div>
        <div class="value" style="color:#f5a623">${s.quality.avgRel ?? "—"}</div>
        <div class="sub-value">/ 10 AI score</div>
      </div>
      <div class="card">
        <div class="label">Avg Buying Intent</div>
        <div class="value" style="color:#f5a623">${s.quality.avgIntent ?? "—"}</div>
        <div class="sub-value">/ 10 AI score</div>
      </div>
      <div class="card">
        <div class="label">Daily Cap</div>
        <div class="value" style="color:#ccc">${snap?.daily_cap ?? 0}</div>
        <div class="sub-value">comments / day</div>
      </div>
    </div>
  </div>

  <!-- CHARTS -->
  <div class="two-col">
    <div class="chart-box">
      <h3>Daily Live Comments — Last 14 Days</h3>
      <canvas id="dailyChart"></canvas>
    </div>
    <div class="chart-box">
      <h3>Karma Growth Over Time</h3>
      <canvas id="karmaChart"></canvas>
    </div>
  </div>

  <!-- HEALTH -->
  <div class="section">
    <div class="section-header">Account Health</div>
    <div class="health-strip">
      <div class="health-item">
        <div class="h-label">Comment Removal Rate</div>
        <div class="h-value ${s.health.removed === 0 ? "h-good" : s.health.removed / Math.max(s.health.checked,1) < 0.2 ? "h-warn" : "h-bad"}">${removalRate}</div>
      </div>
      <div class="health-item">
        <div class="h-label">Comments Checked</div>
        <div class="h-value" style="color:#ccc">${s.health.checked}</div>
      </div>
      <div class="health-item">
        <div class="h-label">Account Stage</div>
        <div class="h-value" style="color:${stageBadgeColor}">${snap?.stage ?? "—"}</div>
      </div>
      <div class="health-item">
        <div class="h-label">Account Age</div>
        <div class="h-value" style="color:#ccc">Day ${snap?.age_days ?? 0}</div>
      </div>
      <div class="health-item">
        <div class="h-label">Total Karma</div>
        <div class="h-value" style="color:#ff4500">${snap?.total_karma ?? 0}</div>
      </div>
      <div class="health-item">
        <div class="h-label">Comment Karma</div>
        <div class="h-value" style="color:#ff6534">${snap?.comment_karma ?? 0}</div>
      </div>
    </div>
  </div>

  <!-- AMA TRACKER -->
  <div class="section">
    <div class="section-header">AMA Readiness Tracker</div>
    <div class="ama-box">
      <h3>Target: 90 days old + 2,000 karma → post AMA in r/personalfinance &amp; r/EstatePlanning</h3>
      ${amaReady ? '<div class="ama-ready">✅ Account is AMA-ready! Check the database for the generated draft.</div>' : `
      <div class="progress-row">
        <div class="progress-label">
          <span>Account Age (${snap?.age_days ?? 0} / 90 days)</span>
          <span>${amaAgePct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${amaAgePct}%;background:linear-gradient(90deg,#ff4500,#ff8c00)"></div>
        </div>
      </div>
      <div class="progress-row">
        <div class="progress-label">
          <span>Karma (${snap?.total_karma ?? 0} / 2,000)</span>
          <span>${amaKarmaPct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${amaKarmaPct}%;background:linear-gradient(90deg,#9c27b0,#e040fb)"></div>
        </div>
      </div>`}
    </div>
  </div>

  <!-- SUBREDDIT TABLE -->
  <div class="two-col">
    <div class="section" style="margin-bottom:0">
      <div class="section-header">Top Subreddits by Activity</div>
      <div class="table-box">
        <table>
          <thead><tr><th>Subreddit</th><th style="text-align:right">Drafted</th><th style="text-align:right">Live</th><th style="text-align:right">Avg Intent</th></tr></thead>
          <tbody>${subRows || '<tr><td colspan="4" style="text-align:center;color:#555;padding:20px">No data yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <!-- RECENT LIVE COMMENTS -->
    <div class="section" style="margin-bottom:0">
      <div class="section-header">Recent Live Comments</div>
      <div class="feed">${recentRows}</div>
    </div>
  </div>

</div>

<script>
// ── Charts ──────────────────────────────────────────────────────────────────
const chartDefaults = {
  responsive: true,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: '#1f1f1f' }, ticks: { color: '#666', font: { size: 11 } } },
    y: { grid: { color: '#1f1f1f' }, ticks: { color: '#666', font: { size: 11 } }, beginAtZero: true },
  },
};

// Daily comments chart
const dailyLabels = [${dailyLabels ? `"${dailyLabels.split(",").join('","')}"` : ""}];
const dailyData   = [${dailyData}];
new Chart(document.getElementById('dailyChart'), {
  type: 'bar',
  data: {
    labels: dailyLabels,
    datasets: [{ data: dailyData, backgroundColor: '#ff450099', borderColor: '#ff4500', borderWidth: 1, borderRadius: 4 }]
  },
  options: chartDefaults,
});

// Karma chart
const karmaLabels = [${karmaLabels ? `"${karmaLabels.split(",").join('","')}"` : ""}];
const karmaData   = [${karmaData}];
new Chart(document.getElementById('karmaChart'), {
  type: 'line',
  data: {
    labels: karmaLabels,
    datasets: [{
      data: karmaData,
      borderColor: '#9c27b0', backgroundColor: '#9c27b011',
      borderWidth: 2, pointRadius: 3, fill: true, tension: 0.3
    }]
  },
  options: chartDefaults,
});

// Auto-refresh
let countdown = 60;
const note = document.getElementById('last-updated');
setInterval(() => {
  countdown--;
  if (countdown <= 0) { window.location.reload(); }
  else { note.textContent = 'Refreshes in ' + countdown + 's'; }
}, 1000);

// Fetch and display ngrok public URL
async function loadNgrokUrl() {
  try {
    const r = await fetch('/api/ngrok-url');
    const d = await r.json();
    const banner = document.getElementById('ngrok-banner');
    const link = document.getElementById('ngrok-link');
    if (d.url && banner && link) {
      link.textContent = d.url;
      link.href = d.url;
      banner.style.display = 'flex';
    }
  } catch {}
}
loadNgrokUrl();
setInterval(loadNgrokUrl, 30000);
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Server ────────────────────────────────────────────────────────────────────

async function getNgrokUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    http.get("http://127.0.0.1:4040/api/tunnels", (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body) as { tunnels: Array<{ public_url: string; proto: string }> };
          const tunnel = data.tunnels.find(t => t.proto === "https") ?? data.tunnels[0];
          resolve(tunnel?.public_url ?? null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/stats") {
    try {
      const stats = getStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.url === "/api/ngrok-url") {
    const url = await getNgrokUrl();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url }));
    return;
  }

  // Serve dashboard for all other routes
  try {
    const stats = getStats();
    const html  = buildHtml(stats);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error loading dashboard: ${String(err)}\n\nMake sure the bot has run at least once to create the database.`);
  }
});

server.listen(PORT, async () => {
  console.log(`[dashboard] running at http://localhost:${PORT}`);
  // Print ngrok URL if already available
  const url = await getNgrokUrl();
  if (url) console.log(`[dashboard] public URL: ${url}`);
});
