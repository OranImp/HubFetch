"""Typed manifest models for the full auth-state capture matrix.

The ui-matrix manifest written by :mod:`capture` is validated back into typed
records by the visual QA gate; these models mirror the on-disk schema exactly
so a drift between writer and verifier is caught at parse time.
"""

from __future__ import annotations

from typing import ClassVar, Final

from pydantic import BaseModel, ConfigDict

__all__ = ["EntryModel", "ManifestModel", "ManifestName"]

ManifestName: Final[str] = "ui-matrix-manifest.json"
"""Manifest file written beside the captured PNG matrix."""


class EntryModel(BaseModel):
    """Typed schema mirroring one manifest entry record."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)

    file: str
    state: str
    theme: str
    width_effective: int
    scale_percent: int
    locale: str
    reduced_motion: bool
    pixel_width: int
    pixel_height: int
    sha256: str
    non_blank: bool


class ManifestModel(BaseModel):
    """Typed schema mirroring the ui-matrix manifest."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)

    mode: str
    spec_count: int
    states: list[str]
    widths: list[int]
    scales: list[int]
    themes: list[str]
    locales: list[str]
    entries: list[EntryModel]
