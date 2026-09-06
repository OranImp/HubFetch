import type { GatedFormField } from '@hubfetch/shared'

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function parseAskAccessForm(
  html: string
): { csrf: string; fields: GatedFormField[] } | undefined {
  const form = html.split('<form').find((chunk) => chunk.includes('/ask-access'))
  if (form === undefined) return undefined
  const body = form.slice(0, form.indexOf('</form>'))
  let csrf = ''
  const fields: GatedFormField[] = []
  for (const match of body.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = match[2] ?? ''
    const name = decodeHtmlAttribute(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '')
    if (name === '') continue
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? 'text'
    if (name === 'csrf') {
      csrf = decodeHtmlAttribute(/\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? '')
      continue
    }
    if (type === 'hidden') continue
    const required = /\brequired\b/.test(attrs)
    if (match[1] === 'select') {
      const selectHtml =
        new RegExp(
          `<select[^>]*name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</select>`
        ).exec(body)?.[0] ?? ''
      const options = [...selectHtml.matchAll(/<option[^>]*value="([^"]*)"/g)]
        .map((option) => decodeHtmlAttribute(option[1] ?? ''))
        .filter((value) => value !== '')
      fields.push({ name, type: 'select', required, options })
    } else if (match[1] === 'textarea') {
      fields.push({ name, type: 'textarea', required })
    } else if (type === 'checkbox') {
      fields.push({ name, type: 'checkbox', required })
    } else if (type === 'date') {
      fields.push({ name, type: 'date', required })
    } else {
      fields.push({ name, type: 'text', required })
    }
  }
  if (csrf === '') return undefined
  return { csrf, fields }
}
