// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticCheck } from '@hubfetch/shared'

const cloneTools = vi.hoisted(() => ({ performCloneToolInstall: vi.fn() }))

vi.mock('@/lib/clone-tools', () => cloneTools)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { ClonePrerequisiteRow } from './ClonePrerequisiteRow'

const CHECKED_AT = '2026-08-19T00:00:00.000Z'

function makeCheck(
  id: string,
  category: DiagnosticCheck['category'],
  status: DiagnosticCheck['status'],
  reasonCode: DiagnosticCheck['reasonCode'],
  message: string
): DiagnosticCheck {
  return { id, category, status, reasonCode, message, durationMs: 1, checkedAt: CHECKED_AT }
}

const DEFAULT_PROPS: ComponentProps<typeof ClonePrerequisiteRow> = {
  tool: 'git',
  label: 'Git',
  gitPass: false,
  message: 'Git is not installed'
}

function renderRow(props: Partial<ComponentProps<typeof ClonePrerequisiteRow>> = {}): void {
  render(<ClonePrerequisiteRow {...DEFAULT_PROPS} {...props} />)
}

afterEach(() => {
  cleanup()
  cloneTools.performCloneToolInstall.mockReset()
})

describe('ClonePrerequisiteRow', () => {
  it('offers install + copy winget when Git is missing', () => {
    renderRow({
      tool: 'git',
      check: makeCheck('git.version', 'git', 'failure', 'missing', 'Git is not installed')
    })
    const row = screen.getByTestId('clone-prereq-row-git')
    expect(within(row).getByRole('button', { name: 'clones:diagnostics.install' })).toBeTruthy()
    expect(
      within(row).getByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeTruthy()
  })

  it('offers install + copy winget when Git-Xet is outdated', () => {
    renderRow({
      tool: 'git-xet',
      label: 'Git-Xet',
      warning: true,
      check: makeCheck('git.xet', 'git', 'warning', 'outdated', 'Git-Xet is outdated')
    })
    const row = screen.getByTestId('clone-prereq-row-git-xet')
    expect(within(row).getByRole('button', { name: 'clones:diagnostics.install' })).toBeTruthy()
    expect(
      within(row).getByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeTruthy()
  })

  it('offers copy configure only when Git-Xet is installed but uninitialized', () => {
    renderRow({
      tool: 'git-xet',
      label: 'Git-Xet',
      warning: true,
      check: makeCheck(
        'git.xet',
        'git',
        'warning',
        'unconfigured',
        'Git-Xet filters are not configured'
      )
    })
    const row = screen.getByTestId('clone-prereq-row-git-xet')
    expect(within(row).queryByRole('button', { name: 'clones:diagnostics.install' })).toBeNull()
    expect(
      within(row).queryByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeNull()
    expect(
      within(row).getByRole('button', { name: 'clones:diagnostics.copyConfigure' })
    ).toBeTruthy()
  })

  it('offers GCM install only when Git passes', () => {
    renderRow({
      tool: 'gcm',
      label: 'Credential helper',
      warning: true,
      gitPass: true,
      check: makeCheck('git.gcm', 'credentials', 'failure', 'missing', 'GCM is not available')
    })
    const row = screen.getByTestId('clone-prereq-row-gcm')
    expect(within(row).getByRole('button', { name: 'clones:diagnostics.install' })).toBeTruthy()
    expect(
      within(row).queryByRole('button', { name: 'clones:diagnostics.copyWinget' })
    ).toBeNull()
  })

  it('hides GCM install when Git is missing too', () => {
    renderRow({
      tool: 'gcm',
      label: 'Credential helper',
      warning: true,
      gitPass: false,
      check: makeCheck('git.gcm', 'credentials', 'failure', 'missing', 'GCM is not available')
    })
    const row = screen.getByTestId('clone-prereq-row-gcm')
    expect(within(row).queryByRole('button', { name: 'clones:diagnostics.install' })).toBeNull()
  })

  it('never offers actions on the SSH row', () => {
    renderRow({
      tool: 'ssh',
      label: 'SSH agent',
      check: makeCheck('git.ssh', 'credentials', 'failure', 'missing', 'SSH is not available')
    })
    const row = screen.getByTestId('clone-prereq-row-ssh')
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('renders the compact drawer variant without actions for a passing check', () => {
    renderRow({
      compact: true,
      tool: 'git',
      message: 'Git is installed',
      check: makeCheck('git.version', 'git', 'pass', 'ok', 'Git is installed')
    })
    const row = screen.getByTestId('clone-prereq-row-git')
    expect(within(row).queryByRole('button')).toBeNull()
    expect(within(row).getByText('Git is installed')).toBeTruthy()
  })
})
