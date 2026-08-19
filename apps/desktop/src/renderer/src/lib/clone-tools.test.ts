import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLONE_TOOLS, cloneToolRowActions } from '@hubfetch/shared'
import { performCloneToolInstall } from './clone-tools'

const ipc = vi.hoisted(() => ({
  openExternal: vi.fn(),
  invoke: vi.fn()
}))

vi.mock('@/lib/ipc', () => ipc)

describe('CLONE_TOOLS catalog', () => {
  it('pins an official https install page for every entry', () => {
    for (const entry of Object.values(CLONE_TOOLS)) {
      expect(entry.installUrl.startsWith('https:')).toBe(true)
    }
  })

  it('pins the Git winget command and id', () => {
    expect(CLONE_TOOLS.git.wingetCommand).toBe('winget install --id Git.Git -e')
    expect(CLONE_TOOLS.git.wingetId).toBe('Git.Git')
  })

  it('pins the Git-Xet winget command, id, and configure command', () => {
    expect(CLONE_TOOLS['git-xet'].wingetCommand).toBe(
      'winget install --id HuggingFace.Git-Xet -e'
    )
    expect(CLONE_TOOLS['git-xet'].wingetId).toBe('HuggingFace.Git-Xet')
    expect(CLONE_TOOLS['git-xet'].configureCommand).toBe('git xet install')
  })

  it('leaves GCM winget fields null (no current winget package)', () => {
    expect(CLONE_TOOLS.gcm.wingetCommand).toBeNull()
    expect(CLONE_TOOLS.gcm.wingetId).toBeNull()
  })
})

describe('cloneToolRowActions visibility', () => {
  it('offers install + copy winget when Git is missing or failed', () => {
    const actions = cloneToolRowActions({ tool: 'git', status: 'missing' })
    expect(actions.showInstall).toBe(true)
    expect(actions.showCopyWinget).toBe(true)
    expect(actions.showCopyConfigure).toBe(false)
    expect(actions.installUrl).toBe('https://git-scm.com/download/win')
    expect(actions.wingetCommand).toBe('winget install --id Git.Git -e')
  })

  it('offers install + copy winget when Git-Xet is missing or old', () => {
    for (const status of ['missing', 'old']) {
      const actions = cloneToolRowActions({ tool: 'git-xet', status })
      expect(actions.showInstall).toBe(true)
      expect(actions.showCopyWinget).toBe(true)
      expect(actions.showCopyConfigure).toBe(false)
    }
  })

  it('offers copy configure only when Git-Xet is uninitialized', () => {
    const actions = cloneToolRowActions({ tool: 'git-xet', status: 'uninitialized' })
    expect(actions.showInstall).toBe(false)
    expect(actions.showCopyWinget).toBe(false)
    expect(actions.showCopyConfigure).toBe(true)
    expect(actions.installUrl).toBeNull()
    expect(actions.wingetCommand).toBeNull()
    expect(actions.configureCommand).toBe('git xet install')
  })

  it('offers GCM install only when Git passes', () => {
    const actions = cloneToolRowActions({ tool: 'gcm', status: 'missing', gitPass: true })
    expect(actions.showInstall).toBe(true)
    expect(actions.showCopyWinget).toBe(false)
    expect(actions.showCopyConfigure).toBe(false)
    expect(actions.wingetCommand).toBeNull()
  })

  it('hides GCM install when Git is missing too', () => {
    const actions = cloneToolRowActions({ tool: 'gcm', status: 'missing', gitPass: false })
    expect(actions.showInstall).toBe(false)
    expect(actions.showCopyWinget).toBe(false)
    expect(actions.showCopyConfigure).toBe(false)
  })

  it('hides every action for unlisted or non-actionable statuses', () => {
    for (const input of [
      { tool: 'git', status: 'pass' },
      { tool: 'git-xet', status: 'pass' },
      { tool: 'git-xet', status: 'timeout' },
      { tool: 'git-xet', status: 'nonzero' },
      { tool: 'git-xet', status: 'unknown' },
      { tool: 'gcm', status: 'pass', gitPass: true },
      { tool: 'ssh', status: 'missing' },
      { tool: 'ssh', status: 'pass' }
    ] as const) {
      const actions = cloneToolRowActions(input)
      expect(actions.showInstall, JSON.stringify(input)).toBe(false)
      expect(actions.showCopyWinget, JSON.stringify(input)).toBe(false)
      expect(actions.showCopyConfigure, JSON.stringify(input)).toBe(false)
      expect(actions.installUrl, JSON.stringify(input)).toBeNull()
    }
  })
})

describe('performCloneToolInstall dispatcher', () => {
  beforeEach(() => {
    ipc.openExternal.mockClear()
    ipc.invoke.mockClear()
  })

  it('opens the catalog install page once and never calls invoke', () => {
    performCloneToolInstall('git')
    expect(ipc.openExternal).toHaveBeenCalledTimes(1)
    expect(ipc.openExternal).toHaveBeenCalledWith('https://git-scm.com/download/win')
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})