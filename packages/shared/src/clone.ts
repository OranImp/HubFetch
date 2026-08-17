/**
 * Clone contract schemas and URL derivation shared by the worker, persistence,
 * and UI (plan Todo 29). Everything here is Electron-free and pure.
 *
 * URL boundary: a clone URL is ALWAYS derived from a validated repository kind
 * plus a strict `namespace/name` — a raw, arbitrary remote URL is never accepted
 * anywhere on the clone path, and no derived URL can carry userinfo, a token, or
 * a query credential. Revisions are validated to reject option-injection
 * (`-...`), reflog (`@{`), refspec (`:`), traversal (`..`), and whitespace.
 */
import { z } from 'zod'
import { downloadProxyOverride } from './proxy-override'

/** Closed repository kinds accepted by the clone contract. */
export const cloneRepoKindSchema = z.enum(['model', 'dataset', 'space'])
export type CloneRepoKind = z.infer<typeof cloneRepoKindSchema>

/** Transport for the derived clone URL. */
export const cloneTransportSchema = z.enum(['https', 'ssh'])
export type CloneTransport = z.infer<typeof cloneTransportSchema>

/**
 * Closed auth modes for one clone attempt. `none` is an anonymous public clone;
 * `app-token` is the safeStorage AskPass token session (plan Todo 30); `system`
 * leaves the OS credential helpers / SSH agent in charge (no token override).
 */
export const cloneAuthModeSchema = z.enum(['none', 'app-token', 'system'])
export type CloneAuthMode = z.infer<typeof cloneAuthModeSchema>

/** Total length cap for a `namespace/name` id (generous, bounded). */
export const CLONE_ID_TOTAL_MAX = 255

/**
 * One segment of a strict repository id: starts with an alphanumeric and
 * continues with `[A-Za-z0-9._-]`. Rejects leading `-`/`.` (option-like or
 * hidden names), dot-only segments, whitespace, `@`, `:`, `/`, and control
 * characters — nothing that could inject an option, credential, or path.
 */
const CLONE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Exactly two non-empty segments joined by one `/`. */
const CLONE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Strict structural check for a `namespace/name` repository id. */
export function isValidCloneNamespaceName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CLONE_ID_TOTAL_MAX &&
    value.split('/').length === 2 &&
    CLONE_ID_RE.test(value) &&
    value.split('/').every((segment) => CLONE_SEGMENT_RE.test(segment))
  )
}

/** Zod schema for a strict `namespace/name` repository id. */
export const cloneNamespaceNameSchema = z
  .string()
  .max(CLONE_ID_TOTAL_MAX)
  .refine(isValidCloneNamespaceName, 'invalid clone namespace/name')

export interface CloneNamespaceName {
  namespace: string
  name: string
}

/** Split a validated id; returns null for anything that fails the strict shape. */
export function parseCloneNamespaceName(value: string): CloneNamespaceName | null {
  if (!isValidCloneNamespaceName(value)) return null
  const separator = value.indexOf('/')
  return { namespace: value.slice(0, separator), name: value.slice(separator + 1) }
}

/**
 * Shared guard for branch/tag refs. Rejects option injection (leading `-`),
 * hidden refs (leading `.`), traversal (`..`), reflog syntax (`@`), refspec
 * (`:`), whitespace, path separators (`\`), and every control character
 * (checked by code point so the regex stays lint-clean). Nested refs with `/`
 * (e.g. `feature/foo`) are legitimate Git refs and stay allowed.
 */
const REF_FORBIDDEN_RE = /^[-.]|[\\\s@:]|\.\./

/** True when the string contains any control character (<0x20 or DEL). */
function hasControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isValidRefName(value: string): boolean {
  return value.length > 0 && !REF_FORBIDDEN_RE.test(value) && !hasControlChars(value)
}

/** Branch names safe to pass to `git clone --branch`. */
export const cloneBranchSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidRefName, 'invalid branch name')

/** Tag names safe to pass to `git clone --branch`. */
export const cloneTagSchema = z.string().min(1).max(256).refine(isValidRefName, 'invalid tag name')

/** Full 40-hex commit revision (lowercase enforced by Git's object layout). */
export const cloneCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'invalid commit sha')

/** Branch, tag, or full-commit revision — closed, never a free-form string. */
export const cloneRevisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch'), name: cloneBranchSchema }).strict(),
  z.object({ kind: z.literal('tag'), name: cloneTagSchema }).strict(),
  z.object({ kind: z.literal('commit'), sha: cloneCommitShaSchema }).strict()
])
export type CloneRevision = z.infer<typeof cloneRevisionSchema>

/**
 * Destination for one clone: a non-empty absolute/relative local path without
 * NUL or surrounding whitespace. Existence/emptiness is validated at runtime
 * (see the contract's destination reservation); this schema only bounds the
 * string shape.
 */
export const cloneDestinationSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'), 'invalid destination')
export type CloneDestination = z.infer<typeof cloneDestinationSchema>

/**
 * Full clone creation request shared by persistence and IPC. A `proxy`
 * override is the Todo 19 per-create selection; omitted means the settings
 * `ProxyConfig` decides. `.strict()` rejects unknown fields.
 */
export const cloneRequestSchema = z
  .object({
    kind: cloneRepoKindSchema,
    id: cloneNamespaceNameSchema,
    revision: cloneRevisionSchema.optional(),
    transport: cloneTransportSchema,
    destination: cloneDestinationSchema,
    auth: cloneAuthModeSchema,
    proxy: downloadProxyOverride.optional()
  })
  .strict()
export type CloneRequest = z.infer<typeof cloneRequestSchema>

/** Hub host used in derived HTTPS clone URLs. */
export const HF_CLONE_HOST = 'huggingface.co'
/** SSH host for derived SSH clone URLs. */
export const HF_CLONE_SSH_HOST = 'git@hf.co'

/** The kind-specific path segment inserted between the host and the id. */
export function cloneKindPathSegment(kind: CloneRepoKind): string {
  switch (kind) {
    case 'model':
      return ''
    case 'dataset':
      return 'datasets'
    case 'space':
      return 'spaces'
  }
}

/** Derived HTTPS clone URL; can never carry userinfo, token, or query. */
export function deriveHttpsCloneUrl(kind: CloneRepoKind, id: string): string {
  const parsed = parseCloneNamespaceName(id)
  if (parsed === null) throw new Error(`invalid clone namespace/name: ${JSON.stringify(id)}`)
  const segment = cloneKindPathSegment(kind)
  return `https://${HF_CLONE_HOST}${segment === '' ? '' : `/${segment}`}/${parsed.namespace}/${parsed.name}`
}

/** Derived SSH clone URL (`git@hf.co:datasets/ns/name`); never credentialed. */
export function deriveSshCloneUrl(kind: CloneRepoKind, id: string): string {
  const parsed = parseCloneNamespaceName(id)
  if (parsed === null) throw new Error(`invalid clone namespace/name: ${JSON.stringify(id)}`)
  const segment = cloneKindPathSegment(kind)
  return `${HF_CLONE_SSH_HOST}:${segment === '' ? '' : `${segment}/`}${parsed.namespace}/${parsed.name}`
}

/** Derive the credential-free clone URL for a kind + transport. */
export function deriveCloneUrl(kind: CloneRepoKind, id: string, transport: CloneTransport): string {
  return transport === 'https' ? deriveHttpsCloneUrl(kind, id) : deriveSshCloneUrl(kind, id)
}

/** HTTPS derived-clone URL shape: `https://huggingface.co[/datasets|/spaces]/ns/name`. */
const DERIVED_HTTPS_URL_RE =
  /^https:\/\/huggingface\.co\/(?:datasets\/|spaces\/)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
/** SSH derived-clone URL shape: `git@hf.co:[datasets/|spaces/]ns/name`. */
const DERIVED_SSH_URL_RE =
  /^git@hf\.co:(?:datasets\/|spaces\/)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * True exactly when a URL matches one of the two derived clone URL shapes —
 * the URL boundary for the executor: a raw arbitrary remote is never accepted.
 */
export function isDerivedCloneUrl(url: string): boolean {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    (DERIVED_HTTPS_URL_RE.test(url) || DERIVED_SSH_URL_RE.test(url))
  )
}
