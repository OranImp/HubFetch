import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const rendererRoot = resolve('apps/desktop/out/renderer')
const sourceHtml = readFileSync(resolve('apps/desktop/src/renderer/index.html'), 'utf8')

if (!sourceHtml.includes("script-src 'self'")) {
  throw new Error('Production CSP no longer restricts scripts to self')
}
if (sourceHtml.includes('unsafe-eval') || sourceHtml.includes('wasm-unsafe-eval')) {
  throw new Error('Production CSP enables eval or WebAssembly eval')
}

// No scheme-source wildcards (`https:`, `http:`, bare `*`) anywhere in the
// production CSP. Scoped host wildcards (`https://*.hf.space`) are allowed —
// they are pinned to a registrable domain the app actually embeds.
const cspMatch = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i.exec(
  sourceHtml
)
if (!cspMatch) {
  throw new Error('Production CSP meta tag is missing from index.html')
}
const unsafeCspTokens = cspMatch[1].split(';').flatMap((directive) => {
  const [name, ...tokens] = directive.trim().split(/\s+/)
  return name
    ? tokens
        .filter((token) => token === '*' || /^(?:https?|wss?|ftp):$/.test(token))
        .map((token) => `${name}:${token}`)
    : []
})
if (unsafeCspTokens.length > 0) {
  throw new Error(`Production CSP contains unsafe wildcard tokens: ${unsafeCspTokens.join(', ')}`)
}
if (!cspMatch[1].includes("object-src 'none'") || !cspMatch[1].includes("base-uri 'none'")) {
  throw new Error('Production CSP must keep object-src and base-uri locked to none')
}

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const files = filesUnder(rendererRoot)
const wasm = files.filter((path) => extname(path) === '.wasm')
if (wasm.length > 0) {
  throw new Error(`Renderer build unexpectedly contains WebAssembly: ${wasm.join(', ')}`)
}

const javascript = files
  .filter((path) => extname(path) === '.js')
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
if (!javascript.includes('github-light') || !javascript.includes('github-dark-dimmed')) {
  throw new Error('Renderer build is missing the bundled dual Shiki themes')
}
if (/onig(?:uruma)?\.wasm|loadWasm/i.test(javascript)) {
  throw new Error('Renderer build still contains a Shiki Oniguruma WASM loader')
}

console.log('Syntax build verified: strict CSP, dual themes, and no renderer WASM.')
