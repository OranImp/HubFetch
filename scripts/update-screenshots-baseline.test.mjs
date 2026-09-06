import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { compareSnapshotDirs, diffPng, encodePngRgba, isApproved } from './visual-baseline-lib.mjs'

const RED = encodePngRgba(1, 1, Buffer.from([255, 0, 0, 255]))
const BLACK = encodePngRgba(1, 1, Buffer.from([0, 0, 0, 255]))

test('isApproved is false until the visual-qa flag or argv is set', () => {
  assert.equal(isApproved({}, []), false)
  assert.equal(isApproved({ HUBFETCH_VISUAL_QA_APPROVED: '1' }, []), true)
  assert.equal(isApproved({}, ['--approve']), true)
})

test('diffPng reports zero pixels for identical fixtures', () => {
  const diff = diffPng(RED, RED)
  assert.equal(diff.dimensionsMatch, true)
  assert.equal(diff.diffPixels, 0)
  assert.equal(diff.diffRatio, 0)
})

test('diffPng reports a failing pixel when one CSS-token-sized fixture changes', () => {
  const diff = diffPng(RED, BLACK)
  assert.equal(diff.dimensionsMatch, true)
  assert.equal(diff.diffPixels, 1)
  assert.ok(diff.diffRatio > 0)
})

test('compareSnapshotDirs flags a changed baseline file', () => {
  const before = mkdtempSync(join(tmpdir(), 'hubfetch-visual-before-'))
  const after = mkdtempSync(join(tmpdir(), 'hubfetch-visual-after-'))
  writeFileSync(join(before, 'browse-light-1280x860.png'), RED)
  writeFileSync(join(after, 'browse-light-1280x860.png'), BLACK)
  const report = compareSnapshotDirs(before, after)
  assert.equal(report.changedCount, 1)
  assert.equal(report.totalDiffPixels, 1)
  assert.equal(report.snapshots[0]?.kind, 'changed')
})
