import { describe, expect, it } from 'vitest'
import {
  parseManualProxyDraft,
  proxyConfigFromDraft,
  resolveCreateProxy,
  snapshotDisplay,
  type DownloadProxySelection
} from './proxy'

describe('parseManualProxyDraft (shared validation, not re-implemented)', () => {
  it('accepts an empty draft as "no URL yet"', () => {
    expect(parseManualProxyDraft('')).toEqual({ ok: true, value: null })
    expect(parseManualProxyDraft('   ')).toEqual({ ok: true, value: null })
  })

  it('normalizes a valid http(s) host:port draft', () => {
    expect(parseManualProxyDraft('http://127.0.0.1:7897')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:7897'
    })
    expect(parseManualProxyDraft('  https://proxy.example.com:8443  ')).toEqual({
      ok: true,
      value: 'https://proxy.example.com:8443'
    })
    expect(parseManualProxyDraft('http://127.0.0.1:7897/')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:7897'
    })
  })

  it('rejects credential-bearing and malformed drafts exactly like the IPC schema', () => {
    for (const bad of [
      'http://user:pass@127.0.0.1:7897',
      'http://user@127.0.0.1:7897',
      'ftp://127.0.0.1:7897',
      'http://127.0.0.1:7897/path',
      'http://127.0.0.1:7897?x=1',
      'http://127.0.0.1:7897#frag',
      'http://127.0.0.1',
      '127.0.0.1:7897',
      'not-a-url',
      'http://127.0.0.1:0',
      'http://127.0.0.1:99999'
    ]) {
      expect(parseManualProxyDraft(bad), bad).toEqual({ ok: false })
    }
  })
})

describe('proxyConfigFromDraft', () => {
  const previous = { mode: 'system' as const, manualUrl: 'http://127.0.0.1:7897' }

  it('builds a manual config from a valid normalized draft', () => {
    expect(proxyConfigFromDraft('manual', 'http://10.0.0.1:3128', previous)).toEqual({
      ok: true,
      config: { mode: 'manual', manualUrl: 'http://10.0.0.1:3128' }
    })
  })

  it('rejects manual mode with an empty or invalid draft (no IPC call)', () => {
    expect(proxyConfigFromDraft('manual', '', previous)).toEqual({ ok: false })
    expect(proxyConfigFromDraft('manual', 'http://user:pass@x:1', previous)).toEqual({
      ok: false
    })
    expect(proxyConfigFromDraft('manual', '127.0.0.1:7897', previous)).toEqual({ ok: false })
  })

  it('retains the previous Manual seed when switching away from Manual', () => {
    expect(proxyConfigFromDraft('direct', '', previous)).toEqual({
      ok: true,
      config: { mode: 'direct', manualUrl: 'http://127.0.0.1:7897' }
    })
    expect(proxyConfigFromDraft('system', '  ', previous)).toEqual({
      ok: true,
      config: { mode: 'system', manualUrl: 'http://127.0.0.1:7897' }
    })
  })

  it('prefers a valid edited draft as the new remembered Manual URL', () => {
    expect(proxyConfigFromDraft('system', 'http://10.0.0.1:3128', previous)).toEqual({
      ok: true,
      config: { mode: 'system', manualUrl: 'http://10.0.0.1:3128' }
    })
  })

  it('falls back to the default seed when nothing was ever remembered', () => {
    expect(proxyConfigFromDraft('direct', '', { mode: 'direct', manualUrl: null })).toEqual({
      ok: true,
      config: { mode: 'direct', manualUrl: 'http://127.0.0.1:7897' }
    })
  })
})

describe('resolveCreateProxy (snapshot resolved only on confirmation)', () => {
  const sel = (partial: Partial<DownloadProxySelection>): DownloadProxySelection => ({
    useDefault: false,
    mode: 'system',
    manualUrl: '',
    ...partial
  })

  it('omits the override entirely when "Use settings default" is chosen', () => {
    expect(resolveCreateProxy(sel({ useDefault: true }))).toBeNull()
  })

  it('resolves explicit system and direct overrides', () => {
    expect(resolveCreateProxy(sel({ mode: 'system' }))).toEqual({ mode: 'system' })
    expect(resolveCreateProxy(sel({ mode: 'direct' }))).toEqual({ mode: 'direct' })
  })

  it('resolves an explicit manual override from a valid draft URL', () => {
    expect(resolveCreateProxy(sel({ mode: 'manual', manualUrl: 'http://127.0.0.1:7897' }))).toEqual(
      { mode: 'manual', url: 'http://127.0.0.1:7897' }
    )
  })

  it('never resolves a credential-bearing or empty manual override', () => {
    expect(resolveCreateProxy(sel({ mode: 'manual', manualUrl: '' }))).toBeNull()
    expect(resolveCreateProxy(sel({ mode: 'manual', manualUrl: 'http://u:p@x:1' }))).toBeNull()
    expect(resolveCreateProxy(sel({ mode: 'manual', manualUrl: '127.0.0.1:7897' }))).toBeNull()
  })
})

describe('snapshotDisplay (frozen task snapshot → badge parts)', () => {
  it('maps every closed mode to display parts with no endpoint for system/direct', () => {
    expect(snapshotDisplay({ mode: 'system' })).toEqual({ mode: 'system', url: null })
    expect(snapshotDisplay({ mode: 'direct' })).toEqual({ mode: 'direct', url: null })
    expect(snapshotDisplay({ mode: 'manual', url: 'http://127.0.0.1:7897' })).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:7897'
    })
  })
})
