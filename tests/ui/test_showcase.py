"""Deterministic showcase composition, reflow, and capture-matrix contracts.

Asserts DESIGN.md Sections 8.2/11/12: the showcase reflows at the three
effective-pixel breakpoints, renders every primitive section without emoji or
color-only status, carries the long bilingual/URL/path stress fixtures, and the
capture harness writes a named PNG matrix plus a validated manifest.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QAbstractButton, QApplication, QLabel

from hubfetch.domain.lifecycle import TransferStage
from hubfetch.ui import capture, fixtures, showcase, style, tokens
from hubfetch.ui import focus as ui_focus
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.stage_rail import StageReport, StageStatus, TransferStageRail

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

EMOJI_RANGES = ((0x2190, 0x2BFF), (0x1F000, 0x1FAFF))
EXPECTED_WIDTHS = (759, 960, 1280)


def test_showcase_reflows_by_breakpoint(qtbot: QtBot) -> None:
    window = showcase.ShowcaseWindow()
    qtbot.addWidget(window)
    window.set_effective_width(759)
    assert window.column_count() == 1
    window.set_effective_width(960)
    assert window.column_count() == 2
    window.set_effective_width(1280)
    assert window.column_count() >= 3


def test_showcase_covers_every_primitive_section(qtbot: QtBot) -> None:
    window = showcase.ShowcaseWindow()
    qtbot.addWidget(window)
    titles = " ".join(window.section_titles())
    for primitive in (
        "导航",
        "按钮",
        "分段",
        "开关",
        "输入",
        "仓库类型",
        "进度",
        "状态",
        "任务行",
        "占位",
        "阶段",
        "日志",
        "对话框",
        "焦点",
    ):
        assert primitive in titles, primitive


def test_showcase_text_never_uses_emoji_and_keeps_stress_fixtures(
    qtbot: QtBot,
) -> None:
    window = showcase.ShowcaseWindow()
    qtbot.addWidget(window)
    widgets: tuple[QLabel, ...] = tuple(window.findChildren(QLabel))
    buttons: tuple[QAbstractButton, ...] = tuple(window.findChildren(QAbstractButton))
    texts = [label.text() for label in widgets] + [button.text() for button in buttons]
    texts.extend(button.toolTip() for button in buttons)
    assert (
        fixtures.LONG_REPO_ID in texts or window.repo_fixture() == fixtures.LONG_REPO_ID
    )
    assert len(fixtures.LONG_REPO_ID) >= 200
    assert " " not in fixtures.LONG_REVISION
    assert len(fixtures.LONG_REVISION) >= 128
    assert " " not in fixtures.LONG_PATH
    assert fixtures.LONG_CHINESE_LABEL in texts
    assert fixtures.LONG_ENGLISH_LABEL in texts
    for text in texts:
        for code_point in text:
            for low, high in EMOJI_RANGES:
                assert not low <= ord(code_point) <= high, hex(ord(code_point))


def test_capture_matrix_covers_required_combinations() -> None:
    matrix = capture.showcase_matrix()
    assert len(matrix) == 24
    themes = {spec.theme for spec in matrix}
    assert themes == {style.Theme.LIGHT, style.Theme.DARK, style.Theme.HIGH_CONTRAST}
    for width in EXPECTED_WIDTHS:
        for scale in (100, 200):
            assert any(
                spec.width == width
                and spec.scale_percent == scale
                and not spec.reduced_motion
                for spec in matrix
            )
    assert any(spec.reduced_motion for spec in matrix)
    names = {spec.png_name() for spec in matrix}
    assert len(names) == len(matrix)


def test_capture_writes_manifest_with_nonblank_pngs(
    qtbot: QtBot, tmp_path: Path
) -> None:
    _ = qtbot  # fixture guarantees a QApplication exists for offscreen rendering
    report = capture.run_matrix(tmp_path, capture.showcase_matrix())
    assert report.manifest_path.name == "showcase-manifest.json"
    assert report.manifest_path.is_file()
    assert len(report.entries) == 24
    for entry in report.entries:
        assert entry.non_blank, entry.file
        assert entry.pixel_width == entry.width_effective * entry.scale_percent / 100
        assert (tmp_path / entry.file).is_file()


def test_capture_is_deterministic_for_identical_spec(
    qtbot: QtBot, tmp_path: Path
) -> None:
    _ = qtbot  # fixture guarantees a QApplication exists for offscreen rendering
    spec = capture.CaptureSpec(
        theme=style.Theme.LIGHT, width=960, scale_percent=100, reduced_motion=False
    )
    first = capture.run_matrix(tmp_path / "run-a", (spec,))
    second = capture.run_matrix(tmp_path / "run-b", (spec,))
    assert first.entries[0].sha256 == second.entries[0].sha256


def test_showcase_request_detection(qapp: QApplication) -> None:
    _ = qapp  # fixture guarantees a QApplication exists for the showcase hook
    assert showcase.is_showcase_request(("HubFetch.exe", "--showcase"))
    assert not showcase.is_showcase_request(("HubFetch.exe", "--smoke-test"))
    assert tokens.MotionPreference.REDUCED.value == "reduced"


def test_focus_ring_paints_action_blue_under_keyboard_focus(
    qapp: QApplication, qtbot: QtBot
) -> None:
    # Given the ring proxy installed, When keyboard-focused, Then blue ring paints.
    ui_focus.install_focus_ring(qapp.style())
    button = ActionButton("焦点示例")
    qtbot.addWidget(button)
    button.resize(160, tokens.CONTROL_HEIGHT)
    button.show()
    button.setFocus(Qt.FocusReason.TabFocusReason)
    qapp.processEvents()
    image = button.grab().toImage()
    target = QColor(tokens.ACTION_BLUE)
    hits = sum(
        1
        for y in range(image.height())
        for x in range(image.width())
        if abs(image.pixelColor(x, y).red() - target.red()) <= 48
        and abs(image.pixelColor(x, y).green() - target.green()) <= 48
        and abs(image.pixelColor(x, y).blue() - target.blue()) <= 48
    )
    assert hits >= 16


def test_stage_rail_pulse_underline_is_visible(qtbot: QtBot) -> None:
    # Given an active stage, Then the segment carries a visible pulse underline.
    rail = TransferStageRail({stage: stage.value for stage in TransferStage})
    qtbot.addWidget(rail)
    rail.set_reports(
        (
            StageReport(TransferStage.RESOLVE, StageStatus.DONE),
            StageReport(TransferStage.TRANSFER, StageStatus.ACTIVE),
        )
    )
    active = rail.active_segment()
    assert active is not None
    sheet = active.styleSheet()
    assert "border-bottom" in sheet
    highlight = rail.palette().color(QPalette.ColorRole.Highlight).name()
    assert highlight in sheet


def test_showcase_demos_keyboard_focus(qtbot: QtBot) -> None:
    window = showcase.ShowcaseWindow()
    qtbot.addWidget(window)
    window.demo_keyboard_focus()
    assert window.focusWidget() is not None
