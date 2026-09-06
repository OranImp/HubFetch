import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

export const SNAPSHOT_DIR_REL = 'apps/desktop/e2e/visual-regression.snapshots'

/** @typedef {{ readonly path: string, readonly width: number, readonly height: number, readonly pixels: Buffer }} DecodedPng */

export function isApproved(env = process.env, argv = process.argv.slice(2)) {
  return env.HUBFETCH_VISUAL_QA_APPROVED === '1' || argv.includes('--approve')
}

export function listPngFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .map((name) => join(dir, name))
    .sort()
}

export function copyPngDir(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true })
  for (const file of listPngFiles(fromDir)) {
    writeFileSync(join(toDir, basename(file)), readFileSync(file))
  }
}

export function restorePngDir(backupDir, targetDir) {
  if (existsSync(targetDir)) {
    for (const file of listPngFiles(targetDir)) rmSync(file)
  }
  if (!existsSync(backupDir)) return
  copyPngDir(backupDir, targetDir)
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

export function encodePngRgba(width, height, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0
    pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride)
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function recon(filter, curr, prev, bpp) {
  const out = Buffer.alloc(curr.length)
  for (let i = 0; i < curr.length; i++) {
    const left = i >= bpp ? out[i - bpp] : 0
    const up = prev ? prev[i] : 0
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0
    if (filter === 0) out[i] = curr[i]
    else if (filter === 1) out[i] = (curr[i] + left) & 255
    else if (filter === 2) out[i] = (curr[i] + up) & 255
    else if (filter === 3) out[i] = (curr[i] + ((left + up) >> 1)) & 255
    else if (filter === 4) out[i] = (curr[i] + paeth(left, up, upLeft)) & 255
    else throw new Error(`unsupported PNG filter ${filter}`)
  }
  return out
}

export function decodePng(buffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.subarray(0, 8).compare(sig) !== 0) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG colorType=${colorType} bitDepth=${bitDepth}`)
  }
  const bpp = colorType === 6 ? 4 : 3
  const inflated = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const pixels = Buffer.alloc(width * height * 4)
  let src = 0
  let prev = null
  for (let y = 0; y < height; y++) {
    const filter = inflated[src]
    const row = inflated.subarray(src + 1, src + 1 + stride)
    const decoded = recon(filter, row, prev, bpp)
    prev = decoded
    src += 1 + stride
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4
      const si = x * bpp
      pixels[di] = decoded[si]
      pixels[di + 1] = decoded[si + 1]
      pixels[di + 2] = decoded[si + 2]
      pixels[di + 3] = bpp === 4 ? decoded[si + 3] : 255
    }
  }
  return { path: '', width, height, pixels }
}

export function diffPng(referenceBuf, actualBuf) {
  const reference = decodePng(referenceBuf)
  const actual = decodePng(actualBuf)
  if (reference.width !== actual.width || reference.height !== actual.height) {
    return {
      dimensionsMatch: false,
      width: actual.width,
      height: actual.height,
      diffPixels: reference.width * reference.height,
      diffRatio: 1,
      hashChanged: true
    }
  }
  let diffPixels = 0
  const total = reference.width * reference.height
  for (let i = 0; i < reference.pixels.length; i += 4) {
    if (
      reference.pixels[i] !== actual.pixels[i] ||
      reference.pixels[i + 1] !== actual.pixels[i + 1] ||
      reference.pixels[i + 2] !== actual.pixels[i + 2] ||
      reference.pixels[i + 3] !== actual.pixels[i + 3]
    ) {
      diffPixels += 1
    }
  }
  return {
    dimensionsMatch: true,
    width: actual.width,
    height: actual.height,
    diffPixels,
    diffRatio: total === 0 ? 0 : diffPixels / total,
    hashChanged:
      createHash('sha256').update(referenceBuf).digest('hex') !==
      createHash('sha256').update(actualBuf).digest('hex')
  }
}

export function compareSnapshotDirs(beforeDir, afterDir) {
  const before = new Map(listPngFiles(beforeDir).map((file) => [basename(file), file]))
  const after = new Map(listPngFiles(afterDir).map((file) => [basename(file), file]))
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  const snapshots = names.map((name) => {
    const previous = before.get(name)
    const next = after.get(name)
    if (!previous) {
      return { name, kind: 'added', diffPixels: 0, diffRatio: 1, dimensionsMatch: true }
    }
    if (!next) {
      return { name, kind: 'removed', diffPixels: 0, diffRatio: 1, dimensionsMatch: true }
    }
    const diff = diffPng(readFileSync(previous), readFileSync(next))
    return { name, kind: diff.diffPixels === 0 ? 'unchanged' : 'changed', ...diff }
  })
  const changed = snapshots.filter((entry) => entry.kind !== 'unchanged')
  return {
    snapshots,
    changedCount: changed.length,
    totalDiffPixels: snapshots.reduce((sum, entry) => sum + (entry.diffPixels ?? 0), 0)
  }
}

export function writeReport(filePath, report) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8')
}
