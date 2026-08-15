"""Given/When/Then contracts for every Transfer Ledger UI primitive."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from PySide6.QtCore import Qt
from PySide6.QtGui import QPalette
from PySide6.QtWidgets import QApplication, QLabel

from hubfetch.domain.lifecycle import TransferStage
from hubfetch.ui import focus as ui_focus
from hubfetch.ui import fonts, icons, style, tokens
from hubfetch.ui.widgets.blocks import EmptyBlock, ErrorBlock, LoadingBlock
from hubfetch.ui.widgets.buttons import (
    ActionButton,
    IconButton,
    MissingAccessibleNameError,
)
from hubfetch.ui.widgets.dialog import Sheet
from hubfetch.ui.widgets.fields import PathField, ProxyField, RevisionField, TextField
from hubfetch.ui.widgets.log_excerpt import LogExcerpt
from hubfetch.ui.widgets.navigation import NAVIGATION_ITEM_HEIGHT, NavigationItem
from hubfetch.ui.widgets.progress import TransferProgressBar
from hubfetch.ui.widgets.segmented import Segment, SegmentedControl
from hubfetch.ui.widgets.selectors import RepositoryTypeChoice, RepositoryTypeSelector
from hubfetch.ui.widgets.stage_rail import StageReport, StageStatus, TransferStageRail
from hubfetch.ui.widgets.status import StatusPair, StatusSeverity
from hubfetch.ui.widgets.task_row import TASK_ROW_HEIGHT, TaskRow, TaskRowSnapshot
from hubfetch.ui.widgets.toggles import CheckboxField, ToggleField

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

LONG_REPO = "organization-with-a-very-long-name/" + "x" * 300
LONG_PATH = "E:\\" + "深" * 200 + "\\model.safetensors"


def test_tokens_match_design_contract() -> None:
    light = (tokens.INK, tokens.CANVAS, tokens.SURFACE, tokens.LINE)
    assert light == ("#202124", "#F7F8FA", "#FFFFFF", "#D9DEE7")
    assert (tokens.SIGNAL_YELLOW, tokens.ACTION_BLUE) == ("#FFD21E", "#2563EB")
    assert all(value % 4 == 0 for value in tokens.SPACING_SCALE)
    assert max(tokens.RADIUS_CONTROL, tokens.RADIUS_PANEL) <= 8
    assert (tokens.BREAKPOINT_MEDIUM, tokens.BREAKPOINT_WIDE) == (760, 1180)
    assert (
        tokens.FEEDBACK_MIN_MS <= 83 < tokens.ACTIVE_PULSE_MS <= tokens.FEEDBACK_MAX_MS
    )


def test_palettes_map_semantic_roles() -> None:
    light = style.build_light_palette()
    assert light.color(QPalette.ColorRole.Window).name() == tokens.CANVAS.lower()
    assert light.color(QPalette.ColorRole.Base).name() == tokens.SURFACE.lower()
    assert light.color(QPalette.ColorRole.Text).name() == tokens.INK.lower()
    dark = style.build_dark_palette()
    assert dark.color(QPalette.ColorRole.Text).lightness() > 200
    assert dark.color(QPalette.ColorRole.Window).lightness() < 60
    contrast = style.build_high_contrast_palette()
    assert contrast.color(QPalette.ColorRole.Base).name() == "#000000"
    assert contrast.color(QPalette.ColorRole.Text).name() == "#ffffff"
    assert contrast.color(QPalette.ColorRole.Highlight).name() != "#000000"
    assert contrast.color(QPalette.ColorRole.WindowText).name() == "#ffffff"


def test_icon_set_covers_bundled_lucide_files() -> None:
    names = tuple(icons.IconName)
    assert len(names) == 28
    for name in names:
        assert icons.icon_file_path(name).is_file()
    pixmap = icons.icon_pixmap(icons.IconName.CHECK, tokens.INK, 20)
    assert (pixmap.width(), pixmap.height()) == (20, 20)


def test_missing_icon_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Given the resource dir lacks the SVG, When rendering, Then a typed error.
    monkeypatch.setattr(icons, "ICONS_DIR", tmp_path)
    with pytest.raises(icons.IconLoadError, match="activity"):
        icons.icon_pixmap(icons.IconName.ACTIVITY, tokens.INK, 16)
    (tmp_path / "activity.svg").write_text("<svg not closed", encoding="utf-8")
    with pytest.raises(icons.IconLoadError):
        icons.icon(icons.IconName.ACTIVITY, tokens.INK, 16)


def test_bundled_mono_font_registers(qapp: QApplication) -> None:
    _ = qapp  # fixture ensures the QGuiApplication needed for font registration
    assert tokens.MONO_FONT in fonts.register_bundled_fonts()
    assert tokens.MONO_FONT_FALLBACK in fonts.mono_font().families()


def test_focus_ring_installs_and_names_widget(qapp: QApplication) -> None:
    ring = ui_focus.install_focus_ring(qapp.style())
    assert isinstance(ring, ui_focus.FocusRingStyle)
    label = QLabel()
    ui_focus.make_focusable(label, "焦点示例")
    assert label.focusPolicy() == Qt.FocusPolicy.StrongFocus
    assert label.accessibleName() == "焦点示例"


def test_icon_button_requires_accessible_name(qtbot: QtBot) -> None:
    # Given no accessible name, When constructing, Then a contract error.
    with pytest.raises(MissingAccessibleNameError):
        IconButton(icons.IconName.PLUS, accessible_name="")
    button = IconButton(icons.IconName.PLUS, accessible_name="新建任务")
    qtbot.addWidget(button)
    assert button.toolTip() == "新建任务"
    assert button.accessibleName() == "新建任务"
    assert button.minimumHeight() == tokens.CONTROL_HEIGHT


def test_action_button_states_explain_disable_and_loading(qtbot: QtBot) -> None:
    button = ActionButton("取消任务")
    qtbot.addWidget(button)
    button.set_disabled_reason("任务已完成后不可取消")
    assert not button.isEnabled()
    assert button.accessibleDescription() == "任务已完成后不可取消"
    button.set_loading(True)
    assert not button.isEnabled()
    button.set_loading(False)
    button.set_disabled_reason(None)
    assert button.isEnabled()


def test_navigation_item_geometry_and_selection(qtbot: QtBot) -> None:
    item = NavigationItem(icons.IconName.LIST_TODO, "任务")
    qtbot.addWidget(item)
    assert item.height() == NAVIGATION_ITEM_HEIGHT
    item.set_selected(True)
    assert item.isChecked()
    assert item.accessibleDescription() != ""


def test_segmented_control_keyboard_and_change_signal(qtbot: QtBot) -> None:
    segments = (
        Segment(key="file", label="单文件"),
        Segment(key="snapshot", label="快照"),
    )
    control = SegmentedControl("下载模式", segments)
    qtbot.addWidget(control)
    assert control.first_segment().focusPolicy() == Qt.FocusPolicy.StrongFocus
    received_keys: list[str] = []
    control.currentChanged.connect(received_keys.append)
    control.set_current("snapshot")
    assert received_keys == ["snapshot"]
    assert control.current_key() == "snapshot"


def test_toggle_fields_report_error_with_icon_and_text(qtbot: QtBot) -> None:
    for field in (
        CheckboxField("下载后校验文件", "校验 SHA256"),
        ToggleField("减少动画", "降低界面动效"),
    ):
        qtbot.addWidget(field)
        field.set_error("该选项与当前任务冲突")
        assert field.error_text() == "该选项与当前任务冲突"
        assert field.has_error_icon()
        field.set_error(None)
        assert field.error_text() is None


def test_text_fields_hold_geometry_and_error_state(qtbot: QtBot) -> None:
    pairs: tuple[tuple[TextField, bool], ...] = (
        (TextField("仓库 ID", placeholder="作者/名称"), False),
        (PathField("本地目录", placeholder="E:\\models"), True),
        (RevisionField("修订版本", placeholder="main"), True),
        (ProxyField("代理地址", placeholder="http://127.0.0.1:7897"), True),
    )
    for field, mono in pairs:
        qtbot.addWidget(field)
        assert field.input_height() == tokens.CONTROL_HEIGHT
        # When stressed with a long unbroken value, geometry must stay fixed.
        field.set_text(LONG_PATH if isinstance(field, PathField) else LONG_REPO)
        field.set_error("输入无法解析：修订版本不存在")  # noqa: RUF001 - CJK fixture
        shown_error = field.error_message()
        assert shown_error is not None
        assert "修订版本不存在" in shown_error
        assert "修订版本不存在" in field.editor().accessibleDescription()
        if mono:
            assert tokens.MONO_FONT in field.editor().font().families()
        field.set_error(None)
        assert field.error_message() is None


def test_disabled_field_keeps_accessible_explanation(qtbot: QtBot) -> None:
    field = TextField("目标目录")
    qtbot.addWidget(field)
    field.set_disabled_reason("仅在缓存模式下可编辑")
    assert not field.editor().isEnabled()
    assert field.editor().accessibleDescription() == "仅在缓存模式下可编辑"


def test_repository_type_selector_round_trip(qtbot: QtBot) -> None:
    selector = RepositoryTypeSelector("仓库类型")
    qtbot.addWidget(selector)
    assert selector.count() == 3
    selector.set_current_choice(RepositoryTypeChoice.DATASET)
    assert selector.current_choice() == RepositoryTypeChoice.DATASET


def test_progress_bar_reports_value_as_text(qtbot: QtBot) -> None:
    bar = TransferProgressBar("下载进度")
    qtbot.addWidget(bar)
    bar.set_progress(0.42, "512 MB / 1.2 GB · 12.4 MB/s")
    assert bar.bar_value_percent() == 42
    assert "42" in bar.caption_text()
    bar.set_busy("正在解析仓库清单…")
    assert bar.is_indeterminate()


def test_status_pairs_never_rely_on_color_alone(qtbot: QtBot) -> None:
    for severity in StatusSeverity:
        pair = StatusPair(severity, f"状态-{severity.value}")
        qtbot.addWidget(pair)
        assert pair.has_icon(), severity
        assert pair.text_label().text() == f"状态-{severity.value}"


def test_task_row_bounds_long_repo_ids(qtbot: QtBot) -> None:
    # Given a 336-char repo id, When bounded to 300 px, Then elision not growth.
    row = TaskRow()
    qtbot.addWidget(row)
    snapshot = TaskRowSnapshot(
        repo_id=LONG_REPO,
        kind_label="模型",
        status=StatusSeverity.ACTIVE,
        status_text="传输中",
        fraction=0.42,
        caption="第 2 位 · 模型快照下载",
    )
    row.set_snapshot(snapshot)
    row.setSelection(True)
    row.setFixedWidth(300)
    row.resize(300, row.height())
    row_layout = row.layout()
    assert row_layout is not None
    row_layout.activate()
    assert row.height() == TASK_ROW_HEIGHT
    assert row.repo_label().elided()
    assert row.repo_label().width() <= 300
    assert row.isSelected()


def test_stage_rail_texts_and_reduced_motion(qtbot: QtBot) -> None:
    labels = {stage: f"阶段-{stage.value}" for stage in TransferStage}
    rail = TransferStageRail(labels)
    qtbot.addWidget(rail)
    rail.set_reports(
        (
            StageReport(TransferStage.PREFLIGHT, StageStatus.DONE),
            StageReport(TransferStage.RESOLVE, StageStatus.ACTIVE),
            StageReport(TransferStage.TRANSFER, StageStatus.FAILED),
        )
    )
    texts = rail.accessible_stage_texts()
    assert len(texts) == 3
    assert "阶段-resolve" in texts[1]
    assert rail.stage_icon_name(TransferStage.TRANSFER) == icons.IconName.TRIANGLE_ALERT
    rail.set_motion_preference(tokens.MotionPreference.REDUCED)
    assert not rail.pulse_active()
    rail.set_motion_preference(tokens.MotionPreference.FULL)
    assert rail.pulse_active()


def test_blocks_cover_empty_loading_error_states(qtbot: QtBot) -> None:
    empty = EmptyBlock(
        "暂无任务", "从右上角新建下载或克隆任务", action_label="新建下载"
    )
    qtbot.addWidget(empty)
    assert empty.action_button() is not None
    loading = LoadingBlock("正在加载任务队列…", tokens.MotionPreference.REDUCED)
    qtbot.addWidget(loading)
    assert not loading.spinner_active()
    error = ErrorBlock("传输阶段失败：网络不可达", "检查代理设置后重试", "重试任务")  # noqa: RUF001
    qtbot.addWidget(error)
    fired: list[str] = []
    error.recovery_action().triggered.connect(lambda: fired.append("retry"))
    error.recovery_action().trigger()
    assert fired == ["retry"]


def test_log_excerpt_is_read_only_mono_and_bounded(qtbot: QtBot) -> None:
    excerpt = LogExcerpt("日志摘录")
    qtbot.addWidget(excerpt)
    excerpt.set_lines(["GET https://huggingface.co/api/models 200", "x" * 400])
    assert excerpt.editor().isReadOnly()
    assert tokens.MONO_FONT in excerpt.editor().font().families()
    assert excerpt.height() <= LogExcerpt.MAX_HEIGHT


def test_sheet_anatomy_has_title_close_and_ordered_footer(qtbot: QtBot) -> None:
    sheet = Sheet("新建下载任务")
    qtbot.addWidget(sheet)
    assert sheet.title_label().text() == "新建下载任务"
    assert sheet.close_button().accessibleName() != ""
    first = ActionButton("取消")
    second = ActionButton("确认并开始", primary=True)
    sheet.add_footer_action(first)
    sheet.add_footer_action(second)
    assert sheet.footer_actions() == [first, second]
