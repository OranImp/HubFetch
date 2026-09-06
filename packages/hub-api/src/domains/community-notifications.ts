import type { NotificationsPage } from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { mapNotificationsPage } from '../mappers'

export async function getNotifications(
  transport: HubTransport,
  page = 0
): Promise<NotificationsPage> {
  const url = new URL(`${transport.endpoint}/api/notifications`)
  if (page > 0) url.searchParams.set('p', String(page))
  const { body } = await transport.getJson<unknown>(url.toString(), { ttl: 10_000 })
  return mapNotificationsPage(body as never, transport.endpoint)
}

export async function markNotificationsRead(
  transport: HubTransport,
  discussionIds: string[],
  read: boolean
): Promise<void> {
  const all = discussionIds.length === 0
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/notifications/mark-as-read${all ? '?applyToAll=true' : ''}`,
    all ? { read } : { discussionIds, read }
  )
}

export async function clearNotifications(transport: HubTransport): Promise<void> {
  await transport.sendJson('DELETE', `${transport.endpoint}/api/notifications?applyToAll=true`)
}
