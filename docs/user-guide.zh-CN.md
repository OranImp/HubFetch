# HubFetch 用户指南（简体中文）

本文档是 HubFetch 0.1.0 的**主要用户文档**。英文对照版本见
[user-guide.en.md](user-guide.en.md)。维护者文档见
[architecture.md](architecture.md) 与 [security.md](security.md)。

HubFetch 是一个 Windows 11 x64 桌面应用，用于管理本地的 Hugging Face 下载与
Git 克隆工作流。它不是 Hugging Face 官方产品，与 Hugging Face, Inc. 无隶属或
背书关系。

> **重要**：HubFetch 以**未签名**的便携式 ZIP 发布。首次运行时 Windows
> SmartScreen 会显示警告。请只在您信任归档来源的情况下选择"更多信息 → 仍要
> 运行"。本软件不包含安装程序、不进行签名、不请求提升权限，也不提供任何
> 自动更新机制（无更新检查、无版本轮询、无后台更新）。

## 目录

1. [系统要求与前置条件](#1-系统要求与前置条件)
2. [安装与解压](#2-安装与解压)
3. [首次启动与未签名警告](#3-首次启动与未签名警告)
4. [身份认证](#4-身份认证)
5. [代理设置](#5-代理设置)
6. [下载：文件与快照](#6-下载文件与快照)
7. [克隆：Git 工作副本](#7-克隆git-工作副本)
8. [任务队列、取消、重试与中断恢复](#8-任务队列取消重试与中断恢复)
9. [缓存与磁盘诊断](#9-缓存与磁盘诊断)
10. [支持包（Support Bundle）](#10-支持包support-bundle)
11. [隐私与安全边界](#11-隐私与安全边界)
12. [已知限制](#12-已知限制)
13. [故障排除](#13-故障排除)
14. [卸载与数据/凭据清理](#14-卸载与数据凭据清理)
15. [许可证](#15-许可证)
16. [无更新行为](#16-无更新行为)

## 1. 系统要求与前置条件

- **操作系统**：Windows 11 x64（内部版本 >= 22000）。
- **Python**：仅开发和构建需要 Python 3.12；已发布的便携归档**不需要**安装
  Python。
- **uv**：仅开发和构建需要。
- **Git**：克隆任务需要系统 Git。
- **Git-Xet**：克隆使用 Xet 存储的仓库需要系统 Git-Xet；纯下载任务不需要。

### 非提权安装 Git 与 Git-Xet（winget）

以下命令以普通用户身份运行，不需要管理员权限，不会触发 UAC：

```powershell
winget install --id Git.Git -e
winget install --id git-xet.git-xet -e
```

安装 Git for Windows 会同时提供 Git Credential Manager（凭据管理器），使
HTTPS 认证可复用系统凭据。安装后请打开新的终端，确认命令可用：

```powershell
git --version
git xet --version
```

克隆任务还要求 Git-Xet 过滤器已初始化（`git xet init`）。如果 Diagnostics 页
显示 "Git-Xet is missing or its filters are not configured"，请按
[故障排除](#13-故障排除) 处理。

## 2. 安装与解压

1. 下载 `HubFetch-0.1.0-windows-x64.zip`。
2. 将其解压到一个文件夹。路径可以包含空格或非 ASCII 字符（例如 `便携 测试`），
   解压后顶层是一个名为 `HubFetch` 的目录。
3. 目录内包含 `HubFetch.exe`（图形界面）、`HubFetchAskPass.exe`（控制台辅助
   程序）、`_internal/`（依赖库）、`licenses/`（许可证）、`resources/`（字体与
   图标）等。**不要**删除 `_internal/` 或其中的 DLL/插件——它们是运行时的一部分，
   并且是可替换的（见 Qt LGPL 合规说明 `qt-lgpl-compliance.md`）。
4. 双击 `HubFetch.exe` 启动。

应用**首次启动时会创建**它的数据目录（见第 11 节）与 `hubfetch.db` 数据库；
这些文件保存在用户数据目录，而不是安装目录，因此卸载时不会残留到安装位置。

## 3. 首次启动与未签名警告

- 由于归档未签名，SmartScreen 可能显示"Windows 已保护你的电脑"。请点击
  "更多信息"，确认来源可信后选择"仍要运行"。
- 应用启动后默认使用**简体中文**界面；可在设置中切换为 English。
- 启动时如果 Git、Git-Xet、缓存目录或凭据后端存在可恢复的问题，界面会显示
  非阻塞的状态提示，不会阻止下载类任务。

## 4. 身份认证

HubFetch 支持三种认证来源，彼此独立：

### 4.1 匿名访问（默认）

无需任何凭据，只能访问公开仓库。这是默认选项。

### 4.2 共享机器浏览器 OAuth

使用 Hugging Face 官方的"共享机器登录"浏览器 OAuth。登录后令牌只保存在
Hub 自己的共享存储中；HubFetch **不会**把该令牌写入自己的凭据库或数据库，
只记录非秘密的账户元数据。该功能依赖固定的 Hugging Face 适配器；如果适配器
在当前环境不可用，界面会提示兼容性诊断，但手动令牌路径不受影响。

### 4.3 HubFetch 专属手动令牌（Token）

- 在设置中输入一个 Hugging Face 访问令牌（`hf_...`）。
- 令牌通过 Windows 凭据管理器（Credential Manager）保存，服务名为
  `HubFetch.Credentials`，并以**不透明别名**（`hfc-` 开头的随机值）引用。
- 数据库、日志、事件、支持包、进程参数、工作进程环境中**永远不会出现**
  令牌明文。
- **不要**通过环境变量设置令牌：`HF_TOKEN` 等携带凭据的环境变量会在每个
  工作进程环境创建时被移除。也请不要在任何终端里 `set HF_TOKEN`。

### 4.4 克隆任务中的认证

- 默认（`系统`）模式：HTTPS 使用 Git Credential Manager 或您配置的安全
  helper，SSH 使用您的 agent/config，HubFetch 不修改任何东西。
- 当您在克隆任务中明确选择一个 HubFetch 凭据别名时，该 git 进程会禁用交互式
  提示（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`，并清空该进程的
  凭据 helper），并把 `GIT_ASKPASS`/`SSH_ASKPASS` 指向打包的
  `HubFetchAskPass.exe`。AskPass 会话只有约 30 秒有效期，且永不持有令牌明文——
  令牌由辅助程序按需从凭据库解析，只写到 stdout。

## 5. 代理设置

每个任务都可以选择独立的代理策略（在创建任务时选择，全局设置只保存默认值）：

- **系统代理**：继承系统/机器代理设置，不改动任何变量。
- **直连**：只在**该任务的 worker 环境**中清空所有代理变量；不会修改 GUI 或
  全局环境。
- **手动代理**：输入合法的 HTTP/HTTPS 代理地址（默认预填
  `http://127.0.0.1:7897`）。手动模式下会同时设置 `HTTP_PROXY`、
  `HTTPS_PROXY`、`ALL_PROXY`，并显式把 `NO_PROXY` 设为
  `127.0.0.1,localhost`，使本地流量绕过代理。URL 中不允许嵌入用户名/密码。

直连与手动模式只影响任务进程，不会改变您的系统代理设置。

## 6. 下载：文件与快照

### 6.1 单文件下载

下载仓库中的**一个文件**。需要：仓库标识（`author/repo`）、仓库类型（模型 /
数据集 / Space）、可选 revision（分支、标签或完整提交哈希）、文件名。

### 6.2 快照下载

下载仓库的**过滤或完整快照**。可指定 include/exclude 模式（glob 风格），
例如只包含 `*.safetensors`。可选择分支、标签或完整提交哈希。

### 6.3 目标与冲突策略

下载任务的目标有两种：

- **缓存模式**：文件进入版本化的 Hugging Face Hub 缓存（`HF_HUB_CACHE`）。
- **本地目录模式**：文件进入您选择的目录（同时仍写入缓存）。

冲突策略：

- **覆盖**：已存在的目标文件被重新下载替换。
- **保留**：已存在的文件跳过，不重复下载。
- **失败**：目标已存在时任务直接失败，绝不动已有文件。

下载有自动的缓存断点续传（reuse/resume）：中断后重试同一个缓存，已完成的字节
不会重新下载。下载前可以执行 dry-run 估算文件数与字节数。

### 6.4 语义对比：下载 vs 克隆

- 下载产物是**文件/快照**：以 Hub 缓存加可选本地目录组织，不是 Git 工作副本，
  适合只取权重/数据。
- 克隆产物是**完整 Git 工作副本**：包含 `.git/`、工作树与版本历史，适合需要
  `git` 命令继续操作的场景。

## 7. 克隆：Git 工作副本

- 克隆通过**系统 Git** 与**系统 Git-Xet** 执行（HubFetch 不包含自定义 Git
  协议实现，也不捆绑 Git/Git-Xet 可执行文件）。
- 可指定 revision（Git 支持的分支/标签），并可选浅克隆（`--depth 1`）。
- **目标目录必须是空目录或不存在的目录**。非空目录会导致任务失败。
- **中断的克隆不会在原目录恢复**（Git 本身不支持断点续传克隆）。重试时请选择
  一个新的（或清空后的）目标目录；失败产生的部分数据会保留在原处，直到您明确
  选择清理。
- 克隆进度强制从 stderr 捕获并显示为传输阶段（preflight → transfer →
  materialize → finalize）。

## 8. 任务队列、取消、重试与中断恢复

- **全局 FIFO 队列**：一个任务进入 `queued`；**同时只有一个任务处于
  `running`**；当前任务到达终态（成功/失败/已取消/已中断）后，下一个排队任务
  自动开始。
- **取消**：
  - 排队中的任务直接取消，不启动 worker。
  - 运行中的任务先进入非终态 `cancelling`，向 worker 发送协作式停止请求，
    等待一个宽限窗口；若 worker 无响应，则执行**有界**的进程树终止
    （TerminateJobObject）。只有 Job 报告活动进程数为零且最终事件已记录后，
    才持久化为 `cancelled`。
- **重试**：失败、已取消、已中断的终态任务可以重试。重试会创建**新的尝试**
  （attempt），与原始尝试关联。成功的任务不可重试。下载任务重试会复用缓存；
  克隆任务重试需要一个空的新目标目录。
- **中断恢复**：如果应用在传输中退出（崩溃/强制结束），Job 的 kill-on-close
  会终止整个 worker 进程树，持久化的 `running`/`cancelling` 行会在下次启动时
  被改为 `interrupted`，然后队列按 FIFO 继续派发。

## 9. 缓存与磁盘诊断

Diagnostics 页面提供只读检查：

- `HF_HOME`、`HF_HUB_CACHE`、`HF_XET_CACHE` 的实际位置与可写性。
- Windows 符号链接支持情况（部分系统/文件系统上 symlink 退化会影响缓存）。
- 目标盘可用空间估计。
- Git 是否可用、Git-Xet 是否初始化、凭据 helper 是否可用。
- Hub 端点可达性。
- 支持包导出（见下节）。

## 10. 支持包（Support Bundle）

支持包是一个 ZIP，**只**包含以下内容：

- `versions.json`：应用/运行时/依赖版本。
- `settings.json`：已脱敏的设置。
- `diagnostics.json`：已脱敏的诊断报告。
- `logs/*.jsonl` 与 `logs/*.log`：日志目录中按后缀允许列表收录的日志
  （单个成员上限 1 MiB，超长截断并标记）。

**绝不包含**：数据库/WAL/SHM、任务载荷、环境变量转储、截图、凭据、完整凭据
别名、任意缓存文件。所有成员在写入前都经过脱敏（redaction）；如果注册的机密
仍然存在于归档中，导出会**失败关闭**（fail-closed），不会产出泄露的包。

## 11. 隐私与安全边界

- **凭据**：手动令牌只存于 Windows 凭据管理器（服务 `HubFetch.Credentials`），
  数据库和日志中只有不透明别名与账户元数据。OAuth 令牌存于 Hub 的共享存储，
  HubFetch 不接触。
- **环境隔离**：每个 worker 进程使用从只读父环境快照新建的环境；携带凭据的
  变量（`HF_TOKEN`、`HF_TOKEN_PATH`、`HUGGING_FACE_HUB_TOKEN`、
  `HUGGINGFACE_HUB_TOKEN`、`GIT_ASKPASS`、`SSH_ASKPASS`、
  `SSH_ASKPASS_REQUIRE`）以及所有 `hubfetch_` 前缀变量都被移除。
- **进程隔离**：每个活动任务一个受监督的 worker 进程，置于 kill-on-close 的
  Windows Job Object 中；子 Git/Xet 进程继承该 Job。取消与关闭会清空整个进程树。
- **Job 先于信封**：GUI 先启动被阻塞的 worker，分配其 PID 到 Job，然后才发送
  任务信封；分配失败则拒绝开始工作。
- **脱敏**：日志、事件、支持包、捕获的 stderr 都经过结构化与模式脱敏（URL
  userinfo、敏感查询参数、`Authorization` 等头、Git 凭据协议行、AskPass 提示
  回显、`hf_`/`api_org_` 令牌模式、注册机密按值替换为 `[REDACTED]`）。
- **凭据后端失败关闭**：如果活动的 keyring 后端不是 Windows 凭据管理器实现
  （null/fail/plaintext/chainer/`keyrings.alt` 等），构造凭据库会直接拒绝，
  而不是降级到明文存储。

## 12. 已知限制

- 未签名发布：无受信任签名；SmartScreen 会提示。
- 无更新机制：不检查、不轮询、不自更新、不自动下载。
- 无上传/仓库管理：不能上传、创建、删除、移动、设置仓库，不能修改标签或分支。
- 克隆不支持原目录断点续传；重试需要空/新目标目录。
- 共享浏览器 OAuth 依赖固定的 Hub 适配器；适配器不可用时该路径不可用。
- 只支持一个活动任务（队列串行执行）。
- 不捆绑 Git/Git-Xet/任何 HF 命令行工具。
- Windows 上符号链接在某些文件系统/配置下退化，可能影响缓存布局。

## 13. 故障排除

详细的逐步排查见 [troubleshooting.md](troubleshooting.md)。常见问题速查：

| 现象 | 处理 |
|---|---|
| SmartScreen 警告 | 未签名是预期行为；确认来源后选择"仍要运行" |
| 克隆失败：Git not ready | 安装 Git 并确保 `git` 在 PATH；非提权 `winget install --id Git.Git -e` |
| 克隆失败：Git-Xet missing | 安装 Git-Xet 并初始化过滤器（`git xet init`） |
| 克隆失败：destination is not empty | 选择新的或清空后的目标目录 |
| 私有/受限仓库 401/403 | 选择手动令牌或共享 OAuth 认证来源 |
| 下载卡住/很慢 | 在任务中选择直连或手动代理模式 |
| 取消后任务仍显示运行 | 等待宽限窗口与有界终止完成；`cancelled` 只在 Job 清空后写入 |
| 需要支持 | 在 Diagnostics 导出支持包，并把 ZIP 交给维护者（不含任何凭据） |

## 14. 卸载与数据/凭据清理

- **卸载**：HubFetch 没有安装程序。删除解压目录即完成卸载；无需管理员权限。
- **数据**：应用数据（含 `hubfetch.db`、缓存、日志）保存在用户数据目录
  （AppData 下的 HubFetch 位置），卸载应用不会自动删除它们。如需彻底清除，
  请手动删除该目录。缓存根也可通过 Diagnostics 查看其实际路径。
- **凭据**：在应用的凭据管理界面删除令牌别名，或在 Windows 凭据管理器
  （控制面板 → 凭据管理器 → Windows 凭据）中删除 `HubFetch.Credentials`
  服务下的条目。
- **环境**：无需清理任何环境变量；HubFetch 从不修改全局环境。

## 15. 许可证

- 应用本身：MIT（`licenses/LICENSE`）。
- 第三方组件：`licenses/THIRD_PARTY_NOTICES.md`（由 `uv.lock` 确定性生成）。
- Qt/PySide6：LGPL-3.0-only（动态链接，DLL/插件可替换），合规说明见
  `qt-lgpl-compliance.md`；另随附 GPL-3.0 文本。
- 字体：Cascadia Mono，SIL Open Font License 1.1（`resources/fonts/OFL.txt`）。

## 16. 无更新行为

HubFetch **从不**：轮询发布信息、检查新版本、在后台下载更新、静默自更新、
或弹出更新提示。唯一与"发布"相关的行为是：当用户在设置中主动配置一个 Help
URL 时，"帮助"动作会在默认浏览器中打开该 URL；不配置则无任何网络访问。
