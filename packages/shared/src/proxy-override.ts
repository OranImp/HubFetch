/**
 * Closed proxy override schemas shared by the settings/download contracts and
 * the clone contract. Kept in a dependency-free module (no imports of other
 * shared contract files) so both `schemas.ts` and `clone.ts` can import it
 * WITHOUT creating a circular module graph: `clone.ts` needs
 * `downloadProxyOverride`, and `schemas.ts` needs `cloneRequestSchema`, so the
 * override lives here instead of in either of them.
 */
import { z } from 'zod'
import { normalizeManualProxyUrl } from './urls'

/**
 * A manual proxy URL: `http(s)://host:port` with an explicit port and nothing
 * else — no userinfo, path, query, or fragment. Credentials are never accepted.
 */
export const manualProxyUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => normalizeManualProxyUrl(value) !== null, 'invalid proxy url')

/** Per-create proxy override for downloads:start. Closed union, no fallback. */
export const downloadProxyOverride = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('system') }).strict(),
  z.object({ mode: z.literal('direct') }).strict(),
  z.object({ mode: z.literal('manual'), url: manualProxyUrlSchema }).strict()
])
