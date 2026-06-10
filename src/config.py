"""Loads config.yaml + .env into a single typed object."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import List

import yaml
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class DiscoveryCfg:
    sort: str = "new"
    # If non-empty, a sort is chosen RANDOMLY from this list per subreddit
    # each run (looks less robotic than always using the same tab).
    sort_rotation: List[str] = field(default_factory=lambda: ["new", "hot", "rising"])
    # If true, the order subreddits are visited is shuffled each run.
    shuffle_subreddits: bool = True
    posts_per_subreddit: int = 15
    max_age_hours: int = 12
    min_age_minutes: int = 15
    min_body_chars: int = 200
    keywords: List[str] = field(default_factory=list)
    # When true, navigate the visible browser to each subreddit and scroll
    # like a human BEFORE pulling posts (you can watch it work). Slower.
    visual_mode: bool = False
    # When true (and visual_mode true), also open each candidate post in the
    # browser so you can see the bot "reading" before commenting. Slowest.
    visual_open_posts: bool = False

    def pick_sort(self) -> str:
        import random as _r

        if self.sort_rotation:
            return _r.choice(self.sort_rotation)
        return self.sort or "new"


@dataclass
class AICfg:
    min_relevance_score: int = 7
    min_comment_chars: int = 120
    max_comment_chars: int = 600
    persona: str = ""


@dataclass
class PostingCfg:
    dry_run: bool = True
    daily_cap: int = 2
    # Base gap between comments is a RANDOM value in this range (minutes).
    min_gap_min_minutes: int = 120
    min_gap_max_minutes: int = 300
    # Extra random delay added on top of the base gap (minutes).
    jitter_minutes: int = 45
    # Back-compat: old single-value field. If the range fields above are
    # left at defaults but this is set, it's used as the lower bound.
    min_gap_minutes: int = 0
    typing_cps_min: float = 3.0
    typing_cps_max: float = 6.0
    # true  = comment on old.reddit.com (most reliable for automation)
    # false = comment on www.reddit.com (more human-realistic)
    use_old_reddit: bool = True
    # If new-reddit posting fails, retry on old.reddit (only when use_old_reddit: false)
    fallback_to_old_reddit: bool = True

    def pick_gap_minutes(self) -> float:
        """Random base gap in [min, max], guaranteeing min <= max."""
        import random as _r

        lo = self.min_gap_min_minutes
        hi = self.min_gap_max_minutes
        # Honor a legacy min_gap_minutes if someone still sets it.
        if self.min_gap_minutes and self.min_gap_minutes > lo:
            lo = self.min_gap_minutes
        if hi < lo:
            hi = lo
        return _r.uniform(lo, hi)

    @property
    def enforce_gap_minutes(self) -> int:
        """Hard floor used to decide eligibility (never post closer than this)."""
        lo = self.min_gap_min_minutes
        if self.min_gap_minutes and self.min_gap_minutes > 0:
            lo = min(lo, self.min_gap_minutes) if lo else self.min_gap_minutes
        return lo


@dataclass
class HumanizeCfg:
    # --- session behavior mix (looks human, not just commenting) ---
    enabled: bool = True
    # Casually browse unrelated subs at the start of a session.
    lurk_probability: float = 0.6
    lurk_subreddits: List[str] = field(
        default_factory=lambda: ["news", "todayilearned", "mildlyinteresting", "AskReddit"]
    )
    lurk_min: int = 1
    lurk_max: int = 2
    # Upvote things while reading (post pages / feeds).
    upvote_probability: float = 0.45
    # Even when a draft is good, sometimes just read the post and move on.
    skip_good_post_probability: float = 0.15
    # --- day/hour level cadence ---
    # Random chance the whole run does nothing (humans aren't daily-consistent).
    skip_day_probability: float = 0.15
    # Only operate between these local hours [start, end). Empty = any time.
    active_hours: List[int] = field(default_factory=lambda: [8, 23])
    # Don't comment in the same subreddit more than once within this many minutes.
    per_subreddit_cooldown_minutes: int = 360


@dataclass
class BrowserCfg:
    headless: bool = False
    user_data_dir: str = "data/browser_profile"
    user_agent: str = ""


@dataclass
class RuntimeCfg:
    db_path: str = "data/state.db"
    log_path: str = "logs/bot.log"


@dataclass
class Config:
    subreddits: List[str]
    discovery: DiscoveryCfg
    ai: AICfg
    posting: PostingCfg
    humanize: HumanizeCfg
    browser: BrowserCfg
    runtime: RuntimeCfg

    reddit_username: str
    reddit_password: str
    openai_api_key: str
    openai_model: str

    @property
    def db_path_abs(self) -> Path:
        return PROJECT_ROOT / self.runtime.db_path

    @property
    def log_path_abs(self) -> Path:
        return PROJECT_ROOT / self.runtime.log_path

    @property
    def user_data_dir_abs(self) -> Path:
        return PROJECT_ROOT / self.browser.user_data_dir


def _require_env(name: str) -> str:
    val = os.getenv(name, "").strip()
    if not val:
        raise SystemExit(
            f"Missing required environment variable: {name}. "
            f"Copy .env.example to .env and fill it in."
        )
    return val


def _build(cls, data):
    """Construct a dataclass from a dict, ignoring unknown keys so adding new
    config options never crashes older code (and vice-versa)."""
    data = data or {}
    valid = {f.name for f in fields(cls)}
    filtered = {k: v for k, v in data.items() if k in valid}
    return cls(**filtered)


def load_config() -> Config:
    load_dotenv(PROJECT_ROOT / ".env")

    cfg_path = PROJECT_ROOT / "config.yaml"
    with open(cfg_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    discovery = _build(DiscoveryCfg, raw.get("discovery"))
    ai = _build(AICfg, raw.get("ai"))
    posting = _build(PostingCfg, raw.get("posting"))
    humanize = _build(HumanizeCfg, raw.get("humanize"))
    browser = _build(BrowserCfg, raw.get("browser"))
    runtime = _build(RuntimeCfg, raw.get("runtime"))

    return Config(
        subreddits=[s.strip() for s in raw.get("subreddits", []) if s.strip()],
        discovery=discovery,
        ai=ai,
        posting=posting,
        humanize=humanize,
        browser=browser,
        runtime=runtime,
        reddit_username=_require_env("REDDIT_USERNAME"),
        reddit_password=_require_env("REDDIT_PASSWORD"),
        openai_api_key=_require_env("OPENAI_API_KEY"),
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip(),
    )
