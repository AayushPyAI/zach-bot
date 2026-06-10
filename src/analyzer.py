"""OpenAI-powered relevance scoring + comment drafting.

The model returns strict JSON so we can trust the output. The system prompt is
locked down so the bot never:
  - Claims to be an AI
  - Includes URLs / product names
  - Writes anything weird that would obviously flag as bot output

This module is link-free by design. Adding product links should be done LATER
(once the account has karma) by extending the prompt + a post-processing step.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Optional

from loguru import logger
from openai import OpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from .config import AICfg
from .discover import Post


# Rotating style hints so every comment doesn't share the same fingerprint.
# One is injected at random per comment.
_STYLE_HINTS = [
    "Write it as one short flowing paragraph.",
    "Lead with the single most important point, then one quick caveat.",
    "Keep it casual and brief, like a quick reply between tasks.",
    "Ask a short clarifying question first, then give your take.",
    "Share it as 'what I'd do in your shoes' without being preachy.",
    "Be direct and a little blunt, but still helpful.",
    "Mention one practical next step they can take this week.",
    "Acknowledge the hard part in a sentence, then give the tip.",
]

# Rotating length targets (chars) within the configured min/max, so replies
# vary in size rather than all hugging the same length.
def _pick_length_window(min_chars: int, max_chars: int) -> tuple[int, int]:
    span = max(40, max_chars - min_chars)
    lo = min_chars + random.randint(0, span // 2)
    hi = min(max_chars, lo + random.randint(span // 3, span))
    return lo, hi


@dataclass
class Analysis:
    relevance: int         # 0-10
    reason: str            # short, one-line, why we scored it that way
    comment: Optional[str] # None if we shouldn't comment


SYSTEM_TEMPLATE = """{persona}

You will be given a Reddit post. Decide two things, in this order:

1. RELEVANCE (0-10): How well-suited is this post for a genuinely helpful
   comment from someone like you? Score generously high (>=7) only when:
   - The poster is asking a real question (not just venting).
   - You have specific, actionable advice to offer.
   - The post is not already deeply answered by obvious common knowledge.
   - The post is not a sensitive personal crisis (suicide, abuse, etc.) -
     those score 0 because automated replies are inappropriate.

2. COMMENT (only if RELEVANCE >= 7): Write a SHORT, sharp reply that:
   - Is between {min_chars} and {max_chars} characters. Aim near the LOW end.
   - Is 2-4 sentences maximum. No walls of text.
   - Sounds like a human Redditor (lowercase ok, no markdown, no emojis).
   - Gives ONE concrete piece of advice tied to THIS post (skip generic tips).
   - Does NOT include URLs, brand names, product names, or "DM me".
   - Does NOT claim to be a professional. Suggest a lawyer ONLY if truly needed.
   - Does NOT start with "Great question", "I'm sorry to hear", or any
     sycophantic / corporate / AI-cliche opener.
   - Does NOT use the word "navigate", "ensure", "meticulously", "moreover",
     or "it's important to". Cut filler.

Return STRICT JSON only, matching exactly:
{{
  "relevance": <int 0-10>,
  "reason": "<one short sentence>",
  "comment": "<string or empty string if relevance < 7>"
}}
"""


class Analyzer:
    def __init__(self, api_key: str, model: str, cfg: AICfg):
        self.client = OpenAI(api_key=api_key, timeout=90.0, max_retries=2)
        self.model = model
        self.cfg = cfg
        self.system_prompt = SYSTEM_TEMPLATE.format(
            persona=cfg.persona.strip(),
            min_chars=cfg.min_comment_chars,
            max_chars=cfg.max_comment_chars,
        )

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=20))
    def _call(self, user_msg: str, temperature: float) -> dict:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_msg},
            ],
        )
        content = resp.choices[0].message.content or "{}"
        return json.loads(content)

    def analyze(self, post: Post) -> Analysis:
        # Per-comment variety: random style hint, length window, and temperature
        # so the account's comment history doesn't share a single fingerprint.
        style = random.choice(_STYLE_HINTS)
        lo, hi = _pick_length_window(self.cfg.min_comment_chars, self.cfg.max_comment_chars)
        temperature = round(random.uniform(0.6, 0.95), 2)

        user_msg = (
            f"Subreddit: r/{post.subreddit}\n"
            f"Title: {post.title}\n\n"
            f"Body:\n{post.body[:4000]}\n\n"
            f"Style for THIS reply: {style}\n"
            f"Target length for THIS reply: roughly {lo}-{hi} characters."
        )
        try:
            data = self._call(user_msg, temperature)
        except Exception as e:
            logger.error("AI call failed for post {}: {}", post.id, e)
            return Analysis(relevance=0, reason=f"AI error: {e}", comment=None)

        try:
            relevance = int(data.get("relevance", 0))
        except Exception:
            relevance = 0
        reason = str(data.get("reason") or "").strip()[:300]
        raw_comment = str(data.get("comment") or "").strip()

        # Enforce length + safety post-conditions
        if relevance < self.cfg.min_relevance_score:
            return Analysis(relevance=relevance, reason=reason, comment=None)

        if len(raw_comment) < self.cfg.min_comment_chars:
            return Analysis(
                relevance=relevance,
                reason=f"{reason} | rejected: comment too short ({len(raw_comment)} chars)",
                comment=None,
            )
        if len(raw_comment) > self.cfg.max_comment_chars:
            raw_comment = raw_comment[: self.cfg.max_comment_chars].rsplit(" ", 1)[0] + "."

        # Hard safety filters: no URLs, no @mentions, no "I am an AI"
        lowered = raw_comment.lower()
        if "http://" in lowered or "https://" in lowered or "www." in lowered:
            return Analysis(relevance=relevance, reason=f"{reason} | rejected: URL in draft", comment=None)
        if "as an ai" in lowered or "i am an ai" in lowered or "language model" in lowered:
            return Analysis(relevance=relevance, reason=f"{reason} | rejected: AI tell", comment=None)

        return Analysis(relevance=relevance, reason=reason, comment=raw_comment)
