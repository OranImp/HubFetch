import type {
  SpaceHardwareCatalogEntry,
  SpaceHardwareFlavor,
  SpaceRuntime,
  SpaceSecret,
  SpaceVariable
} from '@hubfetch/shared'
import type { HubTransport } from '../core/transport'
import { mapSpaceHardwareCatalog, mapSpaceRuntime, mapSpaceSecrets, mapSpaceVariables } from '../mappers'

const SPACE_LOGS_MAX_BYTES = 64 * 1024
const SPACE_LOGS_WINDOW_MS = 2500

function sseDataText(raw: string): string {
  const lines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length)
    lines.push(payload.startsWith(' ') ? payload.slice(1) : payload)
  }
  return lines.join('\n')
}

export async function listSpaceSecrets(
  transport: HubTransport,
  repoId: string
): Promise<SpaceSecret[]> {
  const { body } = await transport.getJson<unknown>(`${transport.endpoint}/api/spaces/${repoId}/secrets`)
  return mapSpaceSecrets(body as never)
}

export async function setSpaceSecret(
  transport: HubTransport,
  repoId: string,
  key: string,
  value: string,
  description?: string
): Promise<void> {
  await transport.sendJson('POST', `${transport.endpoint}/api/spaces/${repoId}/secrets`, {
    key,
    value,
    description
  })
}

export async function deleteSpaceSecret(
  transport: HubTransport,
  repoId: string,
  key: string
): Promise<void> {
  await transport.sendJson('DELETE', `${transport.endpoint}/api/spaces/${repoId}/secrets`, { key })
}

export async function listSpaceVariables(
  transport: HubTransport,
  repoId: string
): Promise<SpaceVariable[]> {
  const { body } = await transport.getJson<unknown>(`${transport.endpoint}/api/spaces/${repoId}/variables`)
  return mapSpaceVariables(body as never)
}

export async function setSpaceVariable(
  transport: HubTransport,
  repoId: string,
  key: string,
  value: string,
  description?: string
): Promise<void> {
  await transport.sendJson('POST', `${transport.endpoint}/api/spaces/${repoId}/variables`, {
    key,
    value,
    description
  })
}

export async function deleteSpaceVariable(
  transport: HubTransport,
  repoId: string,
  key: string
): Promise<void> {
  await transport.sendJson('DELETE', `${transport.endpoint}/api/spaces/${repoId}/variables`, { key })
}

export async function getSpaceLogsSnapshot(
  transport: HubTransport,
  repoId: string,
  logType: 'build' | 'run'
): Promise<{ text: string }> {
  const url = `${transport.endpoint}/api/spaces/${repoId}/logs/${logType}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPACE_LOGS_WINDOW_MS)
  const deadline = new Promise<{ done: true; value: undefined }>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }))
  })
  try {
    const response = await transport.request(url, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    })
    await transport.ensureOk(response, 'GET', url)
    const reader = response.body?.getReader()
    if (!reader) return { text: '' }
    const decoder = new TextDecoder()
    let raw = ''
    let received = 0
    try {
      while (received < SPACE_LOGS_MAX_BYTES) {
        const chunk = await Promise.race([reader.read(), deadline])
        if (chunk.done || !chunk.value) break
        received += chunk.value.byteLength
        raw += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      void reader.cancel().catch(() => undefined)
    }
    raw += decoder.decode()
    return { text: sseDataText(raw) }
  } catch (error) {
    if (controller.signal.aborted) return { text: '' }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function restartSpace(
  transport: HubTransport,
  repoId: string,
  factory = false
): Promise<void> {
  await transport.sendJson(
    'POST',
    `${transport.endpoint}/api/spaces/${repoId}/restart${factory ? '?factory=true' : ''}`
  )
}

/** Owner-scoped live state: stage, hardware, sleep window (token-authenticated). */
export async function getSpaceRuntime(
  transport: HubTransport,
  repoId: string
): Promise<SpaceRuntime> {
  const { body } = await transport.getJson<unknown>(
    `${transport.endpoint}/api/spaces/${repoId}/runtime`
  )
  return mapSpaceRuntime(body)
}

/** Public hardware catalog; per-unit cost fields never leave the mapper. */
export async function listSpaceHardware(
  transport: HubTransport
): Promise<SpaceHardwareCatalogEntry[]> {
  const { body } = await transport.getJson<unknown>(
    `${transport.endpoint}/api/spaces/hardware`
  )
  return mapSpaceHardwareCatalog(body)
}

/** Pauses the Space. Free and reversible through a normal restart (resume). */
export async function pauseSpace(transport: HubTransport, repoId: string): Promise<void> {
  await transport.sendJson('POST', `${transport.endpoint}/api/spaces/${repoId}/pause`)
}

/**
 * Requests a hardware switch. `sleepTimeSeconds` follows the official API:
 * positive seconds, or -1 where "never sleep" is accepted.
 */
export async function requestSpaceHardware(
  transport: HubTransport,
  repoId: string,
  flavor: SpaceHardwareFlavor,
  sleepTimeSeconds?: number
): Promise<void> {
  assertSleepSeconds(sleepTimeSeconds, 'sleepTimeSeconds')
  await transport.sendJson('POST', `${transport.endpoint}/api/spaces/${repoId}/hardware`, {
    flavor,
    ...(sleepTimeSeconds !== undefined ? { sleepTimeSeconds } : {})
  })
}

/** Sets the sleep window: positive seconds, or -1 where the API accepts never. */
export async function setSpaceSleepTime(
  transport: HubTransport,
  repoId: string,
  seconds: number
): Promise<void> {
  assertSleepSeconds(seconds, 'seconds')
  await transport.sendJson('POST', `${transport.endpoint}/api/spaces/${repoId}/sleeptime`, {
    seconds
  })
}

/** Client-side guard mirroring the official payload bounds before any I/O. */
function assertSleepSeconds(value: number | undefined, name: string): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || (value !== -1 && value < 1)) {
    throw new Error(`invalid ${name}: expected a positive integer or -1`)
  }
}
