import type { RepoKind } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { RESOLVE_PREFIX } from '../constants'

export async function fetchRepoPage(
  transport: HubTransport,
  kind: RepoKind,
  repoId: string
): Promise<string> {
  const url = `${transport.endpoint}/${RESOLVE_PREFIX[kind]}${repoId}`
  const auth = transport.hasSessionCookie() ? ('cookie' as const) : ('token' as const)
  const response = await transport.request(url, {}, { auth })
  await transport.ensureOk(response, 'GET', url)
  return response.text()
}
