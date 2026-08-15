"""Long-content stress fixtures for the showcase and capture matrix.

DESIGN.md Section 4 requires every content fixture set to include long Chinese
and English labels, unbroken URLs, long repository/revision paths, and 200%
scaling so the primitives prove they reflow instead of clipping. These values
deliberately exceed realistic lengths: a 300-character repository id, a 128
hex-character revision with no separators, and a CJK destination path with no
spaces. None of them contain emoji or reserved control ranges.
"""

from __future__ import annotations

from typing import Final

_LONG_REPO_STEM: Final[str] = (
    "huggingface-hub-manager/very-long-organization-repository-identifier-"
    "that-keeps-growing-to-stress-elision-and-row-geometry-contracts-"
    "model-dataset-space-"
)
LONG_REPO_ID: Final[str] = _LONG_REPO_STEM + "0123456789abcdef" * 5
"""A 200+ character repository identifier with no whitespace."""

LONG_REVISION: Final[str] = "9f8e7d6c5b4a3928" * 9
"""A 128+ character unbroken revision hash (no spaces, no separators)."""

LONG_PATH: Final[str] = (
    "E:\\" + "深层缓存目录" * 18 + "\\hub\\models--snapshot\\model.safetensors"
)
"""A CJK destination path with no spaces, exercising long path fields."""

LONG_URL: Final[str] = (
    "https://huggingface.co/"
    + LONG_REPO_ID
    + "/resolve/"
    + LONG_REVISION
    + "/weights/pytorch_model-000128-of-000256.safetensors"
)
"""An unbroken long URL used to stress proxy/revision fields."""

LONG_CHINESE_LABEL: Final[str] = (
    "这是一个用于验证中文长标签换行与省略行为的超长说明文本" * 4
)
"""A long Simplified Chinese label for wrapping/elision stress."""

LONG_ENGLISH_LABEL: Final[str] = (
    "This is an intentionally verbose English caption used to verify that "
    "long labels wrap and elide without breaking row geometry."
)
"""A long English caption for wrapping/elision stress."""

_STAGE_LABELS_ZH: Final[dict[str, str]] = {
    "preflight": "预检",
    "authenticate": "鉴权",
    "resolve": "解析",
    "transfer": "传输",
    "materialize": "落盘",
    "finalize": "收尾",
}

LOG_LINES: Final[tuple[str, ...]] = (
    "[preflight] checking destination writability: ok",
    "[authenticate] using auth source: anonymous",
    "[resolve] resolved revision to commit 9f8e7d6c5b4a3928",
    "[transfer] 512 MB / 1.2 GB received, 12.4 MB/s",
    "[transfer] GET https://huggingface.co/api/models 200",
    "[materialize] writing snapshot to local directory",
)
"""Sanitized sample log excerpt lines with no secrets or emoji-range chars."""


def stage_label(value: str) -> str:
    """Return the display label for one transfer stage value."""
    return _STAGE_LABELS_ZH.get(value, value)


def all_fixtures() -> dict[str, str]:
    """Return every stress fixture keyed by a stable name for manifests."""
    return {
        "repo_id": LONG_REPO_ID,
        "revision": LONG_REVISION,
        "path": LONG_PATH,
        "url": LONG_URL,
        "zh_label": LONG_CHINESE_LABEL,
        "en_label": LONG_ENGLISH_LABEL,
    }


__all__ = [
    "LOG_LINES",
    "LONG_CHINESE_LABEL",
    "LONG_ENGLISH_LABEL",
    "LONG_PATH",
    "LONG_REPO_ID",
    "LONG_REVISION",
    "LONG_URL",
    "all_fixtures",
    "stage_label",
]
