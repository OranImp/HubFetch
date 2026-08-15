"""The transfer-stage rail: the single custom expressive control.

The rail renders the fixed transfer stages (resolve, authorize, transfer,
verify, materialize/checkout mapped onto the domain stage enum) with an icon,
label, and status per stage. It is the one place the design allows restrained
expression: the active segment pulses (DESIGN.md 7.1). Under reduced motion the
pulse is disabled and progress stays readable as static text and geometry
(DESIGN.md 7.2). Status is never color-only: every stage exposes accessible
text naming the stage and its status.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING

from PySide6.QtCore import QTimer
from PySide6.QtGui import QPalette
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.labels import CaptionLabel

if TYPE_CHECKING:
    from hubfetch.domain.lifecycle import TransferStage

_ACTIVE_PULSE_STEP_MS: int = tokens.ACTIVE_PULSE_MS


@unique
class StageStatus(StrEnum):
    """Rendering status for one stage segment."""

    PENDING = "pending"
    ACTIVE = "active"
    DONE = "done"
    SKIPPED = "skipped"
    FAILED = "failed"


_STATUS_ICONS: dict[StageStatus, icons.IconName] = {
    StageStatus.PENDING: icons.IconName.CLOCK,
    StageStatus.ACTIVE: icons.IconName.LOADER_CIRCLE,
    StageStatus.DONE: icons.IconName.CIRCLE_CHECK,
    StageStatus.SKIPPED: icons.IconName.CIRCLE_PAUSE,
    StageStatus.FAILED: icons.IconName.TRIANGLE_ALERT,
}

_STATUS_TEXT: dict[StageStatus, str] = {
    StageStatus.PENDING: "等待",
    StageStatus.ACTIVE: "进行中",
    StageStatus.DONE: "完成",
    StageStatus.SKIPPED: "跳过",
    StageStatus.FAILED: "失败",
}


@dataclass(frozen=True, slots=True)
class StageReport:
    """The status of one transfer stage at a moment in time."""

    stage: TransferStage
    status: StageStatus


class TransferStageRail(QWidget):
    """A horizontal rail of stage segments with an optional active pulse."""

    def __init__(self, labels: dict[TransferStage, str]) -> None:
        """Build one segment per report; labels map stage to visible text."""
        super().__init__()
        self._labels: dict[TransferStage, str] = dict(labels)
        self._reports: list[StageReport] = []
        self._segments: dict[TransferStage, QWidget] = {}
        self._status: dict[TransferStage, StageStatus] = {}
        self._motion: tokens.MotionPreference = tokens.MotionPreference.FULL
        self._pulse_timer: QTimer = QTimer(self)
        self._pulse_timer.setInterval(_ACTIVE_PULSE_STEP_MS)
        self._pulse_timer.timeout.connect(self._on_pulse_tick)
        self._pulse_on: bool = True
        self._layout: QHBoxLayout = QHBoxLayout(self)
        self._layout.setContentsMargins(0, tokens.SPACE_SM, 0, tokens.SPACE_SM)
        self._layout.setSpacing(tokens.SPACE_SM)
        self._layout.addStretch(1)
        self.setMinimumWidth(tokens.RAIL_MIN_WIDTH)
        self.setAccessibleName("传输阶段")

    def set_reports(self, reports: tuple[StageReport, ...]) -> None:
        """Replace the rendered segments with one per supplied report."""
        self._clear_segments()
        self._reports = list(reports)
        for report in reports:
            self._status[report.stage] = report.status
            segment = self._build_segment(report)
            self._segments[report.stage] = segment
            self._layout.insertWidget(self._layout.count() - 1, segment)
        self._sync_pulse()

    def set_motion_preference(self, motion: tokens.MotionPreference) -> None:
        """Enable or disable the active-segment pulse animation."""
        self._motion = motion
        self._sync_pulse()

    def pulse_active(self) -> bool:
        """Return whether the active pulse is currently animating."""
        return self._pulse_timer.isActive()

    def freeze_pulse(self) -> None:
        """Halt the pulse at a fixed emphasis frame for deterministic capture."""
        self._pulse_timer.stop()
        self._pulse_on = True
        self._apply_pulse_visual()

    def accessible_stage_texts(self) -> list[str]:
        """Return one accessible text per report naming stage and status."""
        texts: list[str] = []
        for report in self._reports:
            label = self._labels.get(report.stage, report.stage.value)
            status_text = _STATUS_TEXT[report.status]
            texts.append(f"{label} · {status_text}")
        return texts

    def stage_icon_name(self, stage: TransferStage) -> icons.IconName:
        """Return the glyph currently rendered for one stage's status."""
        status = self._status.get(stage, StageStatus.PENDING)
        return _STATUS_ICONS[status]

    def _build_segment(self, report: StageReport) -> QWidget:
        segment = QWidget(self)
        layout = QVBoxLayout(segment)
        layout.setContentsMargins(
            tokens.SPACE_SM, tokens.SPACE_XS, tokens.SPACE_SM, tokens.SPACE_XS
        )
        layout.setSpacing(tokens.SPACE_XS)
        status = report.status
        glyph = QLabel(segment)
        glyph.setPixmap(
            icons.icon(
                _STATUS_ICONS[status],
                self.palette().text().color(),
                tokens.ICON_COMMAND,
            ).pixmap(tokens.ICON_COMMAND, tokens.ICON_COMMAND)
        )
        label_text = self._labels.get(report.stage, report.stage.value)
        label = QLabel(label_text, segment)
        caption = CaptionLabel(_STATUS_TEXT[status], segment)
        layout.addWidget(glyph)
        layout.addWidget(label)
        layout.addWidget(caption)
        segment.setAccessibleName(f"{label_text} {_STATUS_TEXT[status]}")
        return segment

    def _clear_segments(self) -> None:
        for segment in self._segments.values():
            self._layout.removeWidget(segment)
            segment.deleteLater()
        self._segments.clear()
        self._status.clear()

    def _has_active_stage(self) -> bool:
        return any(report.status is StageStatus.ACTIVE for report in self._reports)

    def _sync_pulse(self) -> None:
        should_pulse = (
            self._motion is tokens.MotionPreference.FULL and self._has_active_stage()
        )
        if should_pulse and not self._pulse_timer.isActive():
            self._pulse_timer.start()
        elif not should_pulse and self._pulse_timer.isActive():
            self._pulse_timer.stop()
        self._apply_pulse_visual()

    def _active_segment(self) -> QWidget | None:
        for report in self._reports:
            if report.status is StageStatus.ACTIVE:
                return self._segments.get(report.stage)
        return None

    def active_segment(self) -> QWidget | None:
        """Expose the currently active stage segment for state assertions."""
        return self._active_segment()

    def _apply_pulse_visual(self) -> None:
        """Emphasize the active segment with an underline that the pulse toggles.

        The pulse alternates the underline between the palette highlight and the
        neutral border color (DESIGN.md 7.1); under reduced motion the timer is
        stopped and the highlight frame stays static (DESIGN.md 7.2), so the
        active stage is always legible by shape and color pair, never color alone.
        """
        segment = self._active_segment()
        if segment is None:
            return
        highlight = self.palette().color(QPalette.ColorRole.Highlight).name()
        muted = common.semantic_colors(self.palette()).border
        underline = highlight if self._pulse_on else muted
        segment.setStyleSheet(
            f"background: transparent; border-bottom: 2px solid {underline};"
        )
        segment.update()

    def _on_pulse_tick(self) -> None:
        self._pulse_on = not self._pulse_on
        self._apply_pulse_visual()


__all__ = ["StageReport", "StageStatus", "TransferStageRail"]
