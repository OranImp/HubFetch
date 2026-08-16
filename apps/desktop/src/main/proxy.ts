/**
 * App-level proxy policy for Chromium session traffic (and any net module use).
 * System keeps the OS route, Direct forces no proxy, and Manual pins
 * proxyRules to the normalized URL. Per-task/download routes are handled at
 * request execution (see the transport work); this is only the default
 * session's policy. Node fetch (HubClient / download workers) uses undici
 * ProxyAgent separately.
 */
import { session } from 'electron'
import type { ProxyConfig } from '@hubfetch/shared'

export async function applyAppProxy(config: ProxyConfig): Promise<void> {
  const ses = session.defaultSession
  if (config.mode === 'manual' && config.manualUrl) {
    await ses.setProxy({ proxyRules: config.manualUrl })
    return
  }
  await ses.setProxy({ mode: config.mode === 'direct' ? 'direct' : 'system' })
}
