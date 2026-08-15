"""Bilingual vocabulary for the transient Download and Clone creation flows.

# noqa: SIZE_OK - one module must own the complete bilingual vocabulary for
# both flows and both locales, plus the shared byte formatter; splitting it
# would scatter one value object across modules.

Todo 28 migrates every UI literal into the Qt catalogs; until then the interim
vocabulary lives here exactly as Todo 24's :class:`ShellTexts` does, with
Simplified Chinese as the default and complete English fallback. Display code
requests labels through this value object and never hard-codes localized text.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from hubfetch.config.settings import Locale

if TYPE_CHECKING:
    from hubfetch.domain.errors import ErrorCategory, RecoveryAction

_UNITS: Final = ("B", "KB", "MB", "GB", "TB")
_KILOBYTE: Final = 1024


def format_bytes(value: int | None) -> str:
    """Render a byte count in the compact human unit ladder, or '--' when None."""
    if value is None:
        return "--"
    amount = float(value)
    for unit in _UNITS:
        if amount < _KILOBYTE or unit == _UNITS[-1]:
            if unit == "B":
                return f"{int(amount)} {unit}"
            return f"{amount:.1f} {unit}"
        amount /= _KILOBYTE
    return f"{int(value)} B"


@dataclass(frozen=True, slots=True)
class CreateTexts:
    """Complete bilingual vocabulary for the two creation flows."""

    download_title: str
    clone_title: str
    mode_label: str
    mode_file: str
    mode_snapshot: str
    repo_type_label: str
    repo_id_label: str
    repo_id_placeholder: str
    revision_label: str
    revision_placeholder: str
    filename_label: str
    filename_placeholder: str
    include_label: str
    include_placeholder: str
    exclude_label: str
    exclude_placeholder: str
    destination_label: str
    destination_placeholder: str
    dest_cache: str
    dest_local: str
    local_path_label: str
    browse_label: str
    conflict_label: str
    conflict_overwrite: str
    conflict_preserve: str
    conflict_fail: str
    auth_label: str
    auth_anonymous: str
    auth_shared: str
    auth_manual: str
    proxy_label: str
    proxy_system: str
    proxy_direct: str
    proxy_manual: str
    proxy_url_label: str
    transport_label: str
    transport_https: str
    transport_ssh: str
    ssh_url_label: str
    ssh_url_placeholder: str
    shallow_label: str
    shallow_description: str
    plan_button: str
    plan_loading: str
    replan_button: str
    confirm_download: str
    confirm_clone: str
    planning_label: str
    preflight_label: str
    estimates_title: str
    resolved_commit_label: str
    files_label: str
    bytes_label: str
    cache_hits_label: str
    cache_misses_label: str
    disk_label: str
    disk_sufficient: str
    disk_insufficient: str
    disk_unknown: str
    git_version_label: str
    xet_state_label: str
    xet_configured: str
    xet_missing: str
    xet_uninitialized: str
    xet_timeout: str
    xet_nonzero: str
    xet_unknown: str
    destination_verdict_label: str
    ready_label: str
    not_ready_label: str
    confirm_reason_validate: str
    confirm_reason_plan: str
    confirm_reason_planning: str
    confirm_reason_changed: str
    confirm_reason_preflight: str
    confirm_reason_preflighting: str
    confirm_reason_failed: str
    error_titles: dict[str, str]
    recovery_labels: dict[str, str]
    field_errors: dict[str, str]
    destination_details: dict[str, str]

    @classmethod
    def for_locale(cls, locale: Locale) -> CreateTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return CreateTexts(
                download_title="New Download",
                clone_title="New Clone",
                mode_label="Mode",
                mode_file="Single file",
                mode_snapshot="Snapshot",
                repo_type_label="Repository type",
                repo_id_label="Repository ID",
                repo_id_placeholder="organization/name",
                revision_label="Revision (optional)",
                revision_placeholder="branch, tag, or commit",
                filename_label="Remote file",
                filename_placeholder="path/inside/repository",
                include_label="Include patterns (one per line)",
                include_placeholder="*.safetensors",
                exclude_label="Exclude patterns (one per line)",
                exclude_placeholder="*.bin",
                destination_label="Destination",
                destination_placeholder="Must be empty or absent",
                dest_cache="Cache",
                dest_local="Local directory",
                local_path_label="Local directory",
                browse_label="Browse\u2026",
                conflict_label="Conflict policy",
                conflict_overwrite="Overwrite existing",
                conflict_preserve="Preserve existing",
                conflict_fail="Fail on existing",
                auth_label="Authentication",
                auth_anonymous="Anonymous",
                auth_shared="Shared browser login",
                auth_manual="Manual token",
                proxy_label="Proxy",
                proxy_system="System",
                proxy_direct="Direct",
                proxy_manual="Manual",
                proxy_url_label="Manual proxy URL",
                transport_label="Transport",
                transport_https="HTTPS",
                transport_ssh="SSH",
                ssh_url_label="SSH URL",
                ssh_url_placeholder="git@hf.co:organization/name",
                shallow_label="Shallow clone (latest history only)",
                shallow_description="Passes --depth 1 to git clone",
                plan_button="Plan",
                plan_loading="Planning\u2026",
                replan_button="Re-plan",
                confirm_download="Confirm download",
                confirm_clone="Confirm clone",
                planning_label="Planning\u2026",
                preflight_label="Preflighting\u2026",
                estimates_title="Plan",
                resolved_commit_label="Resolved commit",
                files_label="Files",
                bytes_label="Size",
                cache_hits_label="Cache hits",
                cache_misses_label="To download",
                disk_label="Disk",
                disk_sufficient="Sufficient space",
                disk_insufficient="Insufficient space",
                disk_unknown="Unknown space",
                git_version_label="Git",
                xet_state_label="Git-Xet",
                xet_configured="Configured",
                xet_missing="Missing",
                xet_uninitialized="Not initialized",
                xet_timeout="Probe timed out",
                xet_nonzero="Probe failed",
                xet_unknown="Unknown",
                destination_verdict_label="Destination",
                ready_label="Ready",
                not_ready_label="Not ready",
                confirm_reason_validate="Fix the highlighted fields first",
                confirm_reason_plan="Plan the transfer first",
                confirm_reason_planning="Planning in progress",
                confirm_reason_changed="Input changed; plan again",
                confirm_reason_preflight="Preflight the clone first",
                confirm_reason_preflighting="Preflight in progress",
                confirm_reason_failed="Planning failed; no task was created",
                error_titles={
                    "validation": "Invalid input",
                    "authentication": "Authentication failed",
                    "gated_access": "Gated repository",
                    "not_found": "Not found",
                    "network": "Network error",
                    "disk": "Disk or path problem",
                    "dependency": "Missing dependency",
                    "process_containment": "Process containment failed",
                    "cancellation": "Cancelled",
                    "persistence": "Persistence failed",
                    "internal": "Internal error",
                },
                recovery_labels={
                    "retry": "Retry",
                    "reauthenticate": "Re-authenticate",
                    "request_access": "Request access",
                    "check_revision": "Check revision",
                    "check_network": "Check network",
                    "free_space": "Free space",
                    "install_dependency": "Install dependency",
                    "restart_task": "Restart task",
                    "resume": "Resume",
                    "retry_persistence": "Retry persistence",
                    "report_bug": "Report bug",
                },
                field_errors={
                    "repo_id.format": "Repository ID must be author/name",
                    "repo_id.chars": "Repository ID must not contain spaces or NUL",
                    "revision.chars": "Revision must not contain NUL",
                    "revision.hex": "A 40-character revision must be hexadecimal",
                    "filename.empty": "Enter the remote file path",
                    "patterns.empty_line": "Patterns cannot contain an empty line",
                    "patterns.nul": "Patterns must not contain NUL",
                    "destination.empty": "Choose a destination directory",
                    "destination.chars": "Destination must not contain NUL",
                    "destination.not_directory": "Destination must be a directory",
                    "destination.not_empty": "Destination must be empty or absent",
                    "proxy.invalid": "Enter a valid http(s)://host[:port] proxy",
                    "ssh_url.invalid": "Enter a valid SSH URL without credentials",
                    "ssh_url.not_hf_repo": "SSH URL must identify an author/name repo",
                },
                destination_details={
                    "destination.absent": "Absent (will be created)",
                    "destination.empty": "Empty directory",
                    "destination.not_directory": "Not a directory",
                    "destination.not_empty": "Not empty",
                },
            )
        return CreateTexts(
            download_title="新建下载",
            clone_title="新建克隆",
            mode_label="模式",
            mode_file="单文件",
            mode_snapshot="快照",
            repo_type_label="仓库类型",
            repo_id_label="仓库标识",
            repo_id_placeholder="组织/名称",
            revision_label="修订(可选)",
            revision_placeholder="分支、标签或提交",
            filename_label="远程文件",
            filename_placeholder="仓库内的文件路径",
            include_label="包含模式(每行一个)",
            include_placeholder="*.safetensors",
            exclude_label="排除模式(每行一个)",
            exclude_placeholder="*.bin",
            destination_label="目标位置",
            destination_placeholder="必须为空或不存在",
            dest_cache="缓存",
            dest_local="本地目录",
            local_path_label="本地目录",
            browse_label="浏览…",
            conflict_label="冲突策略",
            conflict_overwrite="覆盖现有文件",
            conflict_preserve="保留现有文件",
            conflict_fail="存在即失败",
            auth_label="身份验证",
            auth_anonymous="匿名",
            auth_shared="共享浏览器登录",
            auth_manual="手动令牌",
            proxy_label="代理",
            proxy_system="系统",
            proxy_direct="直连",
            proxy_manual="手动",
            proxy_url_label="手动代理地址",
            transport_label="传输方式",
            transport_https="HTTPS",
            transport_ssh="SSH",
            ssh_url_label="SSH 地址",
            ssh_url_placeholder="git@hf.co:组织/名称",
            shallow_label="浅克隆(仅最新历史)",
            shallow_description="向 git clone 传递 --depth 1",
            plan_button="规划",
            plan_loading="规划中…",
            replan_button="重新规划",
            confirm_download="确认下载",
            confirm_clone="确认克隆",
            planning_label="规划中…",
            preflight_label="预检中…",
            estimates_title="规划结果",
            resolved_commit_label="解析提交",
            files_label="文件数",
            bytes_label="大小",
            cache_hits_label="缓存命中",
            cache_misses_label="需下载",
            disk_label="磁盘",
            disk_sufficient="空间充足",
            disk_insufficient="空间不足",
            disk_unknown="空间未知",
            git_version_label="Git",
            xet_state_label="Git-Xet",
            xet_configured="已配置",
            xet_missing="缺失",
            xet_uninitialized="未初始化",
            xet_timeout="探测超时",
            xet_nonzero="探测失败",
            xet_unknown="未知",
            destination_verdict_label="目标目录",
            ready_label="就绪",
            not_ready_label="未就绪",
            confirm_reason_validate="请先修正标红的输入",
            confirm_reason_plan="请先规划传输",
            confirm_reason_planning="正在规划",
            confirm_reason_changed="输入已更改, 请重新规划",
            confirm_reason_preflight="请先完成克隆预检",
            confirm_reason_preflighting="正在预检",
            confirm_reason_failed="规划失败, 未创建任务",
            error_titles={
                "validation": "输入无效",
                "authentication": "身份验证失败",
                "gated_access": "仓库受限",
                "not_found": "未找到",
                "network": "网络错误",
                "disk": "磁盘或路径问题",
                "dependency": "缺少依赖",
                "process_containment": "进程隔离失败",
                "cancellation": "已取消",
                "persistence": "保存失败",
                "internal": "内部错误",
            },
            recovery_labels={
                "retry": "重试",
                "reauthenticate": "重新登录",
                "request_access": "申请访问",
                "check_revision": "检查修订",
                "check_network": "检查网络",
                "free_space": "释放空间",
                "install_dependency": "安装依赖",
                "restart_task": "重启任务",
                "resume": "恢复",
                "retry_persistence": "重试保存",
                "report_bug": "报告问题",
            },
            field_errors={
                "repo_id.format": "仓库标识必须是 author/name 形式",
                "repo_id.chars": "仓库标识不能包含空格或 NUL",
                "revision.chars": "修订不能包含 NUL",
                "revision.hex": "40 位修订必须是十六进制",
                "filename.empty": "请输入远程文件路径",
                "patterns.empty_line": "模式不能包含空行",
                "patterns.nul": "模式不能包含 NUL",
                "destination.empty": "请选择目标目录",
                "destination.chars": "目标路径不能包含 NUL",
                "destination.not_directory": "目标必须是目录",
                "destination.not_empty": "目标必须为空或不存在",
                "proxy.invalid": "请输入有效的 http(s)://主机[:端口] 代理",
                "ssh_url.invalid": "请输入不带凭据的有效 SSH 地址",
                "ssh_url.not_hf_repo": "SSH 地址必须指向 author/name 仓库",
            },
            destination_details={
                "destination.absent": "不存在(将自动创建)",
                "destination.empty": "空目录",
                "destination.not_directory": "不是目录",
                "destination.not_empty": "非空目录",
            },
        )

    def error_title(self, category: ErrorCategory) -> str:
        """Return the localized failure title for one error category."""
        return self.error_titles.get(category.value, category.value)

    def recovery_label(self, action: RecoveryAction) -> str:
        """Return the localized label of one executable recovery action."""
        return self.recovery_labels.get(action.value, action.value)

    def field_error(self, code: str) -> str:
        """Return the localized inline message for one validation code."""
        return self.field_errors.get(code, code)

    def destination_detail(self, code: str) -> str:
        """Return the localized clone destination verdict for one code."""
        return self.destination_details.get(code, code)

    def xet_state(self, state: str) -> str:
        """Return the localized Git-Xet probe state label."""
        match state:
            case "configured":
                return self.xet_configured
            case "missing":
                return self.xet_missing
            case "uninitialized":
                return self.xet_uninitialized
            case "timeout":
                return self.xet_timeout
            case "nonzero":
                return self.xet_nonzero
            case _:
                return self.xet_unknown


__all__ = ["CreateTexts", "format_bytes"]
