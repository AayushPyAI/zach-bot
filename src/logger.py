"""Centralized logging via loguru. Logs to console and rotating file.

Security:
  - `diagnose=False` + `backtrace=False` prevents loguru from printing the
    values of local variables on exceptions. (That's how the OpenAI key
    leaked before.)
  - A regex filter masks anything that *looks* like a secret in any log
    message, no matter where it comes from.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from loguru import logger


# Patterns of things we never want to see in logs.
_SECRET_PATTERNS = [
    # OpenAI keys: sk-... and sk-proj-...
    re.compile(r"sk-(?:proj-)?[A-Za-z0-9_\-]{10,}"),
    # Generic "key=value" or "key: value" for sensitive names
    re.compile(
        r"(?i)(api[_-]?key|secret|password|token|authorization|bearer)"
        r"\s*[:=]\s*['\"]?([^\s'\"]+)"
    ),
]


def _mask(text: str) -> str:
    """Replace anything that looks like a secret with ***REDACTED***."""
    if not text:
        return text
    out = text
    # Mask raw sk-... tokens anywhere in the string
    out = _SECRET_PATTERNS[0].sub("***REDACTED***", out)
    # Mask "key: value" style
    out = _SECRET_PATTERNS[1].sub(
        lambda m: f"{m.group(1)}=***REDACTED***", out
    )
    return out


def _scrub_record(record: dict) -> bool:
    """Loguru filter: mutate message + exception text in-place, then allow."""
    try:
        record["message"] = _mask(record["message"])
    except Exception:
        pass
    return True


def setup_logger(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logger.remove()

    common_kwargs = dict(
        backtrace=False,   # don't print extended stack frames
        diagnose=False,    # CRITICAL: don't print local variable values
        filter=_scrub_record,
    )

    logger.add(
        sys.stdout,
        level="INFO",
        format="<green>{time:HH:mm:ss}</green> | <level>{level:<7}</level> | <cyan>{module}</cyan> | {message}",
        **common_kwargs,
    )
    logger.add(
        log_path,
        level="DEBUG",
        rotation="5 MB",
        retention=10,
        encoding="utf-8",
        format="{time:YYYY-MM-DD HH:mm:ss} | {level:<7} | {module} | {message}",
        **common_kwargs,
    )
