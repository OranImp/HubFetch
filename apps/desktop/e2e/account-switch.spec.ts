import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

function signedInAccountId(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('state' in result)) {
    throw new Error('sign-in result missing state')
  }
  const state = result.state
  if (typeof state !== 'object' || state === null || !('accountId' in state)) {
    throw new Error('sign-in state missing accountId')
  }
  if (typeof state.accountId !== 'string') throw new Error('accountId is not a string')
  return state.accountId
}

const SUMMARY = {
  id: 'org/tiny',
  kind: 'model' as const,
  author: 'org',
  name: 'tiny',
  likes: 0,
  downloads: 0,
  private: false,
  gated: false,
  tags: [] as string[]
}

/**
 * Two saved accounts A→B→A: remote whoami and query identity follow the
 * validated switch, Hub requests never mix tokens after the switch, and
 * device-global favorites/history survive.
 */
test('switching A→B→A changes remote results with zero cross-account Hub requests', async () => {
  const bearers: string[] = []
  const hub = createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    if (req.url?.startsWith('/api/whoami-v2') === true || req.url?.startsWith('/api/models') === true) {
      if (auth.startsWith('Bearer ')) bearers.push(auth.slice('Bearer '.length))
    }
    if (req.url?.startsWith('/api/whoami-v2') === true) {
      const token = auth === 'Bearer hf_e2e_a' ? 'a' : auth === 'Bearer hf_e2e_b' ? 'b' : null
      if (token) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            name: token === 'a' ? 'user-a' : 'user-b',
            fullname: token === 'a' ? 'User A' : 'User B',
            orgs: [],
            auth: {
              type: 'access_token',
              accessToken: { displayName: `token-${token}`, role: 'write' }
            }
          })
        )
        return
      }
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid credentials' }))
      return
    }
    if (req.url?.startsWith('/api/models') === true) {
      const owner = auth === 'Bearer hf_e2e_a' ? 'user-a' : auth === 'Bearer hf_e2e_b' ? 'user-b' : 'anon'
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ id: `${owner}/private-repo`, modelId: `${owner}/private-repo` }]))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not mocked' }))
  })
  await new Promise<void>((resolve) => {
    hub.listen(0, '127.0.0.1', resolve)
  })
  const endpoint = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
  const userDataDir = mkdtempSync(join(tmpdir(), 'hubfetch-e2e-acct-'))
  const app = await electron.launch({
    args: ['.'],
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      HUBFETCH_USER_DATA_DIR: userDataDir,
      HUBFETCH_CREDENTIALS_DIR: userDataDir
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('aside nav', { timeout: 30_000 })
    await page.evaluate(
      (hubEndpoint) => window.hubfetch.invoke('settings:set', { patch: { hubEndpoint } }),
      endpoint
    )

    const signA = await page.evaluate(() =>
      window.hubfetch.invoke('auth:signInWithToken', { token: 'hf_e2e_a' })
    )
    expect(signA).toMatchObject({ ok: true, state: { user: { name: 'user-a' } } })
    const accountA = signedInAccountId(signA)

    await page.evaluate((summary) => window.hubfetch.invoke('favorites:add', { summary }), SUMMARY)
    await page.evaluate((summary) => window.hubfetch.invoke('history:record', { summary }), SUMMARY)

    const signB = await page.evaluate(() =>
      window.hubfetch.invoke('auth:signInWithToken', { token: 'hf_e2e_b' })
    )
    expect(signB).toMatchObject({ ok: true, state: { user: { name: 'user-b' } } })
    const accountB = signedInAccountId(signB)

    const afterB = bearers.length
    const switchA = await page.evaluate(
      (accountId) => window.hubfetch.invoke('auth:switchAccount', { accountId }),
      accountA
    )
    expect(switchA).toMatchObject({
      ok: true,
      state: { user: { name: 'user-a' }, accountId: accountA }
    })
    await page.evaluate(() => window.hubfetch.invoke('auth:refreshUser', undefined))
    const afterA = bearers.slice(afterB)
    expect(afterA.every((token) => token === 'hf_e2e_a')).toBe(true)
    expect(afterA.some((token) => token === 'hf_e2e_b')).toBe(false)

    const switchB = await page.evaluate(
      (accountId) => window.hubfetch.invoke('auth:switchAccount', { accountId }),
      accountB
    )
    expect(switchB).toMatchObject({ ok: true, state: { user: { name: 'user-b' } } })
    await page.evaluate(() => window.hubfetch.invoke('auth:refreshUser', undefined))
    const afterSwitchB = bearers.slice(afterB + afterA.length)
    expect(afterSwitchB.every((token) => token === 'hf_e2e_b')).toBe(true)
    expect(afterSwitchB.some((token) => token === 'hf_e2e_a')).toBe(false)

    const favorites = await page.evaluate(() => window.hubfetch.invoke('favorites:list', undefined))
    expect(favorites).toEqual(expect.arrayContaining([expect.objectContaining({ repoId: 'org/tiny' })]))
    const history = await page.evaluate(() => window.hubfetch.invoke('history:list', undefined))
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ repoId: 'org/tiny' })]))
  } finally {
    await app.close()
    hub.close()
  }
})
