import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { _electron as electron, expect, test } from '@playwright/test'
import { diagnosticReportSchema } from '@hubfetch/shared'

/**
 * Diagnostics E2E (plan Todo 24): boots the BUILT app via the offscreen
 * bootstrap (repo headless policy — windows are never visible), opens the
 * Diagnostics page through the real UI, runs the readiness checks through real
 * IPC, and exports a support bundle to a Unicode + spaced path via the native
 * save dialog (stubbed in main). The ZIP is then inspected on disk: exact
 * allowlist membership/order and schema-parseable JSON.
 */
const BOOTSTRAP = join(
  __dirname,
  '..',
  '..',
  '..',
  '.omo',
  'scratch',
  'task-24',
  'bootstrap-offscreen.cjs'
)
const ELECTRON_EXE = join(
  __dirname,
  '..',
  '..',
  '..',
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
)

// Accessible-name matcher covering every locale the app ships.
const EXPORT_BUTTON = new RegExp(
  'Export support bundle|导出支持包|匯出支援套件|サポートバンドル|지원 번들|Support-Paket|' +
    'paquete de soporte|bundle de support|pacote de suporte'
)

function readZipEntries(
  buffer: Buffer
): { name: string; usize: number; csize: number; localOffset: number }[] {
  const eocd = buffer.length - 22
  const count = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  const entries: { name: string; usize: number; csize: number; localOffset: number }[] = []
  let cursor = cdOffset
  while (cursor < cdOffset + cdSize) {
    const nameLen = buffer.readUInt16LE(cursor + 28)
    entries.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'),
      usize: buffer.readUInt32LE(cursor + 24),
      csize: buffer.readUInt32LE(cursor + 20),
      localOffset: buffer.readUInt32LE(cursor + 42)
    })
    cursor += 46 + nameLen
  }
  expect(entries).toHaveLength(count)
  return entries
}

test('diagnostics page runs checks and exports an allowlisted bundle through real IPC/UI', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'hubfetch-diag-e2e-'))
  const exportDir = mkdtempSync(join('E:\\Programs\\Temp', 'hubfetch-e2e-export-'))
  const exportPath = join(exportDir, '支持包 测试 bundle.zip')

  const app = await electron.launch({
    executablePath: ELECTRON_EXE,
    args: [BOOTSTRAP],
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      HUBFETCH_USER_DATA_DIR: userDataDir,
      HUBFETCH_CREDENTIALS_DIR: userDataDir,
      TMP: 'E:\\Programs\\Temp',
      TEMP: 'E:\\Programs\\Temp',
      PLAYWRIGHT_BROWSERS_PATH: 'E:\\Programs\\ms-playwright'
    }
  })
  try {
    // Stub the native save dialog from the MAIN process so the export targets
    // the Unicode/spaced path; the dialog is never shown on screen.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, exportPath)

    const window = await app.firstWindow()
    await window.evaluate(() => {
      window.location.hash = '#/diagnostics'
    })

    // The page auto-runs the readiness probes; category sections render on the
    // bounded report (worst case: network probe times out at its 5s deadline).
    await window.waitForSelector('main section', { timeout: 60_000 })
    await expect(window.getByRole('button', { name: EXPORT_BUTTON }).first()).toBeVisible({
      timeout: 10_000
    })

    // Export through the real UI button -> real IPC -> main builder.
    await window.getByRole('button', { name: EXPORT_BUTTON }).click()

    // The finalized archive appears only after successful sentinel scan + rename.
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true)
    expect(readdirSync(exportDir).filter((f) => f.includes('tmp'))).toEqual([])

    // Inspect the ZIP: exact allowlist membership and order, parseable JSON.
    const buffer = readFileSync(exportPath)
    const entries = readZipEntries(buffer)
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'app.json',
      'system.json',
      'diagnostics.json',
      'settings.json',
      'tasks-summary.json',
      'logs/main.log',
      'logs/renderer.log',
      'README.txt'
    ])

    const readMember = (name: string): Buffer => {
      const entry = entries.find((e) => e.name === name)
      if (!entry) throw new Error(`missing member ${name}`)
      const header = entry.localOffset
      const nameLen = buffer.readUInt16LE(header + 26)
      const extraLen = buffer.readUInt16LE(header + 28)
      return inflateRawSync(
        buffer.subarray(
          header + 30 + nameLen + extraLen,
          header + 30 + nameLen + extraLen + entry.csize
        )
      )
    }
    const diagnostics = JSON.parse(readMember('diagnostics.json').toString('utf8'))
    expect(diagnosticReportSchema.safeParse(diagnostics).success).toBe(true)
    const manifest = JSON.parse(readMember('manifest.json').toString('utf8'))
    expect(manifest.members).toEqual(entries.map((e) => e.name))
    const settings = readMember('settings.json').toString('utf8')
    expect(settings).not.toContain('C:\\Users')
  } finally {
    await app.close()
  }
})
