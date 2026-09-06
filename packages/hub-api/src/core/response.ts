import { HubApiError } from '../errors'

export async function ensureResponseOk(
  response: Response,
  method: string,
  url: string
): Promise<void> {
  if (!response.ok) await throwHttpError(response, method, url)
}

async function throwHttpError(response: Response, method: string, url: string): Promise<never> {
  const rate = response.status === 429 ? ' (rate limited)' : ''
  const headerMsg = (
    response.headers.get('x-error-message') ??
    response.headers.get('X-Error-Message') ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
  const detail = headerMsg ? `: ${headerMsg.slice(0, 240)}` : await hubErrorDetail(response)
  throw new HubApiError(
    `${method} ${url} failed: ${response.status} ${response.statusText}${rate}${detail}`,
    response.status,
    url
  )
}

async function hubErrorDetail(response: Response): Promise<string> {
  let text: string
  try {
    text = (await response.text()).trim()
  } catch {
    return ''
  }
  if (!text) return ''
  if (
    /^<!doctype\b/i.test(text) ||
    /^<html[\s>]/i.test(text) ||
    /<html[\s>]/i.test(text.slice(0, 200))
  ) {
    return ''
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.message === 'string'
          ? parsed.message
          : undefined
    if (message) {
      const oneLine = message.replace(/\s+/g, ' ').trim()
      return oneLine ? `: ${oneLine.slice(0, 240)}` : ''
    }
  } catch {
    // Non-JSON responses use a bounded raw snippet below.
  }
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240)
  return snippet ? `: ${snippet}` : ''
}
