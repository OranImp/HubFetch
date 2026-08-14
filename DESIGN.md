# HubFetch Design System — Transfer Ledger

## 0. Research Log

- Embedded refs: shortlisted Native Fluent, Dark Operations, Transfer Ledger → selected Transfer Ledger because it is the user-owned direction and it concentrates one aesthetic risk on the product's real subject: long-running transfers. Native Fluent and Dark Operations are rejected comparison directions and must not be averaged into this system.
- Taste: operational brief → taste-skill discipline (dense but calm, truth before decoration, no decorative card grids). Raycast is reference material only for dense tool hierarchy and layered state readability; its dark chrome, red identity, pills, and heavy shadows are left out.
- Windows evidence (navigation, typography, writing, responsive, accessibility, motion): navigation-basics (flat top-level navigation, list/detail for frequent child switching), typography (Segoe UI Variable, 14/20 body, 12/16 captions, sentence case, Microsoft YaHei UI for Simplified Chinese), writing-style (active concise action labels; errors state what failed plus the next step), responsive-design (reveal the full list/detail layout only at wider widths), Qt accessibility (standard widgets expose accessible names, roles, and values), and motion (direct, brief transitions; omitted when they do not aid state or wayfinding).
- Unavailable lanes: lazyweb real-product screens and imagen concept drafts were skipped because the approved direction and the native-desktop subject make web-browser screens and generated drafts unreliable evidence; the deterministic Qt state captures in Todo 23 provide the visual evidence instead.

## 1. Atmosphere & Identity

A quiet Windows transfer console. Dense when the queue is full, calm when it is idle. The identity comes from the ledger metaphor: every task is a row in an immutable record, and the transfer-stage rail in the detail pane is the single expressive element that makes long-running transfers observable. No marketing hero, no decorative card grids, no copied branding — only the disciplined asymmetry of navigation, a stable task list, and flexible detail.

## 2. Personas

- power downloader: a keyboard-heavy engineer who creates repeated model/dataset tasks, scans the queue, copies revisions and paths, and expects complete tab order, accelerators, context commands, and no mouse-only action.
- occasional private-repo user: a researcher on unstable or proxied connectivity who needs dry-run size estimates, interruption recovery, actionable auth and gated-repo errors, and confidence that retry will not silently corrupt or overwrite work.
- support maintainer: the person who reads the sanitized support bundle and diagnostic logs; every error names its stage and provides one executable recovery action so triage happens at the point of failure.

## 3. Constraints

- cognitive: dense but calm — queue scanning and repeated actions are low-load; truth before decoration keeps displayed state aligned with persisted worker reality; one action, one outcome name.
- A11y (keyboard, focus, contrast, screen reader): full keyboard reachability with visible focus on every interactive element; WCAG 2.2 AA contrast floor (4.5:1 body / 3:1 large text); screen reader support through Qt accessible names, roles, and values; status conveyed by text, icon, and shape as well as color; no clipping of Chinese labels or long repository identifiers.
- Situational: a user may close or lose the GUI mid-transfer; startup recovery distinguishes interrupted from completed or cancelled work and offers the valid next action.

## 4. Content Inventory

- Primary surfaces: Tasks (queue order, kind, repo, stage/state, progress, selected detail), Cache (read-only inspection), Diagnostics, and Settings in the navigation footer.
- Transient surfaces: Download creation (file/snapshot), Clone creation, OAuth/token management.
- States with deliberate UI and copy: empty, loading, authenticating, gated, proxy failure, missing Git/Git-Xet, low disk, cancelling, interrupted, completed, error, failed.
- Long-content fixtures: long Chinese/English labels, unbroken URLs, long repo/revision paths, and 200% scaling are part of every content fixture set; primary content reflows to one readable column with no horizontal scroll at narrow widths.

## 5. Design Tokens

### 5.1 Color Palette

| Role | Token | Light | Usage |
|------|-------|-------|-------|
| Text/Ink | --ink | #202124 | Primary text |
| Canvas/background | --canvas | #F7F8FA | Application background |
| Surface | --surface | #FFFFFF | Panels, list, detail |
| Line/border | --line | #D9DEE7 | 1 px borders, separators |
| Signal Yellow | --signal-yellow | #FFD21E | Active-transfer stage identity (limited) |
| Action Blue | --action-blue | #2563EB | Commands, links, focus |

Rules:
- Never introduce a color not in this table; extend the table first.
- Dark and high-contrast variants are derived from Qt system roles (Section 9), not by recoloring these six values.
- Signal Yellow is never the only semantic cue for a state.

### 5.2 Typography

- Latin UI: Segoe UI Variable (Windows-provided), 14/20 body, 12/16 captions, sentence case.
- Simplified Chinese: Microsoft YaHei UI (Windows-provided; not redistributed by HubFetch).
- Technical data (paths, revisions, speeds, log excerpts): bundled Cascadia Mono under OFL 1.1 with Consolas fallback.
- No other font families enter the product.

### 5.3 Spacing

- Base unit is 4 px; all spacing derives from 4 px and 8 px steps.
- Controls and panels use 4-8 px padding; list rows use an 8 px vertical rhythm; no pills except compact status/filter chips.

### 5.4 Radii

- Border radii never exceed 8 px: 4 px for compact controls, 8 px for panels and dialogs; no pill-shaped controls.

### 5.5 Borders & Depth

- Depth strategy: borders only. Surfaces separate with 1 px Line (#D9DEE7) borders; no drop shadows, no tonal-shift blurs, no gradient fills, no orbs.
- Never nest cards inside cards; every surface is one level deep.

### 5.6 Icon Policy

- Use the bundled Lucide-compatible SVG icon set with recorded licenses; 16 px inline, 20 px in navigation and commands.
- No emoji icons; primary status pairs an icon with text; every icon has an accessible name or equivalent text.

## 6. Components

### 6.1 Primitive Anatomy

Primitives: navigation item, icon button with tooltip, text/action button, segmented control, checkbox/toggle, text/path/revision/proxy fields, repository-type selector, progress bar, status icon/text pair, task row, empty/error/loading blocks, inline recovery action, transfer-stage rail, log excerpt, dialog/sheet, focus ring. Fixed/min/max geometry contracts and keyboard focus apply to every primitive.

### 6.2 Component States

Every interactive primitive defines default, hover, pressed, focus, disabled, loading, empty, error states, with reduced-motion variants included. Status is never color-only, and disabled states are explained accessibly.

### 6.3 Transfer-Stage Rail

The transfer-stage rail is the only custom expressive control. It renders the stages resolve, authorize, transfer, verify, materialize/checkout with accessible text, icon, and status metadata, respects reduced motion, and never relies on color alone.

## 7. Motion

### 7.1 Timing

- State feedback runs at 83-167 ms opacity/transform transitions; the active-segment pulse on the transfer-stage rail runs at 120 ms.
- No decorative ambient animation; motion serves state or wayfinding only.

### 7.2 Reduced Motion

Under reduced-motion preferences the active-segment pulse is disabled and progress stays readable as static text and geometry.

## 8. Layout

### 8.1 Scroll Ownership

Each visible list/detail region has exactly one scroll owner; navigation never scrolls; fixed windows retain stable control geometry while updates stream in.

### 8.2 Breakpoints

<760 effective px: one pane (list or detail) with an explicit back command; 760-1179: navigation collapses to an icon rail/menu with the list/detail split retained; >=1180: fixed navigation, 360 px task list, and flexible detail.

## 9. Theme Mapping

- Light is locked (Section 5.1). Dark and high contrast variants are derived from Qt system roles (QPalette Window/Base/Text/Highlight/Button) mapped to semantic roles, not one-note recoloring of the light hex values.
- Signal Yellow never serves as the only semantic cue, and dark/high-contrast variants keep text, icon, and shape status semantics.

## 10. Localization

- Simplified Chinese is the default locale with complete English resources from the first release; no UI string literals exist outside the localization layer.
- Stable action/result pairs such as 取消任务 → 任务已取消 and 重试任务 → 已重新排队; every error names its failed stage and gives one executable recovery action, never a generic 发生错误.

## 11. Showcase

The Todo 23 showcase exercises every primitive and state at <760, 760-1179, and >=1180 effective px in light, dark, and high-contrast variants with 100%/200% scaling; a deterministic harness captures the PNG matrix before product screens are composed.

## 12. Visual QA

Capture light, dark, high contrast, and reduced-motion variants at the three widths (760/1180) and 100%/200% scaling for the shell, create flows, task states, Cache, Diagnostics, Settings, OAuth, and empty/loading/error/offline/gated/missing-dependency/cancelling/interrupted states; inspect the PNGs with look_at, then /visual-qa before handoff.

## 13. Accepted Debt

None accepted as of the contract date. Critical or Major accessibility/usability findings are repaired before handoff; Minor findings require an entry here with affected users, suggested fix, status, and explicit rationale.

## 14. Handoff

- Todo 23 builds the primitive showcase first; every token, type, spacing, radius, and motion value in code traces to this contract, and new tokens are added to DESIGN.md first.
- Visual QA gates each primitive and required state before product screens; any new reusable pattern is documented back into Section 6.
