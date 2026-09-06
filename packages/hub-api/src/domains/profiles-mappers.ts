import type { HubProfileSettings } from '@hubfetch/shared'

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function parseProfileSettingsPage(
  html: string
): { csrf: string; settings: HubProfileSettings } | undefined {
  const form = html.split('<form').find((chunk) => chunk.includes('name="fullname"'))
  if (form === undefined) return undefined
  const input = (name: string): string => {
    const tag = new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`).exec(form)?.[0] ?? ''
    return decodeHtmlAttribute(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '')
  }
  const textarea = (name: string): string => {
    const match = new RegExp(`<textarea[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(
      form
    )
    return decodeHtmlAttribute((match?.[1] ?? '').replace(/^\n/, ''))
  }
  const csrf = input('csrf')
  if (csrf === '') return undefined
  const selectHtml = /<select[^>]*\bname="primaryOrg"[\s\S]*?<\/select>/.exec(form)?.[0] ?? ''
  let primaryOrg = ''
  const primaryOrgOptions: Array<{ value: string; label: string }> = []
  for (const match of selectHtml.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)) {
    const value = decodeHtmlAttribute(/\bvalue="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? '')
    if (/\bselected\b/.test(match[1] ?? '')) primaryOrg = value
    if (value !== '') primaryOrgOptions.push({ value, label: decodeHtmlAttribute((match[2] ?? '').trim()) })
  }
  return {
    csrf,
    settings: {
      fullname: input('fullname'),
      homepage: input('homepage'),
      details: textarea('details'),
      github: input('github'),
      twitter: input('twitter'),
      linkedin: input('linkedin'),
      bluesky: input('bluesky'),
      primaryOrg,
      primaryOrgOptions
    }
  }
}
