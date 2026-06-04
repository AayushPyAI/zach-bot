"""Loads config.yaml + .env into a single typed object."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List

import yaml
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class DiscoveryCfg:
    sort: str = "new"
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
    min_gap_minutes: int = 90
    jitter_minutes: int = 45
    typing_cps_min: float = 3.0
    typing_cps_max: float = 6.0


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


def load_config() -> Config:
    load_dotenv(PROJECT_ROOT / ".env")

    cfg_path = PROJECT_ROOT / "config.yaml"
    with open(cfg_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    discovery = DiscoveryCfg(**(raw.get("discovery") or {}))
    ai = AICfg(**(raw.get("ai") or {}))
    posting = PostingCfg(**(raw.get("posting") or {}))
    browser = BrowserCfg(**(raw.get("browser") or {}))
    runtime = RuntimeCfg(**(raw.get("runtime") or {}))

    return Config(
        subreddits=[s.strip() for s in raw.get("subreddits", []) if s.strip()],
        discovery=discovery,
        ai=ai,
        posting=posting,
        browser=browser,
        runtime=runtime,
        reddit_username=_require_env("REDDIT_USERNAME"),
        reddit_password=_require_env("REDDIT_PASSWORD"),
        openai_api_key=_require_env("OPENAI_API_KEY"),
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip(),
    )
