"""Section builders for the deterministic primitive showcase.

Each builder renders one DESIGN.md 6.1 primitive family in its required states
(default/disabled/error/loading/stress) using the long bilingual fixtures from
:mod:`hubfetch.ui.fixtures`. Animated widgets (stage rails, loading blocks) are
registered into caller-supplied lists so the showcase window can freeze every
animation at a deterministic frame before capture. Static builders take no
context so the module stays free of unused parameters.
"""

# ruff: noqa: RUF001 - intentional Simplified Chinese punctuation in UI fixtures.
from __future__ import annotations

from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from hubfetch.domain.lifecycle import TransferStage
from hubfetch.ui import fixtures, icons, tokens
from hubfetch.ui.widgets.blocks import EmptyBlock, ErrorBlock, LoadingBlock
from hubfetch.ui.widgets.buttons import ActionButton, IconButton
from hubfetch.ui.widgets.dialog import Sheet
from hubfetch.ui.widgets.fields import PathField, ProxyField, RevisionField, TextField
from hubfetch.ui.widgets.log_excerpt import LogExcerpt
from hubfetch.ui.widgets.navigation import NavigationItem
from hubfetch.ui.widgets.progress import TransferProgressBar
from hubfetch.ui.widgets.segmented import Segment, SegmentedControl
from hubfetch.ui.widgets.selectors import RepositoryTypeSelector
from hubfetch.ui.widgets.stage_rail import StageReport, StageStatus, TransferStageRail
from hubfetch.ui.widgets.status import InlineRecoveryAction, StatusPair, StatusSeverity
from hubfetch.ui.widgets.task_row import TaskRow, TaskRowSnapshot
from hubfetch.ui.widgets.toggles import CheckboxField, ToggleField


def _column(*widgets: QWidget) -> QWidget:
    box = QWidget()
    layout = QVBoxLayout(box)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(tokens.SPACE_XS)
    for widget in widgets:
        layout.addWidget(widget)
    layout.addStretch(1)
    return box


def _row(*widgets: QWidget) -> QWidget:
    box = QWidget()
    layout = QHBoxLayout(box)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(tokens.SPACE_XS)
    for widget in widgets:
        layout.addWidget(widget)
    layout.addStretch(1)
    return box


def _navigation() -> QWidget:
    tasks = NavigationItem(icons.IconName.LIST_TODO, "任务")
    tasks.set_selected(True)
    cache = NavigationItem(icons.IconName.DATABASE, "缓存")
    diagnostics = NavigationItem(icons.IconName.SQUARE_TERMINAL, "诊断")
    settings = NavigationItem(icons.IconName.SETTINGS, "设置")
    settings.setEnabled(False)
    settings.setAccessibleDescription("示例：禁用状态")
    return _column(tasks, cache, diagnostics, settings)


def _buttons() -> QWidget:
    busy = ActionButton("正在解析清单")
    busy.set_loading(loading=True, loading_text="正在解析仓库清单")
    blocked = ActionButton("重试任务")
    blocked.set_disabled_reason("任务正在传输，暂不可重试")
    icon_row = _row(
        IconButton(icons.IconName.PLUS, "新建任务"),
        IconButton(icons.IconName.ROTATE_CW, "刷新队列"),
        IconButton(icons.IconName.DOWNLOAD, "新建下载"),
        IconButton(icons.IconName.GIT_BRANCH, "新建克隆"),
    )
    return _column(
        _row(ActionButton("新建下载", primary=True), ActionButton("取消任务")),
        _row(busy, blocked),
        icon_row,
    )


def _segmented() -> QWidget:
    control = SegmentedControl(
        "下载模式",
        (
            Segment(key="file", label="单文件"),
            Segment(key="snapshot", label="快照"),
            Segment(key="clone", label="克隆"),
        ),
    )
    control.set_current("snapshot")
    return _column(control)


def _toggles() -> QWidget:
    verify = CheckboxField("下载后校验文件", "校验 SHA256 并写入清单")
    conflicted = CheckboxField("覆盖已有文件", "仅在下载模式可用")
    conflicted.set_error("该选项与克隆任务冲突")
    motion_toggle = ToggleField("减少动画", "停用脉冲与旋转效果")
    pinned = ToggleField("置顶窗口", "示例：禁用状态")
    pinned.box().setEnabled(False)
    pinned.box().setAccessibleDescription("示例：禁用状态")
    return _column(verify, conflicted, motion_toggle, pinned)


def _fields() -> QWidget:
    repo = TextField("仓库 ID", placeholder="作者/名称")
    repo.set_text(fixtures.LONG_REPO_ID)
    revision = RevisionField("修订版本", placeholder="main")
    revision.set_text(fixtures.LONG_REVISION)
    revision.set_error("输入无法解析：修订版本不存在")
    path = PathField("本地目录", placeholder="E:\\models")
    path.set_text(fixtures.LONG_PATH)
    proxy = ProxyField("代理地址", placeholder="http://127.0.0.1:7897")
    proxy.set_text("http://127.0.0.1:7897")
    locked = TextField("目标目录")
    locked.set_disabled_reason("仅在缓存模式下可编辑")
    return _column(repo, revision, path, proxy, locked)


def _selector() -> QWidget:
    return _column(RepositoryTypeSelector("仓库类型"))


def _progress() -> QWidget:
    bounded = TransferProgressBar("下载进度")
    bounded.set_progress(0.42, "512 MB / 1.2 GB · 12.4 MB/s")
    busy = TransferProgressBar("解析进度")
    busy.set_busy("正在解析仓库清单")
    return _column(bounded, busy)


def _status() -> QWidget:
    pairs = [StatusPair(severity, "示例状态文本") for severity in StatusSeverity]
    recovery = InlineRecoveryAction("代理连接失败：检查代理地址后重试", "重试任务")
    return _column(*pairs, recovery)


def _task_row_snapshot(snapshot: TaskRowSnapshot, selected: bool) -> TaskRow:
    row = TaskRow()
    row.set_snapshot(snapshot)
    row.setSelection(selected)
    return row


def _task_rows() -> QWidget:
    running = _task_row_snapshot(
        TaskRowSnapshot(
            repo_id=fixtures.LONG_REPO_ID,
            kind_label="模型",
            status=StatusSeverity.ACTIVE,
            status_text="传输中",
            fraction=0.42,
            caption="第 2 位 · 模型快照下载",
        ),
        selected=True,
    )
    queued = _task_row_snapshot(
        TaskRowSnapshot(
            repo_id=fixtures.LONG_URL[:96],
            kind_label="数据集",
            status=StatusSeverity.QUEUED,
            status_text="排队中",
            fraction=None,
            caption="第 3 位 · 等待空闲工作进程",
        ),
        selected=False,
    )
    failed = _task_row_snapshot(
        TaskRowSnapshot(
            repo_id="example-org/tiny-random-bert",
            kind_label="克隆",
            status=StatusSeverity.FAILED,
            status_text="失败",
            fraction=None,
            caption="传输阶段失败：网络不可达",
        ),
        selected=False,
    )
    return _column(running, queued, failed)


def _blocks(motion: tokens.MotionPreference, loading: list[LoadingBlock]) -> QWidget:
    empty = EmptyBlock("暂无任务", "从新建下载或新建克隆开始", action_label="新建下载")
    block = LoadingBlock("正在加载任务队列", motion)
    loading.append(block)
    error = ErrorBlock("传输阶段失败：网络不可达", "检查代理设置后重试", "重试任务")
    return _column(empty, block, error)


def _stage_rail(
    motion: tokens.MotionPreference, rails: list[TransferStageRail]
) -> QWidget:
    labels = {stage: fixtures.stage_label(stage.value) for stage in TransferStage}
    running = TransferStageRail(labels)
    running.set_reports(
        (
            StageReport(TransferStage.PREFLIGHT, StageStatus.DONE),
            StageReport(TransferStage.AUTHENTICATE, StageStatus.DONE),
            StageReport(TransferStage.RESOLVE, StageStatus.ACTIVE),
            StageReport(TransferStage.TRANSFER, StageStatus.PENDING),
        )
    )
    failed = TransferStageRail(labels)
    failed.set_reports(
        (
            StageReport(TransferStage.PREFLIGHT, StageStatus.DONE),
            StageReport(TransferStage.TRANSFER, StageStatus.FAILED),
        )
    )
    running.set_motion_preference(motion)
    failed.set_motion_preference(motion)
    rails.extend((running, failed))
    return _column(running, failed)


def _log() -> QWidget:
    excerpt = LogExcerpt("日志摘录")
    excerpt.set_lines(fixtures.LOG_LINES)
    return _column(excerpt)


def _sheet() -> QWidget:
    sheet = Sheet("新建下载任务")
    sheet.body_layout().addWidget(TextField("仓库 ID", placeholder="作者/名称"))
    sheet.body_layout().addWidget(RepositoryTypeSelector("仓库类型"))
    sheet.add_footer_action(ActionButton("取消"))
    sheet.add_footer_action(ActionButton("确认并开始", primary=True))
    return sheet


def _focus(focus_targets: list[QWidget]) -> QWidget:
    hint = QLabel("使用 Tab 与 Shift+Tab 在控件间移动，焦点以蓝色描边环呈现。")
    hint.setWordWrap(True)
    zh_long = QLabel(fixtures.LONG_CHINESE_LABEL)
    zh_long.setWordWrap(True)
    zh_long.setAccessibleName("长中文标签换行示例")
    en_long = QLabel(fixtures.LONG_ENGLISH_LABEL)
    en_long.setWordWrap(True)
    en_long.setAccessibleName("long English label wrap sample")
    demo_button = ActionButton("焦点示例")
    demo_field = TextField("焦点示例输入")
    focus_targets.append(demo_button)
    focus_targets.append(demo_field)
    return _column(hint, demo_button, demo_field, zh_long, en_long)


def build_all(
    motion: tokens.MotionPreference,
    rails: list[TransferStageRail],
    loading: list[LoadingBlock],
    focus_targets: list[QWidget],
) -> list[tuple[str, QWidget]]:
    """Return every showcase section in display order with context wired in."""
    return [
        ("导航 Navigation", _navigation()),
        ("按钮 Buttons", _buttons()),
        ("分段 Segmented", _segmented()),
        ("开关 Toggles", _toggles()),
        ("输入 Fields", _fields()),
        ("仓库类型 Selector", _selector()),
        ("进度 Progress", _progress()),
        ("状态 Status", _status()),
        ("任务行 Task Rows", _task_rows()),
        ("占位 Blocks", _blocks(motion, loading)),
        ("阶段 Stage Rail", _stage_rail(motion, rails)),
        ("日志 Log", _log()),
        ("对话框 Sheet", _sheet()),
        ("焦点 Focus", _focus(focus_targets)),
    ]


__all__ = ["build_all"]
