import { join } from 'node:path'
import { app } from 'electron'

/**
 * One runtime identity for every surface that persists state or talks to the
 * OS: the app name (drives the default userData root), the Windows toast AUMID
 * (must match electron-builder appId), the SQLite database filename, and the
 * credentials file. Everything is HubFetch-scoped; no legacy Oh My HuggingFace
 * path or environment variable is read, written, migrated, or honored.
 */
export const APP_NAME = 'HubFetch'
export const APP_USER_MODEL_ID = 'io.github.oranimp.hubfetch'
export const DB_FILENAME = 'hubfetch.db'
export const CREDENTIALS_FILENAME = 'credentials.json'
export const LLM_CREDENTIALS_FILENAME = 'llm-credentials.json'

/**
 * Test override for the userData root. Must run before any code reads
 * `app.getPath('userData')` so the whole runtime (database, credentials,
 * cache, settings) lands under the override. The legacy `OMH_USER_DATA_DIR`
 * is deliberately NOT honored.
 */
export function applyUserDataOverride(): void {
  const override = process.env.HUBFETCH_USER_DATA_DIR
  if (override) app.setPath('userData', override)
}

/** Resolved userData root for this session (after any override). */
export function userDataDir(): string {
  return app.getPath('userData')
}

export function databaseFile(): string {
  return join(userDataDir(), DB_FILENAME)
}

export function credentialsFile(): string {
  const dir = process.env.HUBFETCH_CREDENTIALS_DIR ?? userDataDir()
  return join(dir, CREDENTIALS_FILENAME)
}

export function llmCredentialsFile(): string {
  const dir = process.env.HUBFETCH_CREDENTIALS_DIR ?? userDataDir()
  return join(dir, LLM_CREDENTIALS_FILENAME)
}
