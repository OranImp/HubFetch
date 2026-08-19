// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadProxyOverride, ProxyConfig } from '@hubfetch/shared'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    })
  })
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { DownloadCreateDialog } from './DownloadCreateDialog'

const settingsProxy: ProxyConfig = { mode: 'system', manualUrl: 'http://127.0.0.1:7897' }

function renderDialog(onConfirm: (override: DownloadProxyOverride | null) => void): void {
  render(
    <DownloadCreateDialog
      open
      pending={false}
      settingsProxy={settingsProxy}
      onConfirm={onConfirm}
      onOpenChange={vi.fn()}
    />
  )
}

function startButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'downloads:create.start' })
}

function defaultCheckbox(): HTMLInputElement {
  return screen.getByRole('checkbox')
}

afterEach(() => {
  cleanup()
})

describe('DownloadCreateDialog', () => {
  it('confirms with null when the settings default is selected', () => {
    const onConfirm = vi.fn()
    renderDialog(onConfirm)
    const start = startButton()
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    expect(onConfirm).toHaveBeenCalledWith(null)
  })

  it('confirms an explicit system override after unchecking the default', () => {
    const onConfirm = vi.fn()
    renderDialog(onConfirm)
    fireEvent.click(defaultCheckbox())
    const start = startButton()
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('keeps Start disabled for an explicit Manual with an empty draft', () => {
    const onConfirm = vi.fn()
    renderDialog(onConfirm)
    fireEvent.click(defaultCheckbox())
    fireEvent.click(screen.getByRole('radio', { name: 'downloads:create.modeManual' }))
    const start = startButton()
    expect(start.disabled).toBe(true)
    fireEvent.click(start)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})