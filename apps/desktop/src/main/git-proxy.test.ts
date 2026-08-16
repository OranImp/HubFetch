import { describe, expect, it } from 'vitest'
import { gitProxyContract, PROXY_ENV_KEYS } from './git-proxy'
import type { ProxySnapshot } from '@hubfetch/shared'

/**
 * The Git child-process proxy contract (Todo 20, wired for Todo 29's clone
 * surface later). A git child receives:
 *   Manual:  argv -c http.proxy=<url> -c https.proxy=<url>, env = parent env
 *   Direct:  argv -c http.proxy= -c https.proxy=, env = parent env minus
 *            proxy variables (the child alone is stripped; the parent
 *            environment is never mutated)
 *   System:  no proxy argv, env = parent env (git inherits OS handling)
 * `git config --global`/local are NEVER touched by the contract.
 */

const MANUAL: ProxySnapshot = { mode: 'manual', url: 'http://127.0.0.1:7897' }
const DIRECT: ProxySnapshot = { mode: 'direct' }
const SYSTEM: ProxySnapshot = { mode: 'system' }

describe('gitProxyContract', () => {
  it('Manual: emits -c http.proxy/-c https.proxy argv and inherits the parent env', () => {
    const base: NodeJS.ProcessEnv = { PATH: 'C:\\bin', HOME: 'C:\\Users\\me' }
    const contract = gitProxyContract(MANUAL, base)
    expect(contract.argv).toEqual([
      '-c',
      'http.proxy=http://127.0.0.1:7897',
      '-c',
      'https.proxy=http://127.0.0.1:7897'
    ])
    expect(contract.env).toEqual(base)
    // Parent env object untouched (pure function).
    expect(base).toEqual({ PATH: 'C:\\bin', HOME: 'C:\\Users\\me' })
  })

  it('Manual: keeps pre-existing proxy env variables when one is already present', () => {
    const base = { PATH: 'C:\\bin', HTTP_PROXY: 'http://9.9.9.9:1' }
    const contract = gitProxyContract(MANUAL, base)
    // argv pins the URL; the env is inherited verbatim (git uses argv -c over env).
    expect(contract.argv).toContain('http.proxy=http://127.0.0.1:7897')
    expect(contract.env).toEqual(base)
  })

  it('Direct: emits empty -c http.proxy/-c https.proxy and strips proxy vars from the CHILD env only', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: 'C:\\bin',
      HOME: 'C:\\Users\\me',
      http_proxy: 'http://10.0.0.1:1',
      https_proxy: 'http://10.0.0.1:2',
      all_proxy: 'http://10.0.0.1:3',
      HTTP_PROXY: 'http://10.0.0.1:4',
      HTTPS_PROXY: 'http://10.0.0.1:5',
      ALL_PROXY: 'http://10.0.0.1:6',
      NO_PROXY: 'localhost,127.0.0.1',
      TOKEN: 'hf_secret'
    }
    const contract = gitProxyContract(DIRECT, base)
    expect(contract.argv).toEqual(['-c', 'http.proxy=', '-c', 'https.proxy='])
    for (const key of PROXY_ENV_KEYS) {
      expect(contract.env).not.toHaveProperty(key)
    }
    // Non-proxy vars pass through untouched.
    expect(contract.env.PATH).toBe('C:\\bin')
    expect(contract.env.NO_PROXY).toBe('localhost,127.0.0.1')
    expect(contract.env.TOKEN).toBe('hf_secret')
    // The parent object is byte-for-byte untouched — Direct stripping never leaks.
    expect(base.http_proxy).toBe('http://10.0.0.1:1')
    expect(base.HTTP_PROXY).toBe('http://10.0.0.1:4')
  })

  it('System: no proxy argv, child env equals the parent env', () => {
    const base = { PATH: 'C:\\bin', HTTPS_PROXY: 'http://127.0.0.1:7897' }
    const contract = gitProxyContract(SYSTEM, base)
    expect(contract.argv).toEqual([])
    expect(contract.env).toEqual(base)
  })

  it('never mutates the real process.env when using the default base', () => {
    const before = { ...process.env }
    gitProxyContract(DIRECT)
    gitProxyContract(MANUAL)
    gitProxyContract(SYSTEM)
    expect(process.env).toEqual(before)
  })

  it('every mode is handled exhaustively with no fallback branch', () => {
    for (const snapshot of [MANUAL, DIRECT, SYSTEM]) {
      const contract = gitProxyContract(snapshot, {})
      expect(Array.isArray(contract.argv)).toBe(true)
      expect(typeof contract.env).toBe('object')
    }
  })
})
