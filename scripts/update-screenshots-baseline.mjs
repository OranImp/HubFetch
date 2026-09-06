#!/usr/bin/env node
/**
 * Update Playwright visual-regression snapshots, write a pixel-diff report,
 * and refuse to keep the new baselines until visual-qa approval.
 *
 *   node scripts/update-screenshots-baseline.mjs
 *   node scripts/update-screenshots-baseline.mjs --approve
 *
 * `--approve` (or HUBFETCH_VISUAL_QA_APPROVED=1) is the external visual-qa
 * gate: run `/visual-qa` against the report + PNGs, then re-run with
 * `--approve`. Without it this script restores the previous snapshots and
 * exits 1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SNAPSHOT_DIR_REL,
  compareSnapshotDirs,
  copyPngDir,
  isApproved,
  restorePngDir,
  writeReport
} from './visual-baseline-lib.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const snapshotDir = join(root, SNAPSHOT_DIR_REL)
const evidenceDir = join(
  root,
  '.omo',
  'evidence',
  'hubfetch-update-roadmap',
  'task-6-hubfetch-update-roadmap'
)
const reportPath = join(root, 'apps/desktop/test-results/visual-baseline-report.json')

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

function main() {
  const approved = isApproved(process.env, process.argv.slice(2))
  const backupDir = mkdtempSync(join(tmpdir(), 'hubfetch-visual-backup-'))
  copyPngDir(snapshotDir, backupDir)
  mkdirSync(join(root, 'apps/desktop/test-results'), { recursive: true })

  const buildStatus = run('pnpm', ['--filter', 'hubfetch-desktop', 'build'], root)
  if (buildStatus !== 0) {
    restorePngDir(backupDir, snapshotDir)
    rmSync(backupDir, { recursive: true, force: true })
    process.exit(buildStatus)
  }

  const updateStatus = run(
    'pnpm',
    [
      '--filter',
      'hubfetch-desktop',
      'exec',
      'playwright',
      'test',
      '--config=playwright.screenshots.config.ts',
      '--update-snapshots'
    ],
    root
  )
  if (updateStatus !== 0) {
    restorePngDir(backupDir, snapshotDir)
    rmSync(backupDir, { recursive: true, force: true })
    process.exit(updateStatus)
  }

  const comparison = compareSnapshotDirs(backupDir, snapshotDir)
  const report = {
    generatedAt: new Date().toISOString(),
    snapshotDir: SNAPSHOT_DIR_REL,
    approved,
    visualQaRequired: true,
    ...comparison
  }
  writeReport(reportPath, report)
  mkdirSync(evidenceDir, { recursive: true })
  writeReport(join(evidenceDir, 'visual-baseline-report.json'), report)
  writeFileSync(
    join(evidenceDir, 'visual-baseline-report.md'),
    [
      '# Visual baseline update',
      '',
      `- changed: ${comparison.changedCount}`,
      `- totalDiffPixels: ${comparison.totalDiffPixels}`,
      `- approved: ${approved}`,
      '',
      'Run `/visual-qa` on the PNG pair(s), then re-run with `--approve`.',
      ''
    ].join('\n'),
    'utf8'
  )

  if (comparison.changedCount === 0) {
    rmSync(backupDir, { recursive: true, force: true })
    console.log('Visual baselines unchanged.')
    return
  }

  if (!approved) {
    restorePngDir(backupDir, snapshotDir)
    rmSync(backupDir, { recursive: true, force: true })
    console.error(
      `Visual baselines changed (${comparison.changedCount} files, ${comparison.totalDiffPixels} pixels).`
    )
    console.error(`Diff report: ${reportPath}`)
    console.error('Re-run with --approve after /visual-qa sign-off.')
    process.exit(1)
  }

  rmSync(backupDir, { recursive: true, force: true })
  console.log(`Visual baselines accepted (${comparison.changedCount} files).`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
}
