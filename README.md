# Reddit Comment Bot

A browser-automation bot that:

1. Logs into a Reddit account in a real Chrome window (Playwright).
2. Scans subreddits you choose (default: `r/personalfinance`, `r/legaladvice`, `r/EstatePlanning`).
3. Pulls recent text posts.
4. Sends each post to OpenAI to (a) score relevance 0-10 and (b) draft a helpful reply.
5. Posts the best drafts as comments, respecting daily caps and human-like delays.

**No product links are inserted in the current version.** That's intentional - we're building reputation first.

---

## ⚠️ Read this before you do anything

Reddit aggressively detects bots and self-promotion. **Brand new accounts that drop links get shadowbanned (invisibly muted) very quickly.** Even commenting from a brand new account is risky if done in volume.

Recommended ramp-up:

| Week | What the bot does | What you do |
|---|---|---|
| 1 | `dry_run: true` - only drafts, never posts | You manually post 2-3 genuine comments per day from the account. Build karma. |
| 2 | `dry_run: true` still | Keep doing manual comments. Get to ~50 comment karma. |
| 3+ | `dry_run: false`, `daily_cap: 1-2` | Let the bot post 1-2 comments per day. Watch for shadowbans. |
| Later | Add a product link (separate change) | Only after the account is established. |

To check if you've been shadowbanned, log out and visit your profile from an incognito window. If your comments are missing → shadowbanned.

---

## Prerequisites (one-time setup)

You'll need:

- **Python 3.10 or newer** for Windows: <https://www.python.org/downloads/>
  During install, **tick "Add Python to PATH"**.
- **An OpenAI API key**: <https://platform.openai.com/api-keys>
  Cost is tiny (`gpt-4o-mini` is ~$0.001 per post analyzed).
- **A Reddit account.** If you don't have one, sign up at <https://www.reddit.com/register>. Then go to the account on the website and:
  - Add an email and verify it.
  - Set a profile picture and bio.
  - Manually upvote ~10 posts and comment on 2-3 posts naturally over the next day.
  These small steps reduce shadowban risk dramatically.

---

## Install

Open **PowerShell**, then run these commands one at a time:

```powershell
cd C:\Users\asus\reddit-comment-bot

python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install --upgrade pip
pip install -r requirements.txt

python -m playwright install chromium
```

If PowerShell blocks `Activate.ps1`, run this once and accept:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

---

## Configure

1. **Create your `.env` file** from the template:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Fill in your real Reddit username/password and your OpenAI API key. Save.

2. **(Optional) Tweak `config.yaml`.** The defaults are safe (`dry_run: true`, daily cap 2, gap 90 min). Read the comments in that file - everything you might want to change is there.

---

## First run (login)

The very first run will open a real Chrome window so YOU can solve any Reddit captcha. `config.yaml` already has `browser.headless: false` for this reason.

```powershell
python -m src.main
```

What you should see:

1. A Chromium window opens.
2. Bot navigates to `reddit.com/login` and types your credentials.
3. **If a captcha appears, solve it yourself in the window.** The bot will wait up to 2 minutes.
4. Once logged in, the bot loads each subreddit's JSON, picks candidate posts, sends them to OpenAI, and prints draft comments to the terminal.
5. Because `dry_run: true`, **nothing is actually posted**. The drafts are saved to `data/state.db` and `logs/bot.log`.

The login session is saved in `data/browser_profile/`, so subsequent runs won't need to log in again. After the first successful run you can set `browser.headless: true` in `config.yaml`.

---

## Reviewing drafts

After a run, inspect what the AI produced:

```powershell
python -c "import sqlite3; c=sqlite3.connect('data/state.db'); [print('---', r['title'], '\nscore=', r['relevance'], '\n', r['draft_comment'], '\n') for r in c.execute('select * from posts where draft_comment is not null order by first_seen_ts desc limit 10')]"
```

Or just open `data/state.db` with [DB Browser for SQLite](https://sqlitebrowser.org/) and look at the `posts` table.

If the drafts look good → flip `posting.dry_run` to `false` in `config.yaml` and run again. The bot will now actually post, but no more than `daily_cap` per 24h, with `min_gap_minutes` between posts.

---

## Going live (when you're ready)

1. Edit `config.yaml`:
   ```yaml
   posting:
     dry_run: false
     daily_cap: 1     # start very low
     min_gap_minutes: 180
   ```
2. Re-run `python -m src.main`.
3. **Open your profile in incognito** after each posted comment and confirm the comment is visible. If it's not → you're shadowbanned and need to pause / appeal / use a different account.

---

## Scheduling (run automatically every few hours)

Once you're comfortable, schedule it via Windows Task Scheduler:

1. Win + R → `taskschd.msc`.
2. Create Basic Task → Trigger: every 3 hours.
3. Action: Start a program.
   - Program: `C:\Users\asus\reddit-comment-bot\.venv\Scripts\python.exe`
   - Arguments: `-m src.main`
   - Start in: `C:\Users\asus\reddit-comment-bot`

The bot's internal daily-cap + min-gap logic will prevent over-posting even if the scheduler fires often.

---

## Project layout

```
reddit-comment-bot/
├── README.md            <- you are here
├── requirements.txt     <- Python packages
├── config.yaml          <- tunables (subs, caps, persona, etc.)
├── .env.example         <- copy to .env and fill in
├── data/
│   ├── state.db         <- sqlite: seen posts, drafts, what was commented
│   └── browser_profile/ <- persistent Chrome profile (cookies, login)
├── logs/
│   └── bot.log          <- rotating log file
└── src/
    ├── main.py          <- orchestrator (run this)
    ├── config.py        <- loads .env + config.yaml
    ├── browser.py       <- Playwright + login + human-like input
    ├── discover.py      <- fetches and filters posts via Reddit JSON
    ├── analyzer.py      <- OpenAI: score relevance + draft comment
    ├── poster.py        <- types and submits the comment
    ├── db.py            <- sqlite state
    └── logger.py        <- logging setup
```

---

## When you're ready to add a product link (later)

Don't do this until you have an aged account (>30 days, >100 comment karma, no removed comments). Then:

1. Add to `config.yaml`:
   ```yaml
   product:
     enabled: true
     name: "YourProductName"
     url: "https://your-domain.com"
     # Only mention in ~30% of comments, only when truly relevant
     mention_probability: 0.3
   ```
2. Update `analyzer.py` system prompt to allow mentioning the product when contextually appropriate.
3. Strongly prefer "link in bio" phrasing over pasting raw URLs.

I (the assistant) can wire this up for you in a follow-up once you've reached that stage.

---

## Troubleshooting

- **"Missing required environment variable"** → you didn't create `.env` or didn't fill it in. See `Configure` above.
- **Login times out** → run with `browser.headless: false`, watch the window, solve any captcha. If you have 2FA enabled on Reddit, disable it for this account (or message me to add 2FA handling).
- **"Session expired"** → delete the `data/browser_profile/` folder and run again to force a fresh login.
- **No candidate posts** → loosen filters in `config.yaml`: lower `min_body_chars`, increase `max_age_hours`, or clear `keywords`.
- **AI keeps refusing to draft a comment** → the model is being cautious. Lower `ai.min_relevance_score` from 7 to 6 to see more drafts.
- **Shadowbanned** → stop the bot. Check `r/ShadowBan` for how to verify. Usually means the account is too new or the comments looked too template-y. Start over with a different, slower-aged account.
