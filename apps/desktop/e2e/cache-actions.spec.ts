import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { electronEnv, waitForMain } from './post-translation-harness'

async function launchCacheApp(
  userDataDir: string,
  cacheDir: string
): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: join(__dirname, '..'),
    env: { ...electronEnv(userDataDir), HF_HUB_CACHE: cacheDir },
    timeout: 60_000
  })
}

const COMMIT = 'a'.repeat(40)
const REPO_ID = 'fixture-org/tiny-gpt'
const CONTENT = 'hubfetch-cache-repair-payload\n'

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function writeCleanRepo(cacheDir: string): void {
  const repo = join(cacheDir, 'models--fixture-org--tiny-gpt')
  const hash = sha256Of(CONTENT)
  mkdirSync(join(repo, 'blobs'), { recursive: true })
  mkdirSync(join(repo, 'snapshots', COMMIT), { recursive: true })
  mkdirSync(join(repo, 'refs'), { recursive: true })
  writeFileSync(join(repo, 'blobs', hash), CONTENT)
  writeFileSync(join(repo, 'snapshots', COMMIT, 'config.json'), CONTENT)
  writeFileSync(join(repo, 'refs', 'main'), `${COMMIT}\n`)
}

function writeCorruptRepo(cacheDir: string): void {
  const repo = join(cacheDir, 'models--fixture-org--tiny-gpt')
  mkdirSync(join(repo, 'blobs'), { recursive: true })
  mkdirSync(join(repo, 'snapshots', COMMIT), { recursive: true })
  mkdirSync(join(repo, 'refs'), { recursive: true })
  writeFileSync(join(repo, 'snapshots', COMMIT, 'config.json'), 'corrupt-bytes')
  writeFileSync(join(repo, 'refs', 'main'), `${COMMIT}\n`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function startCacheHub(content: string): Promise<{ url: string; close: () => Promise<void> }> {
  const hash = sha256Of(content)
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/whoami-v2')) {
      if (req.headers.authorization === 'Bearer hf_e2e_good') {
        sendJson(res, 200, {
          name: 'e2e-user',
          fullname: 'E2E User',
          orgs: [],
          auth: { type: 'access_token', accessToken: { displayName: 'e2e-token', role: 'write' } }
        })
        return
      }
      sendJson(res, 401, { error: 'Invalid credentials' })
      return
    }
    if (url.pathname.includes('/resolve/')) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        ETag: `"${hash}"`,
        'x-linked-etag': hash,
        'x-repo-commit': COMMIT
      })
      res.end(content)
      return
    }
    sendJson(res, 200, {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

async function openCache(page: Page): Promise<void> {
  await page.evaluate(() => {
    globalThis.location.hash = '#/cache'
  })
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
}

function tempDirs(): { userDataDir: string; cacheDir: string } {
  const userDataDir = mkdtempSync(join(tmpdir(), 'hubfetch-cache-e2e-'))
  const cacheDir = join(userDataDir, 'hf-cache')
  mkdirSync(cacheDir, { recursive: true })
  return { userDataDir, cacheDir }
}

test('verifies a clean cache without typing', async () => {
  const { userDataDir, cacheDir } = tempDirs()
  writeCleanRepo(cacheDir)
  const app = await launchCacheApp(userDataDir, cacheDir)
  try {
    const page = await app.firstWindow()
    await waitForMain(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCache(page)
    await expect(page.getByText(REPO_ID).first()).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('cache-verify').click()
    await expect(page.getByTestId('cache-verify-clean')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('body')).not.toContainText(dirname(cacheDir).replace(/\\/g, ''))
    const axe = await new AxeBuilder({ page }).setLegacyMode().include('main').analyze()
    expect(
      axe.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))
    ).toEqual([])
  } finally {
    await app.close()
  }
})

test('repairs a corrupt snapshot copy through the plan dialog without typing', async () => {
  const hub = await startCacheHub(CONTENT)
  const { userDataDir, cacheDir } = tempDirs()
  writeCorruptRepo(cacheDir)
  const app = await launchCacheApp(userDataDir, cacheDir)
  try {
    const page = await app.firstWindow()
    await waitForMain(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(async (hubUrl: string) => {
      const api = (
        globalThis as unknown as {
          hubfetch: { invoke: (channel: string, req?: unknown) => Promise<unknown> }
        }
      ).hubfetch
      await api.invoke('settings:set', { patch: { hubEndpoint: hubUrl } })
      await api.invoke('auth:signInWithToken', { token: 'hf_e2e_good' })
    }, hub.url)
    await openCache(page)
    await expect(page.getByText(REPO_ID).first()).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('cache-verify').click()
    await expect(page.getByTestId('cache-verification-counts')).toContainText('1', {
      timeout: 30_000
    })
    await page.getByText(REPO_ID).first().click()
    await expect(page.getByTestId(`cache-issues-model:${REPO_ID}`)).toBeVisible()
    await page.getByTestId(`cache-repair-model:${REPO_ID}`).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByTestId('cache-plan-apply').click()
    await expect(page.getByTestId('cache-verify-clean')).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close()
    await hub.close()
  }
})
