import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ShortcutDetails } from 'electron'
import { NotificationService } from './notifications'
import {
  registerWindowsNotificationShortcut,
  removeWindowsNotificationShortcut,
  sanitizeReason,
  startMenuShortcutPath,
  type WindowsRegistrationDeps
} from './windows-notification-registration'

const AUMID = 'io.github.oranimp.hubfetch'
const APP_NAME = 'HubFetch'

function baseDeps(overrides: Partial<WindowsRegistrationDeps> = {}): WindowsRegistrationDeps {
  return {
    isPackaged: true,
    platform: 'win32',
    execPath: 'E:\\Apps\\HubFetch\\HubFetch.exe',
    appData: 'E:\\Users\\tester\\AppData\\Roaming',
    appName: APP_NAME,
    appUserModelId: AUMID,
    notificationsEnabled: true,
    writeShortcutLink: vi.fn(() => true),
    readShortcutLink: vi.fn(() => {
      throw new Error('ENOENT: shortcut does not exist')
    }),
    ...overrides
  }
}

function fakeDetails(target = 'E:\\Apps\\HubFetch\\HubFetch.exe'): ShortcutDetails {
  return { target }
}

describe('registerWindowsNotificationShortcut', () => {
  it('returns unsupported on non-Windows platforms without touching the shell', () => {
    const deps = baseDeps({ platform: 'linux' })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result).toEqual({ status: 'unsupported', reason: 'platform is not Windows' })
    expect(deps.writeShortcutLink).not.toHaveBeenCalled()
  })

  it('returns unsupported in development builds without touching the shell', () => {
    const deps = baseDeps({ isPackaged: false })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result).toEqual({ status: 'unsupported', reason: 'development build' })
    expect(deps.writeShortcutLink).not.toHaveBeenCalled()
  })

  it('returns disabled when notifications are disabled in settings', () => {
    const deps = baseDeps({ notificationsEnabled: false })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result).toEqual({
      status: 'disabled',
      reason: 'notifications disabled in settings'
    })
    expect(deps.writeShortcutLink).not.toHaveBeenCalled()
  })

  it('creates the HubFetch.lnk under the current-user Start Menu with target, icon, cwd, and AUMID', () => {
    const deps = baseDeps()
    const result = registerWindowsNotificationShortcut(deps)
    const expectedPath = startMenuShortcutPath(deps.appData, APP_NAME)
    expect(result).toEqual({ status: 'registered' })
    expect(deps.readShortcutLink).toHaveBeenCalledWith(expectedPath)
    expect(deps.writeShortcutLink).toHaveBeenCalledTimes(1)
    const [path, operation, options] = (deps.writeShortcutLink as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, 'create' | 'update' | 'replace', ShortcutDetails]
    expect(path).toBe(expectedPath)
    expect(operation).toBe('create')
    expect(options).toMatchObject({
      target: 'E:\\Apps\\HubFetch\\HubFetch.exe',
      cwd: 'E:\\Apps\\HubFetch',
      appUserModelId: AUMID,
      icon: 'E:\\Apps\\HubFetch\\HubFetch.exe',
      iconIndex: 0
    })
    expect(typeof options.description).toBe('string')
    expect(options.description).toContain('HubFetch')
  })

  it('repairs a stale target left after a portable folder move', () => {
    const deps = baseDeps({
      readShortcutLink: vi.fn(() => fakeDetails('D:\\OldLocation\\HubFetch.exe'))
    })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result).toEqual({ status: 'registered' })
    const [path, operation, options] = (deps.writeShortcutLink as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, 'create' | 'update' | 'replace', ShortcutDetails]
    expect(path).toBe(startMenuShortcutPath(deps.appData, APP_NAME))
    expect(operation).toBe('replace')
    expect(options?.target).toBe('E:\\Apps\\HubFetch\\HubFetch.exe')
  })

  it('refreshes an existing shortcut whose target already matches', () => {
    const deps = baseDeps({
      readShortcutLink: vi.fn(() => fakeDetails('E:\\Apps\\HubFetch\\HubFetch.exe'))
    })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result).toEqual({ status: 'registered' })
    const [path, operation] = (deps.writeShortcutLink as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, 'create' | 'update' | 'replace', ShortcutDetails]
    expect(path).toBe(startMenuShortcutPath(deps.appData, APP_NAME))
    expect(operation).toBe('update')
  })

  it('returns failed with a sanitized reason when writeShortcutLink returns false', () => {
    const deps = baseDeps({ writeShortcutLink: vi.fn(() => false) })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('writeShortcutLink returned false')
  })

  it('returns failed and never leaks a personal path when the shell throws', () => {
    const deps = baseDeps({
      writeShortcutLink: vi.fn(() => {
        throw new Error(
          "EACCES: permission denied, open 'E:\\Users\\tester\\AppData\\Roaming\\x.lnk'"
        )
      })
    })
    const result = registerWindowsNotificationShortcut(deps)
    expect(result.status).toBe('failed')
    expect(result.reason).toBeDefined()
    expect(result.reason).not.toMatch(/E:\\Users\\tester/)
    expect(result.reason).not.toMatch(/AppData/)
  })
})

describe('removeWindowsNotificationShortcut', () => {
  it('removes the shortcut only on packaged Windows builds during explicit cleanup', () => {
    const removed: string[] = []
    const result = removeWindowsNotificationShortcut({
      isPackaged: true,
      platform: 'win32',
      appData: 'E:\\Users\\tester\\AppData\\Roaming',
      appName: APP_NAME,
      existsSync: vi.fn(() => true),
      unlinkSync: vi.fn((p: string) => removed.push(p))
    })
    expect(result).toBe(true)
    expect(removed).toEqual([
      startMenuShortcutPath('E:\\Users\\tester\\AppData\\Roaming', APP_NAME)
    ])
  })

  it('is a no-op in dev builds and on non-Windows platforms', () => {
    for (const deps of [
      { isPackaged: false, platform: 'win32' as const },
      { isPackaged: true, platform: 'darwin' as const }
    ]) {
      const unlinkSync = vi.fn()
      const result = removeWindowsNotificationShortcut({
        ...deps,
        appData: 'E:\\Users\\tester\\AppData\\Roaming',
        appName: APP_NAME,
        existsSync: vi.fn(() => true),
        unlinkSync
      })
      expect(result).toBe(false)
      expect(unlinkSync).not.toHaveBeenCalled()
    }
  })

  it('never throws when the shortcut is already gone', () => {
    const result = removeWindowsNotificationShortcut({
      isPackaged: true,
      platform: 'win32',
      appData: 'E:\\Users\\tester\\AppData\\Roaming',
      appName: APP_NAME,
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn()
    })
    expect(result).toBe(false)
  })
})

describe('sanitizeReason', () => {
  it('strips drive-letter and user-profile paths from error messages', () => {
    expect(
      sanitizeReason(new Error('EACCES E:\\Users\\tester\\AppData\\Roaming\\Microsoft\\x.lnk'))
    ).not.toMatch(/E:\\Users|AppData|Microsoft/)
  })

  it('handles non-Error values', () => {
    expect(sanitizeReason('plain failure')).toContain('plain failure')
    expect(sanitizeReason(undefined)).toBe('undefined')
  })
})

describe('registration never disables in-app notifications', () => {
  it('keeps the system notification path when registration failed (in-app fallback preserved)', () => {
    // A failed registration must not flip notifications off: the service still
    // reads settings and attempts the backend (system path) at delivery time.
    const backend = {
      isSupported: vi.fn(() => true),
      create: vi.fn(() => ({
        on: vi.fn(),
        show: vi.fn()
      }))
    }
    const service = new NotificationService(
      { get: () => ({ notificationsEnabled: true }) },
      { t: (key) => key },
      undefined,
      backend
    )
    const failed = registerWindowsNotificationShortcut(
      baseDeps({ writeShortcutLink: vi.fn(() => false) })
    )
    expect(failed.status).toBe('failed')
    service.show('title', 'body')
    expect(backend.create).toHaveBeenCalledTimes(1)
  })
})

// --- Windows-only integration fixture -------------------------------------
// Runs a REAL Electron process (headless, no window) that performs exactly the
// product write (shell.writeShortcutLink with the AUMID), then inspects the
// resulting .lnk via PowerShell COM (WScript.Shell + Shell.Application) and
// asserts both the target path and the AUMID. Vitest runs under Node, so the
// real Electron binary is the only way to exercise the OS shortcut writer.
const fixtureRoots: string[] = []

describe.skipIf(process.platform !== 'win32')('Windows integration fixture', () => {
  const electronBin = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'node_modules',
    'electron',
    'dist',
    'electron.exe'
  )

  it('creates a shortcut with the exact target and AUMID and reads them back via PowerShell COM', () => {
    const tmp = mkdtempSync(join(process.env.TEMP ?? tmpdir(), 'hubfetch-lnk-fixture-'))
    fixtureRoots.push(tmp)
    const programs = join(tmp, 'Start Menu', 'Programs')
    mkdirSync(programs, { recursive: true })

    const probe = join(tmp, 'probe.cjs')
    writeFileSync(
      probe,
      `
const { app, shell } = require('electron')
const path = require('node:path')
app.whenReady().then(() => {
  try {
    const lnk = path.join(process.env.HF_PROGRAMS, 'HubFetch.lnk')
    const target = process.env.HF_TARGET
    const ok = shell.writeShortcutLink(lnk, 'create', {
      target,
      cwd: path.dirname(target),
      description: 'HubFetch - portable client',
      icon: target,
      iconIndex: 0,
      appUserModelId: process.env.HF_AUMID
    })
    const read = shell.readShortcutLink(lnk)
    console.log(JSON.stringify({ ok, target: read.target, aumid: read.appUserModelId }))
    app.exit(0)
  } catch (err) {
    console.log(JSON.stringify({ error: String(err) }))
    app.exit(1)
  }
})
`
    )

    const target = join(tmp, 'HubFetch', 'HubFetch.exe')
    const run = spawnSync(electronBin, ['--no-sandbox', probe], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HF_PROGRAMS: programs,
        HF_TARGET: target,
        HF_AUMID: AUMID
      }
    })
    expect(run.status, `electron exited ${run.status}: ${run.stderr}`).toBe(0)
    const out = JSON.parse(
      (run.stdout.split('\n').find((l) => l.includes('"ok"')) ?? '{}') as string
    ) as {
      ok?: boolean
      target?: string
      aumid?: string
      error?: string
    }
    expect(out.error ?? null).toBeNull()
    expect(out.ok).toBe(true)

    // Inspect the real .lnk with PowerShell COM: WScript.Shell for the target
    // and Shell.Application extended properties for the AUMID. Single-quoted
    // PowerShell strings treat a single backslash literally, so use the raw
    // Windows path (no doubling).
    const ps = [
      '$w=New-Object -ComObject WScript.Shell;',
      `$r=$w.CreateShortcut('${programs}\\HubFetch.lnk');`,
      'Write-Output ("TARGET="+$r.TargetPath);',
      '$sh=New-Object -ComObject Shell.Application;',
      `$f=$sh.Namespace('${programs}');`,
      "$i=$f.ParseName('HubFetch.lnk');",
      "Write-Output ('AUMID='+$i.ExtendedProperty('System.AppUserModel.ID'));"
    ].join(' ')
    const inspect = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      {
        encoding: 'utf8',
        timeout: 60_000
      }
    )
    const targetLine = inspect.split('\n').find((l) => l.startsWith('TARGET='))
    const aumidLine = inspect.split('\n').find((l) => l.startsWith('AUMID='))
    expect(targetLine?.trimEnd()).toBe(`TARGET=${target}`)
    expect(aumidLine?.trimEnd()).toBe(`AUMID=${AUMID}`)
  })
})

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
})
