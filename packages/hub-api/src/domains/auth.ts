import type { BillingUsage, UserProfile } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { mapBillingUsage, mapWhoAmI, mapWhoAmIAuth, type WhoAmIDetailed } from '../mappers'

export async function whoAmI(transport: HubTransport): Promise<UserProfile> {
  const { body } = await transport.getJson<unknown>(`${transport.endpoint}/api/whoami-v2`, { ttl: 0 })
  return mapWhoAmI(body as never, transport.endpoint)
}

export async function whoAmIWithToken(
  transport: HubTransport,
  token: string,
  opts: { timeoutMs?: number } = {}
): Promise<WhoAmIDetailed> {
  const url = `${transport.endpoint}/api/whoami-v2`
  const response = await transport.requestWithToken(url, token, opts.timeoutMs ?? 15_000)
  return mapWhoAmIAuth((await response.json()) as never, transport.endpoint)
}

export async function whoAmIWithCookie(
  transport: HubTransport,
  cookie: string,
  opts: { timeoutMs?: number } = {}
): Promise<WhoAmIDetailed> {
  const url = `${transport.endpoint}/api/whoami-v2`
  const response = await transport.requestWithCookie(url, cookie, opts.timeoutMs ?? 15_000)
  return mapWhoAmIAuth((await response.json()) as never, transport.endpoint)
}

export async function getBillingUsage(transport: HubTransport): Promise<BillingUsage> {
  const { body } = await transport.getJson<unknown>(`${transport.endpoint}/api/settings/billing/usage`, {
    ttl: 60_000
  })
  return mapBillingUsage(body as never)
}
