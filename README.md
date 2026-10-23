# HubFetch

> Windows 上的 Hugging Face 工作台 · A Hugging Face workbench for Windows

[中文说明](#中文说明) ｜ [English](#english)

---

## 中文说明

### 这是什么

HubFetch 是一个运行在 Windows 上的 Hugging Face Hub 桌面工作台。它围绕三件事设计：**把文件从 Hub 拿下来**（下载与 git 克隆）、**管好本地缓存**、**看清楚仓库里有什么**。绿色便携分发——单一 ZIP，无安装器，无自更新器，不收集任何数据。

### 它从哪里来，和 Oh My HuggingFace 有什么不同

HubFetch 的代码起点是开源项目 [Oh My HuggingFace](https://github.com/fzlzjerry/ohmyhf)（fzlzjerry，Apache-2.0）的 v0.0.9 快照，此后在本仓库独立演化，完整导入凭证见 [UPSTREAM_SOURCE.md](UPSTREAM_SOURCE.md)。两个项目如今各自维护，方向并不相同：

| 维度 | HubFetch | Oh My HuggingFace |
| --- | --- | --- |
| 平台与分发 | 仅 Windows x64，绿色 ZIP 解压即用 | macOS / Windows / Linux，提供系统级安装包 |
| 更新方式 | 无自更新，随 Releases 手动升级 | 应用内更新 |
| 遥测 | 无遥测、无分析、无启动回连 | 默认开启 PostHog 遥测（可关闭） |
| 克隆 | git clone 是一等工作流：克隆管理器、浅克隆、克隆代理、Xet 适配、专用凭据助手 | 以 Hub API 下载为主 |
| LLM 辅助 | 内置可自定义端点的 LLM 辅助（OpenAI / Anthropic / Gemini） | —— |
| 镜像支持 | 可配置自定义 Hub 端点（镜像站） | —— |

浏览、搜索、登录、上传、收藏、关注、收件箱、历史记录这些能力两边都有——HubFetch 继承并继续演化；上表只列真正分道扬镳的部分。

### 主要能力

- **浏览与预览**：模型 / 数据集 / Space / 每日论文的三栏式界面；`Ctrl+K` 命令面板全局搜索（按任务、库、许可证过滤，按热度排序）；模型卡渲染与代码高亮；文件树与元数据；`.parquet` 数据集本地预览
- **下载**：并行下载、断点续传、SHA-256 校验、限速与系统通知；采用 Hugging Face 标准缓存布局（blob + snapshot），与 `transformers`、`hf` 等工具完全互通
- **克隆**：git clone 管理器（浅克隆、目标目录选择、代理、Xet 存储适配）；凭据经命名管道由专用助手传递，不进命令行与环境变量
- **缓存治理**：缓存索引、按仓库的磁盘占用可视化、完整性校验与一键清理
- **账号与远程操作**：登录、上传、收藏、关注、收件箱、历史记录、讨论与 PR 评论、收藏集、仓库与 Space 管理
- **对比与导出**：2–4 个模型并排对比；下载内容导出到 Ollama / LM Studio / ComfyUI
- **本地推理**：Ollama 集成
- **LLM 辅助**：三家 provider 均支持自定义 baseUrl 与代理
- **界面**：九种语言（英 / 简中 / 繁中 / 日 / 韩 / 德 / 西 / 法 / 葡），亮 / 暗主题

### 系统要求与安装

- Windows 10 / 11（64 位）
- **Git** 与 **Git-Xet**：克隆功能使用系统安装的 Git（含 Xet 适配），发行包不捆绑；在 **设置 → 克隆工具** 中可检查就绪状态并跳转官方下载页
- 从 [Releases](https://github.com/OranImp/HubFetch/releases) 下载 `HubFetch-<version>-windows-x64.zip`（未签名，首次运行可能触发 SmartScreen 提示，参见 [docs/signing.md](docs/signing.md)），解压运行 `HubFetch.exe`

### 登录与代理

- 在 **设置 → 账号** 粘贴 [Hugging Face 访问令牌](https://huggingface.co/settings/tokens)；令牌经操作系统凭据保护（safeStorage）加密存储于 `%APPDATA%\HubFetch\credentials.json`，绝不入 localStorage；捕获的 Hub 网页会话可补足社区写操作
- 三种封闭代理模式：**系统**（默认，继承系统代理）/ **直连**（绕过一切代理）/ **手动**（指定 HTTP(S) 代理）；代理同时作用于 Hub API 与 git 子进程，语义见 [docs/architecture.md](docs/architecture.md#proxy-semantics)

### 安全模型（摘要）

- 渲染进程 sandbox + contextIsolation，禁用 Node 集成，严格 CSP
- 全部 IPC 通道为类型化契约（无魔法字符串），每个处理器校验输入
- 令牌仅发往 `huggingface.co` API 主机，绝不随重定向跨主机外发
- 克隆凭据走 Job 绑定的 AskPass 助手，拒绝非本应用克隆进程的请求
- 完整模型见 [docs/security.md](docs/security.md)；诊断页可导出脱敏支持包（[docs/troubleshooting.md](docs/troubleshooting.md)）

### 开发

构建依赖：Node.js ≥ 22、pnpm ≥ 11（`corepack enable`）、C++ 工具链（Windows 上为 VS Build Tools）、Git。

```sh
pnpm install        # 安装依赖并为 Electron 重建 better-sqlite3 与原生桥
pnpm dev            # 热重载启动应用
pnpm test           # 单元测试（vitest）
pnpm typecheck      # 全工作区严格 TS
pnpm lint           # ESLint（含 i18n 硬编码字符串检查）
pnpm package:win    # 打包未签名 Windows x64 ZIP
```

参与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全披露见 [SECURITY.md](SECURITY.md)。

### 文档

- 用户指南：[中文](docs/user-guide.zh-CN.md) ｜ [English](docs/user-guide.en.md)
- [架构](docs/architecture.md) ｜ [故障排查](docs/troubleshooting.md) ｜ [发布流程](docs/releasing.md) ｜ [路线图](docs/roadmap.md) ｜ [更新日志](docs/changelog.md)

### 许可与来源

本项目按 [Apache-2.0](LICENSE) 发布。源流链：Oh My HuggingFace（fzlzjerry，v0.0.9 快照）→ HubFetch（本仓库，独立演化）；导入凭证与修改披露见 [UPSTREAM_SOURCE.md](UPSTREAM_SOURCE.md)，第三方许可与归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 免责声明

本软件按"现状"提供，不附带任何明示或默示的保证。社区第三方项目，与 Hugging Face, Inc. 无关联。

---

## English

### What it is

HubFetch is a desktop workbench for the Hugging Face Hub on Windows. It is built around three jobs: **getting files down from the Hub** (downloads and git clones), **keeping the local cache under control**, and **seeing what is actually inside a repository**. Distributed as a single portable ZIP — no installer, no self-updater, no data collection.

### Where it comes from, and how it differs from Oh My HuggingFace

HubFetch started from a v0.0.9 snapshot of the open-source [Oh My HuggingFace](https://github.com/fzlzjerry/ohmyhf) project (fzlzjerry, Apache-2.0) and has evolved independently in this repository; the full import provenance is in [UPSTREAM_SOURCE.md](UPSTREAM_SOURCE.md). The two are maintained separately and have grown in different directions:

| | HubFetch | Oh My HuggingFace |
| --- | --- | --- |
| Platform & distribution | Windows x64 only, portable ZIP | macOS / Windows / Linux, packaged native formats |
| Updates | No self-updater; upgrade via Releases | In-app updates |
| Telemetry | None — no analytics, no phone-home | PostHog on by default (opt-out) |
| Cloning | git clone as a first-class workflow: clone manager, shallow clones, clone proxy, Xet support, dedicated credential helper | Primarily Hub API downloads |
| LLM assistance | Built-in LLM help (OpenAI / Anthropic / Gemini) with custom endpoints | —— |
| Mirrors | Configurable custom Hub endpoint (mirrors) | —— |

Browsing, search, sign-in, upload, favorites, follows, inbox, and history exist in both — HubFetch inherited and continues to evolve them; the table lists only where the projects genuinely diverge.

### Capabilities

- **Browsing & preview**: models / datasets / Spaces / Daily Papers in a three-pane UI; `Ctrl+K` command palette (filter by task, library, license; sort by trending / likes / downloads); model-card rendering with syntax highlighting; file trees and metadata; local `.parquet` dataset preview
- **Downloads**: parallel, resumable, SHA-256 verified, rate-limited, with system notifications; standard Hugging Face cache layout (blob + snapshot), interoperable with `transformers`, `hf`, and friends
- **Cloning**: git clone manager (shallow clones, destination picker, proxy, Xet storage support); credentials are passed through a named pipe by a dedicated helper — never via command line or environment
- **Cache management**: cache index, per-repo disk usage, integrity verification, one-click cleanup
- **Account & remote actions**: sign-in, upload, favorites, follows, inbox, history, discussions and PR comments, collections, repository and Space administration
- **Compare & export**: 2–4 models side by side; export downloads to Ollama / LM Studio / ComfyUI
- **Local inference**: Ollama integration
- **LLM assistance**: all three providers support custom base URLs and proxies
- **UI**: nine languages (EN / 简中 / 繁中 / JA / KO / DE / ES / FR / PT-BR), light and dark themes

### Requirements & installation

- Windows 10 / 11 (64-bit)
- **Git** and **Git-Xet**: cloning uses system-installed Git (with Xet support); neither is bundled — check readiness and jump to official download pages in **Settings → Clone tools**
- Grab `HubFetch-<version>-windows-x64.zip` from [Releases](https://github.com/OranImp/HubFetch/releases) (unsigned; SmartScreen may warn on first launch — see [docs/signing.md](docs/signing.md)), extract, and run `HubFetch.exe`

### Sign-in & proxies

- Paste a [Hugging Face access token](https://huggingface.co/settings/tokens) in **Settings → Account**; the token is encrypted via OS credential protection (safeStorage) at `%APPDATA%\HubFetch\credentials.json` and never kept in localStorage; a captured Hub web session adds cookie-backed social writes
- Three closed proxy modes: **System** (default) / **Direct** (bypass everything) / **Manual** (explicit HTTP(S) proxy); the choice applies to both Hub API traffic and Git clone child processes — semantics in [docs/architecture.md](docs/architecture.md#proxy-semantics)

### Security model (summary)

- Renderer runs with sandbox + contextIsolation, Node integration disabled, strict CSP
- The entire IPC surface is a typed contract — no magic strings; every handler validates its input
- The token is only ever sent to `huggingface.co` API hosts, never to redirect targets
- Clone auth goes through a Job-bound AskPass helper that refuses requests not from the app's own clone process
- Full model in [docs/security.md](docs/security.md); the Diagnostics page exports a sanitized support bundle ([docs/troubleshooting.md](docs/troubleshooting.md))

### Development

Build prerequisites: Node.js ≥ 22, pnpm ≥ 11 (`corepack enable`), a C++ toolchain (VS Build Tools on Windows), and Git.

```sh
pnpm install        # install deps and rebuild better-sqlite3 + the native bridge for Electron
pnpm dev            # launch the app with hot reload
pnpm test           # unit tests (vitest)
pnpm typecheck      # strict TS across the workspace
pnpm lint           # ESLint (includes i18n hardcoded-string checks)
pnpm package:win    # unsigned Windows x64 ZIP
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) for disclosure.

### Documentation

- User guide: [English](docs/user-guide.en.md) ｜ [中文](docs/user-guide.zh-CN.md)
- [Architecture](docs/architecture.md) ｜ [Troubleshooting](docs/troubleshooting.md) ｜ [Releasing](docs/releasing.md) ｜ [Roadmap](docs/roadmap.md) ｜ [Changelog](docs/changelog.md)

### License & provenance

Released under [Apache-2.0](LICENSE). Lineage: Oh My HuggingFace (fzlzjerry, v0.0.9 snapshot) → HubFetch (this repository, evolved independently); import provenance in [UPSTREAM_SOURCE.md](UPSTREAM_SOURCE.md), third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Disclaimer

Provided "as is", without warranty of any kind. A community project, not affiliated with Hugging Face, Inc.
