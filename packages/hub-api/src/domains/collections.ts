import type {
  CollectionDetail,
  CollectionSearchResult,
  CollectionSummary
} from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import {
  mapCollectionDetail,
  mapCollectionSummary
} from '../mappers'

export async function searchCollections(
  transport: HubTransport,
  query: string
): Promise<CollectionSearchResult[]> {
  const url = new URL(`${transport.endpoint}/api/quicksearch`)
  url.searchParams.set('q', query)
  url.searchParams.set('type', 'collection')
  try {
    const { body } = await transport.getJson<{
      collections?: Array<{ _id?: string; title?: string; description?: string }>
    }>(url.toString(), { ttl: 60_000 })
    return (body.collections ?? [])
      .filter((collection) => collection._id && collection.title)
      .slice(0, 8)
      .map((collection) => ({
        slug: collection._id ?? '',
        title: collection.title ?? '',
        description: collection.description
      }))
  } catch {
    return []
  }
}

export async function listCollections(
  transport: HubTransport,
  owner: string
): Promise<CollectionSummary[]> {
  const url = new URL(`${transport.endpoint}/api/collections`)
  url.searchParams.set('owner', owner)
  url.searchParams.set('limit', '100')
  const { body } = await transport.getJson<unknown[]>(url.toString())
  return body.map((raw) => mapCollectionSummary(raw as never))
}

export async function getCollection(
  transport: HubTransport,
  slug: string
): Promise<CollectionDetail> {
  const { body } = await transport.getJson<unknown>(`${transport.endpoint}/api/collections/${slug}`)
  return mapCollectionDetail(body as never)
}

export async function createCollection(
  transport: HubTransport,
  input: { namespace: string; title: string; description?: string; private: boolean }
): Promise<CollectionDetail> {
  const payload: {
    title: string
    namespace: string
    private: boolean
    description?: string
  } = { title: input.title, namespace: input.namespace, private: input.private }
  if (input.description != null && input.description !== '') payload.description = input.description
  const response = await transport.sendJson('POST', `${transport.endpoint}/api/collections`, payload)
  return mapCollectionDetail((await response.json()) as never)
}

export async function updateCollection(
  transport: HubTransport,
  slug: string,
  patch: {
    title?: string
    description?: string
    private?: boolean
    position?: number
    theme?: string
  }
): Promise<void> {
  await transport.sendJson('PATCH', `${transport.endpoint}/api/collections/${slug}`, patch)
}

export async function deleteCollection(transport: HubTransport, slug: string): Promise<void> {
  await transport.sendJson('DELETE', `${transport.endpoint}/api/collections/${slug}`)
}

export async function addCollectionItem(
  transport: HubTransport,
  slug: string,
  item: { type: 'model' | 'dataset' | 'space' | 'paper'; id: string },
  note?: string
): Promise<void> {
  await transport.sendJson('POST', `${transport.endpoint}/api/collections/${slug}/items`, { item, note })
}

export async function updateCollectionItem(
  transport: HubTransport,
  slug: string,
  itemId: string,
  patch: { note?: string; position?: number }
): Promise<void> {
  await transport.sendJson(
    'PATCH',
    `${transport.endpoint}/api/collections/${slug}/items/${encodeURIComponent(itemId)}`,
    patch
  )
}

export async function removeCollectionItem(
  transport: HubTransport,
  slug: string,
  itemId: string
): Promise<void> {
  await transport.sendJson(
    'DELETE',
    `${transport.endpoint}/api/collections/${slug}/items/${encodeURIComponent(itemId)}`
  )
}
