import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const FROZEN_AT = '2026-01-15T00:00:00.000Z'
export const FROZEN_COMMIT = 'a'.repeat(40)
const DESKTOP = join(__dirname, '..')
const SCHEMA = readFileSync(join(__dirname, 'fixtures', 'visual-schema.sql'), 'utf8')

export type VisualProfile = {
  readonly userDataDir: string
  readonly cacheDir: string
}

export function electronEnv(
  profile: VisualProfile,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.HUBFETCH_USER_DATA_DIR = profile.userDataDir
  env.HUBFETCH_CREDENTIALS_DIR = profile.userDataDir
  env.HF_HUB_CACHE = profile.cacheDir
  env.TZ = 'UTC'
  env.LANG = 'en_US.UTF-8'
  env.LC_ALL = 'en_US.UTF-8'
  env.TMP = 'E:\\Programs\\Temp'
  env.TEMP = 'E:\\Programs\\Temp'
  env.PLAYWRIGHT_BROWSERS_PATH = 'E:\\Programs\\ms-playwright'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  return { ...env, ...extra }
}

export function createVisualProfile(): VisualProfile {
  const userDataDir = mkdtempSync(join(tmpdir(), 'hubfetch-visual-'))
  const cacheDir = join(userDataDir, 'hf-cache')
  return { userDataDir, cacheDir }
}

function writeRepo(cacheDir: string, folder: string, commit: string, bytes: number): void {
  const repo = join(cacheDir, folder)
  const blobName = commit
  const blobPath = join(repo, 'blobs', blobName)
  const snapshotFile = join(repo, 'snapshots', commit, 'config.json')
  mkdirSync(join(repo, 'blobs'), { recursive: true })
  mkdirSync(join(repo, 'snapshots', commit), { recursive: true })
  mkdirSync(join(repo, 'refs'), { recursive: true })
  writeFileSync(blobPath, 'x'.repeat(bytes))
  writeFileSync(snapshotFile, 'x'.repeat(bytes))
  writeFileSync(join(repo, 'refs', 'main'), `${commit}\n`)
  const frozen = new Date(FROZEN_AT)
  utimesSync(join(repo, 'snapshots', commit), frozen, frozen)
}

export function seedCache(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true })
  writeRepo(cacheDir, 'models--fixture-org--tiny-gpt', FROZEN_COMMIT, 256)
  writeRepo(cacheDir, 'models--fixture-org--vision-net', 'b'.repeat(40), 128)
}

export function seedDatabase(
  userDataDir: string,
  options: { hubUrl: string; cacheDir: string; locale: string; theme: 'light' | 'dark' }
): void {
  mkdirSync(userDataDir, { recursive: true })
  const db = new DatabaseSync(join(userDataDir, 'hubfetch.db'))
  db.exec(SCHEMA)
  const settings = {
    locale: options.locale,
    theme: options.theme,
    downloadConcurrency: 3,
    speedLimitBps: null,
    hfCacheDir: options.cacheDir,
    notificationsEnabled: false,
    pollIntervalMinutes: 30,
    uiScale: 100,
    hubEndpoint: options.hubUrl,
    proxy: { mode: 'direct', manualUrl: 'http://127.0.0.1:7897' },
    launchAtLogin: false,
    closeToTray: false,
    defaultHome: 'models',
    defaultRepoSort: 'trending',
    uiDensity: 'comfortable',
    accent: 'default',
    fontScale: 100,
    sidebarCollapsed: false,
    browsePageSize: 30,
    repoOpenTarget: 'app',
    historyLimit: 200,
    llm: {
      activeProvider: 'openai',
      providers: {
        openai: { modelId: '', baseUrl: null },
        anthropic: { modelId: '', baseUrl: null },
        gemini: { modelId: '', baseUrl: null }
      }
    }
  }
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('settings', JSON.stringify(settings))
  const filesJson = JSON.stringify([
    {
      path: 'config.json',
      size: 1_048_576,
      receivedBytes: 1_048_576,
      status: 'completed',
      verified: true
    }
  ])
  db.prepare(
    `INSERT INTO downloads (
      id, repo_id, kind, revision, status, total_bytes, received_bytes, files_json,
      created_at, completed_at, resolved_commit, endpoint, cache_dir, environment_version, proxy_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'visual-dl-1',
    'fixture-org/tiny-gpt',
    'model',
    'main',
    'completed',
    1_048_576,
    1_048_576,
    filesJson,
    FROZEN_AT,
    FROZEN_AT,
    FROZEN_COMMIT,
    options.hubUrl,
    options.cacheDir,
    1,
    'direct'
  )
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

export async function launchVisualApp(profile: VisualProfile): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.', '--force-device-scale-factor=1'],
    cwd: DESKTOP,
    env: electronEnv(profile)
  })
}

export async function waitForMain(page: Page): Promise<void> {
  await page.waitForSelector('aside nav', { timeout: 60_000 })
  await page.waitForSelector('main', { timeout: 15_000 })
}

export async function parkWindow(app: ElectronApplication, page: Page): Promise<void> {
  const win = await app.browserWindow(page)
  await win.evaluate((browserWindow) => {
    browserWindow.setSkipTaskbar(true)
    browserWindow.setPosition(-12000, -12000)
  })
}

export async function setBounds(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number
): Promise<void> {
  const win = await app.browserWindow(page)
  await win.evaluate(
    (browserWindow, bounds) => {
      browserWindow.setBounds({ x: 40, y: 40, width: bounds.width, height: bounds.height })
    },
    { width, height }
  )
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  })
  await session.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
}

export async function freezePage(page: Page, lang: 'en' | 'zh-CN'): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate((nextLang) => {
    document.documentElement.lang = nextLang
  }, lang)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
}

export async function reloadShell(page: Page): Promise<void> {
  await page.evaluate(() => globalThis.location.reload()).catch(() => undefined)
  await waitForMain(page)
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async (next) => {
    await window.hubfetch.invoke('settings:set', { patch: { theme: next } })
  }, theme)
  await reloadShell(page)
}

export async function setLocale(page: Page, locale: 'en' | 'zh-CN'): Promise<void> {
  await page.evaluate(async (next) => {
    await window.hubfetch.invoke('settings:set', { patch: { locale: next } })
  }, locale)
  await reloadShell(page)
}

export async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    globalThis.location.hash = next
  }, hash)
  await page.waitForTimeout(300)
}
