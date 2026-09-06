/**
 * Deterministic Playwright screenshot baselines (plan Todo 6).
 *
 * Marketing capture remains `capture-screenshots.spec.ts` (live Hub, gated by
 * CAPTURE_SCREENSHOTS). This file never talks to huggingface.co: it boots a
 * local Hub fixture, a frozen HF cache, and a pre-seeded downloads table.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { FIXTURE_MODEL_ID, startHubFixture, type HubFixture } from './visual-regression-fakes'
import {
  createVisualProfile,
  freezePage,
  go,
  launchVisualApp,
  parkWindow,
  seedCache,
  seedDatabase,
  setBounds,
  setLocale,
  setTheme,
  waitForMain,
  type VisualProfile
} from './visual-regression-harness'

const SHOT = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  scale: 'device' as const,
  fullPage: true
}

function masks(page: Page): Locator[] {
  return [page.locator('[data-visual-mask="timestamp"]'), page.locator('[data-visual-mask="path"]')]
}

test.describe.configure({ mode: 'serial' })

test.describe('visual regression baselines', () => {
  let fakes: HubFixture | undefined
  let profile: VisualProfile
  let app: ElectronApplication | undefined
  let page: Page

  function launched(): ElectronApplication {
    if (!app) throw new Error('visual regression app was not launched')
    return app
  }

  test.beforeAll(async () => {
    fakes = await startHubFixture()
    profile = createVisualProfile()
    seedCache(profile.cacheDir)
    seedDatabase(profile.userDataDir, {
      hubUrl: fakes.url,
      cacheDir: profile.cacheDir,
      locale: 'en',
      theme: 'light'
    })
    app = await launchVisualApp(profile)
    page = await app.firstWindow()
    await waitForMain(page)
    await parkWindow(app, page)
  })

  test.afterAll(async () => {
    if (app) await app.close()
    if (fakes) await fakes.close()
  })

  test('browse light 1280x860', async () => {
    await setTheme(page, 'light')
    await setBounds(launched(), page, 1280, 860)
    await go(page, `#/models/${FIXTURE_MODEL_ID}`)
    await expect(page.getByText(FIXTURE_MODEL_ID, { exact: false }).first()).toBeVisible({
      timeout: 20_000
    })
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('browse-light-1280x860.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('browse dark 1280x860', async () => {
    await setTheme(page, 'dark')
    await setBounds(launched(), page, 1280, 860)
    await go(page, `#/models/${FIXTURE_MODEL_ID}`)
    await expect(page.getByText(FIXTURE_MODEL_ID, { exact: false }).first()).toBeVisible({
      timeout: 20_000
    })
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('browse-dark-1280x860.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('cache 1280x860', async () => {
    await setTheme(page, 'light')
    await setBounds(launched(), page, 1280, 860)
    await go(page, '#/cache')
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('fixture-org/tiny-gpt').first()).toBeVisible({ timeout: 20_000 })
    await page.getByText('fixture-org/tiny-gpt').first().click()
    await expect(page.locator('[data-visual-mask="timestamp"]').first()).toBeVisible()
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('cache-1280x860.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('cache dark 1280x860', async () => {
    await setTheme(page, 'dark')
    await setBounds(launched(), page, 1280, 860)
    await go(page, '#/cache')
    await expect(page.getByText('fixture-org/tiny-gpt').first()).toBeVisible({ timeout: 20_000 })
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('cache-dark-1280x860.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('cache light 900x760', async () => {
    await setTheme(page, 'light')
    await setBounds(launched(), page, 900, 760)
    await go(page, '#/cache')
    await expect(page.getByText('fixture-org/tiny-gpt').first()).toBeVisible({ timeout: 20_000 })
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('cache-light-900x760.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('cache dark 900x760', async () => {
    await setTheme(page, 'dark')
    await setBounds(launched(), page, 900, 760)
    await go(page, '#/cache')
    await expect(page.getByText('fixture-org/tiny-gpt').first()).toBeVisible({ timeout: 20_000 })
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('cache-dark-900x760.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('cache zh-CN 900x760', async () => {
    await setLocale(page, 'zh-CN')
    await setTheme(page, 'light')
    await setBounds(launched(), page, 900, 760)
    await go(page, '#/cache')
    await expect(page.getByText('fixture-org/tiny-gpt').first()).toBeVisible({ timeout: 20_000 })
    await freezePage(page, 'zh-CN')
    await expect(page).toHaveScreenshot('cache-zh-CN-900x760.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('downloads 900x760', async () => {
    await setBounds(launched(), page, 900, 760)
    await go(page, '#/downloads')
    await expect(page.getByText('fixture-org/tiny-gpt').first()).toBeVisible({ timeout: 20_000 })
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('downloads-900x760.png', {
      ...SHOT,
      mask: masks(page)
    })
  })

  test('account settings 900x760', async () => {
    await setBounds(launched(), page, 900, 760)
    await page.getByRole('button', { name: /^(Settings|设置)$/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await freezePage(page, 'en')
    await expect(page).toHaveScreenshot('account-settings-900x760.png', {
      ...SHOT,
      mask: masks(page)
    })
    await page.keyboard.press('Escape')
  })

  test('zh-CN browse 900x760', async () => {
    await setLocale(page, 'zh-CN')
    await setBounds(launched(), page, 900, 760)
    await go(page, `#/models/${FIXTURE_MODEL_ID}`)
    await expect(page.getByText(FIXTURE_MODEL_ID, { exact: false }).first()).toBeVisible({
      timeout: 20_000
    })
    await freezePage(page, 'zh-CN')
    await expect(page).toHaveScreenshot('browse-zh-CN-900x760.png', {
      ...SHOT,
      mask: masks(page)
    })
  })
})
