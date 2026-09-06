import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const SYNTHETIC_KEY = 'e2e-gemini-test-key'
export const MODEL_ID = 'gemini-2.0-flash'
export const ORIGINAL_BODY = 'Hello from the HubFetch translation fixture.'
export const TRANSLATED_BODY = 'Bonjour depuis le fixture de traduction HubFetch.'
export const SAME_LANG_BODY = 'Already-English same-language fixture body.'
export const RATE_LIMIT_BODY = 'Rate-limited translation fixture body.'
export const SLOW_BODY = 'Slow in-flight translation fixture body.'
export const RETRY_BODY = 'Retry recovered translation.'

export const POSTS = [
  { author: 'e2e-author', slug: 'e2e-post-1', rawContent: ORIGINAL_BODY },
  { author: 'e2e-same', slug: 'e2e-post-same', rawContent: SAME_LANG_BODY },
  { author: 'e2e-limit', slug: 'e2e-post-limit', rawContent: RATE_LIMIT_BODY },
  { author: 'e2e-slow', slug: 'e2e-post-slow', rawContent: SLOW_BODY }
] as const

export const EVIDENCE_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '.omo',
  'evidence',
  'post-translation-llm-v030',
  'task-13-post-translation-llm-v030'
)

export type LedgerEntry = {
  kind: 'hub' | 'gemini'
  method: string
  path: string
  googKeyHeader: boolean
  keyInUrl: boolean
  keyInBody: boolean
  aborted: boolean
}

export type WireFakes = {
  hubUrl: string
  geminiUrl: string
  ledger: LedgerEntry[]
  rateLimitHits: number
  inflightSlow: number
  close: () => Promise<void>
}

export function electronEnv(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.HUBFETCH_USER_DATA_DIR = userDataDir
  env.HUBFETCH_CREDENTIALS_DIR = userDataDir
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
  return env
}

export async function launchDesktop(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: join(__dirname, '..'),
    env: electronEnv(userDataDir)
  })
}

export function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'hubfetch-e2e-translate-'))
}

export async function waitForMain(page: Page): Promise<void> {
  await page.waitForSelector('aside nav', { timeout: 30_000 })
  await page.waitForSelector('main', { timeout: 15_000 })
}

export async function seedNetwork(page: Page, hubUrl: string, locale = 'en'): Promise<void> {
  await page.evaluate(async (payload) => {
    await window.hubfetch.invoke('settings:set', {
      patch: {
        hubEndpoint: payload.hubUrl,
        proxy: { mode: 'direct', manualUrl: 'http://127.0.0.1:7897' },
        locale: payload.locale,
        theme: 'light'
      }
    })
  }, { hubUrl, locale })
}

export async function seedGemini(page: Page, geminiUrl: string): Promise<void> {
  await page.evaluate(async (payload) => {
    await window.hubfetch.invoke('settings:set', {
      patch: {
        llm: {
          activeProvider: 'gemini',
          providers: {
            openai: { modelId: '', baseUrl: null },
            anthropic: { modelId: '', baseUrl: null },
            gemini: { modelId: payload.modelId, baseUrl: payload.geminiUrl }
          }
        }
      }
    })
    await window.hubfetch.invoke('llm:set-credential', {
      provider: 'gemini',
      apiKey: payload.key
    })
  }, { geminiUrl, modelId: MODEL_ID, key: SYNTHETIC_KEY })
}

/** Persist locale/network/LLM, reload the renderer, then restore the in-memory key. */
export async function bootTranslation(
  page: Page,
  hubUrl: string,
  geminiUrl: string,
  locale = 'en'
): Promise<void> {
  await seedNetwork(page, hubUrl, locale)
  await seedGemini(page, geminiUrl)
  await reloadShell(page)
  await seedGemini(page, geminiUrl)
}

export async function reloadShell(page: Page): Promise<void> {
  await page.evaluate(() => globalThis.location.reload()).catch(() => undefined)
  await waitForMain(page)
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
}

export function attachConsoleGuard(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => {
    lines.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    lines.push(`[pageerror] ${err.message}`)
  })
  return lines
}

export function writeEvidence(name: string, body: string): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), body, 'utf8')
}

export function assertNoKeyLeak(lines: readonly string[], ledger: readonly LedgerEntry[]): void {
  for (const line of lines) {
    if (line.includes(SYNTHETIC_KEY)) {
      throw new Error(`synthetic key leaked in console: ${line}`)
    }
  }
  for (const entry of ledger) {
    if (entry.keyInUrl || entry.keyInBody) {
      throw new Error(`synthetic key leaked on ${entry.kind} ${entry.method} ${entry.path}`)
    }
  }
}
