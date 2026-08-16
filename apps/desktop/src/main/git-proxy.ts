/**
 * Git child-process proxy contract (Todo 20).
 *
 * Each git child receives:
 *   Manual:  argv `-c http.proxy=<url> -c https.proxy=<url>`, env = parent env
 *   Direct:  argv `-c http.proxy= -c https.proxy=` plus a child environment
 *            with the proxy variables STRIPPED (only the child is stripped;
 *            the parent environment object is never mutated)
 *   System:  no proxy argv, env = parent env (git inherits OS handling)
 *
 * `git config --global`/local are NEVER mutated by this contract; Todo 29's
 * clone surface consumes the argv/env it produces.
 */
import type { ProxySnapshot } from '@hubfetch/shared'

export const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY'
] as const

export interface GitProxyContract {
  /** Extra argv inserted into the git child command (before any other args). */
  argv: string[]
  /** Child environment: parent env plus mode-specific changes only. */
  env: NodeJS.ProcessEnv
  /** Stable mode label for logs; never contains credentials. */
  label: 'system' | 'direct' | 'manual'
}

export function gitProxyContract(
  snapshot: ProxySnapshot,
  baseEnv: NodeJS.ProcessEnv = process.env
): GitProxyContract {
  switch (snapshot.mode) {
    case 'manual':
      return {
        argv: ['-c', `http.proxy=${snapshot.url}`, '-c', `https.proxy=${snapshot.url}`],
        env: { ...baseEnv },
        label: 'manual'
      }
    case 'direct': {
      const env: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(baseEnv)) {
        if (key && value !== undefined && !(PROXY_ENV_KEYS as readonly string[]).includes(key)) {
          env[key] = value
        }
      }
      return { argv: ['-c', 'http.proxy=', '-c', 'https.proxy='], env, label: 'direct' }
    }
    case 'system':
      return { argv: [], env: { ...baseEnv }, label: 'system' }
  }
}
