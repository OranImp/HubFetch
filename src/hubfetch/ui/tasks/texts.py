"""Bilingual texts for the task inspection surfaces.

Mirrors the :class:`hubfetch.ui.navigation.ShellTexts` pattern: one frozen
dataclass per locale vocabulary, selected through ``for_locale``. The task
surface reuses the shell's kind/state vocabulary where the words overlap but
keeps its own strings for progress, actions, recovery, and the timeline so a
later locale catalog extraction covers exactly one ownership boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from hubfetch.config.settings import Locale
from hubfetch.domain.lifecycle import LifecycleState, TransferStage

STAGE_ORDER: Final[tuple[TransferStage, ...]] = (
    TransferStage.PREFLIGHT,
    TransferStage.AUTHENTICATE,
    TransferStage.RESOLVE,
    TransferStage.TRANSFER,
    TransferStage.MATERIALIZE,
    TransferStage.FINALIZE,
)


@dataclass(frozen=True, slots=True)
class TaskTexts:
    """The complete task inspection vocabulary for one locale."""

    state_texts: dict[LifecycleState, str]
    kind_texts: dict[str, str]
    stage_labels: dict[TransferStage, str]
    queue_position_format: str
    attempt_format: str
    destination_label: str
    cache_label: str
    progress_label: str
    cancel_command: str
    retry_command: str
    open_folder_command: str
    copy_diagnostic_command: str
    cancelling_label: str
    timeline_header: str
    empty_timeline: str
    recovery_message: str
    recovery_action: str
    destination_required_message: str
    copy_diagnostic_ready: str

    @classmethod
    def for_locale(cls, locale: Locale) -> TaskTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return TaskTexts(
                state_texts={
                    LifecycleState.QUEUED: "Queued",
                    LifecycleState.RUNNING: "Transferring",
                    LifecycleState.CANCELLING: "Cancelling",
                    LifecycleState.SUCCEEDED: "Succeeded",
                    LifecycleState.FAILED: "Failed",
                    LifecycleState.CANCELLED: "Cancelled",
                    LifecycleState.INTERRUPTED: "Interrupted",
                },
                kind_texts={
                    "single_file": "Single file",
                    "snapshot": "Snapshot",
                    "git_clone": "Clone",
                },
                stage_labels={
                    TransferStage.PREFLIGHT: "Preflight",
                    TransferStage.AUTHENTICATE: "Authorize",
                    TransferStage.RESOLVE: "Resolve",
                    TransferStage.TRANSFER: "Transfer",
                    TransferStage.MATERIALIZE: "Verify",
                    TransferStage.FINALIZE: "Checkout",
                },
                queue_position_format="Position {position}",
                attempt_format="Attempt {attempt}",
                destination_label="Destination",
                cache_label="Cache",
                progress_label="Progress",
                cancel_command="Cancel task",
                retry_command="Retry task",
                open_folder_command="Open folder",
                copy_diagnostic_command="Copy diagnostic",
                cancelling_label="Cancelling…",
                timeline_header="Timeline",
                empty_timeline="No events recorded",
                recovery_message="The task can be retried",
                recovery_action="Retry",
                destination_required_message=(
                    "Retry needs a new or empty destination folder"
                ),
                copy_diagnostic_ready="Diagnostic copied",
            )
        return TaskTexts(
            state_texts={
                LifecycleState.QUEUED: "排队中",
                LifecycleState.RUNNING: "传输中",
                LifecycleState.CANCELLING: "取消中",
                LifecycleState.SUCCEEDED: "已完成",
                LifecycleState.FAILED: "失败",
                LifecycleState.CANCELLED: "已取消",
                LifecycleState.INTERRUPTED: "已中断",
            },
            kind_texts={
                "single_file": "单个文件",
                "snapshot": "快照",
                "git_clone": "克隆",
            },
            stage_labels={
                TransferStage.PREFLIGHT: "预检",
                TransferStage.AUTHENTICATE: "授权",
                TransferStage.RESOLVE: "解析",
                TransferStage.TRANSFER: "传输",
                TransferStage.MATERIALIZE: "校验",
                TransferStage.FINALIZE: "落地",
            },
            queue_position_format="队列位置 {position}",
            attempt_format="尝试 {attempt}",
            destination_label="目标位置",
            cache_label="缓存",
            progress_label="进度",
            cancel_command="取消任务",
            retry_command="重试任务",
            open_folder_command="打开文件夹",
            copy_diagnostic_command="复制诊断信息",
            cancelling_label="正在取消…",
            timeline_header="时间线",
            empty_timeline="暂无事件记录",
            recovery_message="任务可以重试",
            recovery_action="重试",
            destination_required_message="重试需要新的或空的目标文件夹",
            copy_diagnostic_ready="已复制诊断信息",
        )


__all__ = ["STAGE_ORDER", "TaskTexts"]
