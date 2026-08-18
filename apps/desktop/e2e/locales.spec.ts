import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'

/**
 * All-nine-locale E2E (plan Todo 40): launches the BUILT app via the offscreen
 * bootstrap (repo headless policy — windows are never visible) and drives every
 * supported locale through the real UI. For each locale it persists the choice,
 * reloads the renderer (the app reads settings.locale at startup), waits for the
 * shell to render, and asserts NO missing-key console warning is emitted — the
 * signal that a catalog is incomplete or a visible string bypassed i18n.
 */
const BOOTSTRAP = join(
  __dirname,
  '..',
  '..',
  '..',
  '.omo',
  'scratch',
  'task-40',
  'bootstrap-offscreen.cjs'
)
const ELECTRON_EXE = join(
  __dirname,
  '..',
  '..',
  '..',
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
)
const DESKTOP = join(__dirname, '..')

const NINE_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-CN', 'zh-TW'] as const

async function waitForMain(page: Page): Promise<void> {
  await page.waitForSelector('aside nav', { timeout: 60_000 })
  await page.waitForSelector('main', { timeout: 15_000 })
}

test('all nine locales boot without missing-key console errors', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'hubfetch-locales-e2e-'))
  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [BOOTSTRAP],
    cwd: DESKTOP,
    env: {
      ...process.env,
      HUBFETCH_USER_DATA_DIR: userDataDir,
      HUBFETCH_CREDENTIALS_DIR: userDataDir,
      TMP: 'E:\\Programs\\Temp',
      TEMP: 'E:\\Programs\\Temp',
      PLAYWRIGHT_BROWSERS_PATH: 'E:\\Programs\\ms-playwright'
    }
  })

  try {
    const window = await app.firstWindow()
    const missingKeys: string[] = []
    window.on('console', (msg) => {
      const text = msg.text()
      if (/missingKey|i18next.*key.*not found|was not found in the/.test(text)) {
        missingKeys.push(`[${msg.type()}] ${text}`)
      }
    })

    await waitForMain(window)

    for (const locale of NINE_LOCALES) {
      // Persist the locale (the running renderer re-reads settings on reload).
      await window.evaluate(async (l) => {
        await window.hubfetch.invoke('settings:set', { patch: { locale: l } })
      }, locale)
      await window.evaluate(() => window.location.reload()).catch(() => undefined)
      await waitForMain(window)

      // The sidebar must render localized navigation — never a raw i18n key.
      const nav = await window.locator('aside nav').innerText()
      expect(nav, `locale ${locale} rendered a raw i18n key`).not.toMatch(
        /\b[a-z]+\.(title|label|nav|name|emptyTitle|emptyBody|menu)\b/
      )
    }

    expect(missingKeys, `missing-key console warnings across locales`).toEqual([])
  } finally {
    await app.close()
  }
})

test('user guide links referenced by the localized Help menu resolve to real docs', async () => {
  // The native menu must not embed filesystem paths: it opens the docs as GitHub
  // URLs. Assert the referenced doc files exist in the repository so the links
  // are real, and that no absolute local path is embedded in the menu source.
  const { readFileSync } = await import('node:fs')
  const menuSrc = readFileSync(join(DESKTOP, 'src', 'main', 'menu.ts'), 'utf8')
  const guideUrls = [...menuSrc.matchAll(/docs\/user-guide\.(en|zh-CN)\.md/g)].map((m) => m[0])
  expect(guideUrls.sort()).toEqual(['docs/user-guide.en.md', 'docs/user-guide.zh-CN.md'])

  const { existsSync } = await import('node:fs')
  for (const rel of guideUrls) {
    expect(existsSync(join(DESKTOP, '..', '..', rel)), `${rel} must exist`).toBe(true)
  }

  // No absolute filesystem path may be embedded in the menu (a drive path or a
  // __dirname-relative reference). Remote GitHub URLs legitimately contain ".md".
  // The leading \b excludes protocol URLs like `https:` — only a real drive
  // letter (`C:\` / `C:/`) is a word-boundary-followed-by-colon path.
  expect(menuSrc).not.toMatch(/\b[A-Za-z]:[\\/]/)
  expect(menuSrc).not.toMatch(/__dirname/)
})
