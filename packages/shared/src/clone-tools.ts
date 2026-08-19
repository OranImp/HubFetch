/**
 * Clone-tools catalog: the single source of official HTTPS download pages and
 * winget strings for the clone prerequisites (Git, Git-Xet, GCM).
 *
 * C reservation: a later plan may spawn allowlisted winget reading `wingetId`
 * from this catalog — no types for that.
 */

export type CloneToolId = 'git' | 'git-xet' | 'gcm'

export interface CloneToolEntry {
  id: CloneToolId
  /** Official HTTPS page opened with system:openExternal. */
  installUrl: string
  /** Winget package id; null when no current package exists (GCM). */
  wingetId: string | null
  /** Full winget install command; null when no current package exists. */
  wingetCommand: string | null
  /** One-time post-install configuration command (git-xet only). */
  configureCommand?: string
  /** Required-for-clone flag (git only). */
  required?: boolean
}

export const CLONE_TOOLS: Record<CloneToolId, CloneToolEntry> = {
  git: {
    id: 'git',
    installUrl: 'https://git-scm.com/download/win',
    wingetId: 'Git.Git',
    wingetCommand: 'winget install --id Git.Git -e',
    required: true
  },
  'git-xet': {
    id: 'git-xet',
    installUrl: 'https://huggingface.co/docs/hub/en/xet/using-xet-storage',
    wingetId: 'HuggingFace.Git-Xet',
    wingetCommand: 'winget install --id HuggingFace.Git-Xet -e',
    configureCommand: 'git xet install'
  },
  gcm: {
    id: 'gcm',
    installUrl: 'https://github.com/git-ecosystem/git-credential-manager/releases/latest',
    wingetId: null,
    wingetCommand: null
  }
}

export interface CloneToolRowActionInput {
  tool: CloneToolId | 'ssh'
  /** Diagnostics check status string; pass is the healthy status. */
  status: string
  /** True when the Git check passed (GCM row only; GCM ships with Git for Windows). */
  gitPass?: boolean
}

export interface CloneToolRowActions {
  showInstall: boolean
  showCopyWinget: boolean
  showCopyConfigure: boolean
  installUrl: string | null
  wingetCommand: string | null
  configureCommand: string | null
}

function noActions(): CloneToolRowActions {
  return {
    showInstall: false,
    showCopyWinget: false,
    showCopyConfigure: false,
    installUrl: null,
    wingetCommand: null,
    configureCommand: null
  }
}

/**
 * Per-row visibility table for clone-prerequisite rows:
 * - Git missing/failure -> install + copy winget.
 * - Xet missing or old -> install + copy winget.
 * - Xet uninitialized -> copy configure only (`git xet install`).
 * - GCM not pass AND Git pass -> install only (wingetCommand is null).
 * - GCM not pass AND Git missing -> all actions hidden.
 * - SSH any status -> all actions hidden.
 * - Any unlisted status -> all actions hidden.
 */
export function cloneToolRowActions(input: CloneToolRowActionInput): CloneToolRowActions {
  const { tool, status, gitPass } = input

  if (tool === 'ssh') return noActions()

  if (tool === 'git') {
    if (status === 'pass') return noActions()
    const entry = CLONE_TOOLS.git
    return {
      showInstall: true,
      showCopyWinget: true,
      showCopyConfigure: false,
      installUrl: entry.installUrl,
      wingetCommand: entry.wingetCommand,
      configureCommand: null
    }
  }

  if (tool === 'git-xet') {
    const entry = CLONE_TOOLS['git-xet']
    if (status === 'missing' || status === 'old') {
      return {
        showInstall: true,
        showCopyWinget: true,
        showCopyConfigure: false,
        installUrl: entry.installUrl,
        wingetCommand: entry.wingetCommand,
        configureCommand: null
      }
    }
    if (status === 'uninitialized') {
      return {
        showInstall: false,
        showCopyWinget: false,
        showCopyConfigure: true,
        installUrl: null,
        wingetCommand: null,
        configureCommand: entry.configureCommand ?? null
      }
    }
    return noActions()
  }

  // gcm
  if (status !== 'pass' && gitPass === true) {
    return {
      showInstall: true,
      showCopyWinget: false,
      showCopyConfigure: false,
      installUrl: CLONE_TOOLS.gcm.installUrl,
      wingetCommand: null,
      configureCommand: null
    }
  }
  return noActions()
}