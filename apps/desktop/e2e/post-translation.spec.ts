import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startWireFakes } from './post-translation-fakes'
import {
  assertNoKeyLeak,
  attachConsoleGuard,
  bootTranslation,
  EVIDENCE_DIR,
  launchDesktop,
  MODEL_ID,
  ORIGINAL_BODY,
  RATE_LIMIT_BODY,
  reloadShell,
  RETRY_BODY,
  SAME_LANG_BODY,
  seedNetwork,
  setBounds,
  SLOW_BODY,
  SYNTHETIC_KEY,
  tempProfile,
  TRANSLATED_BODY,
  waitForMain,
  writeEvidence
} from './post-translation-harness'

test.use({ trace: 'on', screenshot: 'on' })

const SETTINGS = /^(Settings|设置|設定|설정|Einstellungen|Configuración|Paramètres|Configurações)$/
const TRANSLATION = /^(Translation|翻译|翻譯|翻訳|번역|Übersetzung|Traducción|Traduction|Tradução)$/
const TEST = /^(Test connection|测试连接|測試連線|接続をテスト|연결 테스트|Verbindung testen|Probar conexión|Tester la connexion|Testar conexão)$/
const APPLY = /^(Apply|应用|套用|適用|적용|Anwenden|Aplicar|Appliquer)$/
const SAVE_KEY = /^(Save key|保存密钥|儲存金鑰|キーを保存|키 저장|Schlüssel speichern|Guardar clave|Enregistrer la clé|Salvar chave)$/
const TRANSLATE_EN = /Translate to English|翻译为English|翻譯為English|Englishに翻訳|English\(으\)로 번역|Ins English übersetzen|Traducir a English|Traduire en English|Traduzir para English/
const CONNECTED = /Connected in|连接成功|連線成功|接続できました|연결되었습니다|verbunden|Conectado|Connecté|Conectado em/i
const RATE_ERROR = /rate-limiting|限流|限制了|レート制限|제한|begrenzt|limitó|limité|limitou/i

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'es', 'fr', 'pt-BR'] as const

async function openTranslation(page: Page): Promise<void> {
  await page.getByRole('button', { name: SETTINGS }).first().click()
  await page.getByRole('button', { name: TRANSLATION }).click()
  await expect(page.getByRole('tab', { name: 'Gemini' })).toBeVisible()
}

async function closeSettings(page: Page): Promise<void> {
  const close = page.getByRole('button', { name: /^(Close|关闭|關閉|閉じる|닫기|Schließen|Cerrar|Fermer|Fechar)$/ })
  if (await close.count()) await close.click()
}

async function fillGemini(page: Page, baseUrl: string): Promise<void> {
  await page.getByRole('tab', { name: 'Gemini' }).click()
  const dialog = page.getByRole('dialog')
  const urlField = dialog.getByRole('textbox').nth(0)
  const modelField = dialog.getByRole('textbox').nth(1)
  const keyField = dialog.locator('input[type="password"]')
  await expect(urlField).toHaveAttribute('placeholder', /generativelanguage/)
  await urlField.fill(baseUrl)
  await modelField.fill(MODEL_ID)
  await keyField.fill(SYNTHETIC_KEY)
}

async function translateBody(page: Page, body: string): Promise<void> {
  await page.getByText(body).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: TRANSLATE_EN }).click()
}

test('settings-to-feed-to-detail translation against a Gemini wire fake', async () => {
  test.setTimeout(180_000)
  const fakes = await startWireFakes()
  const app = await launchDesktop(tempProfile())
  const consoleLines = [] as string[]
  try {
    const page = await app.firstWindow()
    consoleLines.push(...attachConsoleGuard(page))
    await waitForMain(page)
    await seedNetwork(page, fakes.hubUrl)
    await reloadShell(page)

    await openTranslation(page)
    await fillGemini(page, fakes.geminiUrl)
    await page.getByRole('button', { name: SAVE_KEY }).click()
    await expect(page.getByText(/^(Configured|已配置|已設定|設定済み|구성됨|Konfiguriert|Configurado|Configuré)$/)).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveValue('')
    await page.getByRole('button', { name: APPLY }).click()
    await expect(page.getByText('Translation settings saved.')).toBeVisible()
    await page.getByRole('button', { name: TEST }).click()
    await expect(page.getByRole('dialog').locator('p[role="status"]')).toContainText(CONNECTED, {
      timeout: 15_000
    })
    await closeSettings(page)

    await page.evaluate(() => {
      globalThis.location.hash = '#/'
    })
    await expect(page.getByText(ORIGINAL_BODY)).toBeVisible({ timeout: 20_000 })
    const feedUrl = page.url()
    await translateBody(page, ORIGINAL_BODY)
    await expect(page.getByText(TRANSLATED_BODY)).toBeVisible({ timeout: 15_000 })
    expect(page.url()).toBe(feedUrl)

    await page.getByRole('radio', { name: /^(Original|原文|원문)$/ }).click()
    await expect(page.getByText(ORIGINAL_BODY)).toBeVisible()
    await page.getByRole('radio', { name: /^(Translated|译文|譯文|訳文|번역문|Übersetzung|Traducción|Traduction|Tradução)$/ }).click()
    await expect(page.getByText(TRANSLATED_BODY)).toBeVisible()

    await translateBody(page, SAME_LANG_BODY)
    await expect(page.getByText(/Already in English|已是English|すでにEnglish|이미 English|Bereits auf English|Ya está en English|Déjà en English|Já está em English/)).toBeVisible({
      timeout: 15_000
    })

    await translateBody(page, RATE_LIMIT_BODY)
    await expect(page.getByRole('alert')).toContainText(RATE_ERROR, { timeout: 15_000 })
    await page.getByRole('button', { name: /^(Retry|重试|重試|再試行|다시 시도|Erneut versuchen|Reintentar|Réessayer|Tentar novamente)$/ }).click()
    await expect(page.getByText(RETRY_BODY)).toBeVisible({ timeout: 15_000 })

    await page.evaluate(() => {
      globalThis.location.hash = '#/posts/e2e-author/e2e-post-1'
    })
    await expect(page).toHaveURL(/#\/posts\/e2e-author\/e2e-post-1/)
    await expect(page.getByText(ORIGINAL_BODY)).toBeVisible({ timeout: 15_000 })
    await translateBody(page, ORIGINAL_BODY)
    await expect(page.getByText(TRANSLATED_BODY)).toBeVisible({ timeout: 15_000 })

    await page.evaluate(() => {
      globalThis.location.hash = '#/'
    })
    await expect(page.getByText(SLOW_BODY)).toBeVisible({ timeout: 15_000 })
    await translateBody(page, SLOW_BODY)
    await expect(page.getByText(/Translating|正在翻译|正在翻譯|翻訳中|번역 중|Wird übersetzt|Traduciendo|Traduction|Traduzindo/)).toBeVisible({
      timeout: 10_000
    })
    await expect.poll(() => fakes.inflightSlow, { timeout: 10_000 }).toBeGreaterThan(0)
    await page.evaluate(() => {
      globalThis.location.hash = '#/history'
    })
    await expect(page).toHaveURL(/#\/history/)
    await expect.poll(() => fakes.ledger.some((entry) => entry.aborted), { timeout: 10_000 }).toBe(true)
    expect(fakes.inflightSlow).toBe(0)

    const probes = fakes.ledger.filter(
      (entry) => entry.kind === 'gemini' && entry.path.includes(':generateContent')
    )
    expect(probes.length).toBeGreaterThanOrEqual(2)
    expect(probes.every((entry) => entry.googKeyHeader)).toBe(true)
    expect(probes.every((entry) => !entry.keyInUrl && !entry.keyInBody)).toBe(true)
    assertNoKeyLeak(consoleLines, fakes.ledger)
    expect(consoleLines.filter((line) => line.startsWith('[error]') || line.startsWith('[pageerror]'))).toEqual(
      []
    )
    writeEvidence('request-ledger.json', JSON.stringify(fakes.ledger, null, 2))
    writeEvidence('console.log', consoleLines.join('\n'))
  } finally {
    await app.close()
    await fakes.close()
  }
})

test('captures translation surfaces for nine locales at two viewports', async () => {
  test.setTimeout(480_000)
  const fakes = await startWireFakes()
  const app = await launchDesktop(tempProfile())
  const consoleLines = [] as string[]
  try {
    const page = await app.firstWindow()
    consoleLines.push(...attachConsoleGuard(page))
    await waitForMain(page)
    await bootTranslation(page, fakes.hubUrl, fakes.geminiUrl)

    writeEvidence('screenshots-started.txt', 'ok')
    const shot = async (name: string): Promise<void> => {
      await page.screenshot({ path: join(EVIDENCE_DIR, name), type: 'png' })
    }

    await setBounds(app, page, 1280, 860)
    await openTranslation(page)
    await expect(page.getByRole('tab', { name: 'Gemini' })).toBeVisible()
    await expect(page.locator('input[type="password"]')).toHaveValue('')
    await shot('en-1280-settings.png')
    await closeSettings(page)

    await page.evaluate(() => {
      globalThis.location.hash = '#/'
    })
    await expect(page.getByText(ORIGINAL_BODY)).toBeVisible({ timeout: 20_000 })
    await shot('en-1280-feed-original.png')
    await page.getByText(ORIGINAL_BODY).first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: TRANSLATE_EN })).toBeVisible()
    await shot('en-1280-feed-menu.png')
    await page.getByRole('menuitem', { name: TRANSLATE_EN }).click()
    await expect(page.getByText(TRANSLATED_BODY)).toBeVisible({ timeout: 15_000 })
    await shot('en-1280-feed-translated.png')

    await translateBody(page, SAME_LANG_BODY)
    await expect(page.getByText(/Already in English/)).toBeVisible({ timeout: 15_000 })
    await shot('en-1280-feed-same-language.png')

    await translateBody(page, RATE_LIMIT_BODY)
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 })
    await shot('en-1280-feed-failure.png')
    await page.getByRole('button', { name: /^Retry$/ }).click()
    await expect(page.getByText(RETRY_BODY)).toBeVisible({ timeout: 15_000 })

    await translateBody(page, SLOW_BODY)
    await expect(page.getByText(/Translating/)).toBeVisible({ timeout: 10_000 })
    await shot('en-1280-feed-loading.png')
    await page.keyboard.press('Escape')

    await page.evaluate(() => {
      globalThis.location.hash = '#/posts/e2e-author/e2e-post-1'
    })
    await expect(page.getByText(ORIGINAL_BODY)).toBeVisible({ timeout: 15_000 })
    await translateBody(page, ORIGINAL_BODY)
    await expect(page.getByText(TRANSLATED_BODY)).toBeVisible({ timeout: 15_000 })
    await shot('en-1280-detail-translated.png')

    for (const locale of LOCALES) {
      await bootTranslation(page, fakes.hubUrl, fakes.geminiUrl, locale)
      for (const [width, tag] of [
        [1280, '1280'],
        [800, 'narrow']
      ] as const) {
        await setBounds(app, page, width, 860)
        await openTranslation(page)
        await expect(page.getByRole('tab', { name: 'Gemini' })).toBeVisible()
        await expect(page.locator('input[type="password"]')).toHaveValue('')
        await shot(`${locale}-${tag}-settings.png`)
        await closeSettings(page)
        await page.evaluate(() => {
          globalThis.location.hash = '#/'
        })
        await expect(page.getByText(ORIGINAL_BODY)).toBeVisible({ timeout: 20_000 })
        await shot(`${locale}-${tag}-feed.png`)
      }
    }

    assertNoKeyLeak(consoleLines, fakes.ledger)
    writeEvidence('screenshots-console.log', consoleLines.join('\n'))
  } finally {
    await app.close()
    await fakes.close()
  }
})
