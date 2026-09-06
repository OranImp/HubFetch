import { describe, expect, it } from 'vitest'
import type { ExportTarget } from '@hubfetch/shared'
import {
  buildLocalReadiness,
  exportFileForTool,
  exportToolsFor,
  parseShardName
} from './local-readiness'

const NONE_CACHED = new Set<string>()

function targets(installed: readonly ExportTarget['tool'][]): readonly ExportTarget[] {
  return (['ollama', 'lmstudio', 'comfyui'] as const).map((tool) => ({
    tool,
    detected: installed.includes(tool)
  }))
}

describe('parseShardName', () => {
  it('parses a numbered GGUF shard', () => {
    expect(parseShardName('model-00001-of-00004.gguf')).toEqual({
      prefix: 'model',
      index: 1,
      total: 4,
      extension: 'gguf',
      directory: ''
    })
  })

  it('keeps directory and unpadded indices', () => {
    expect(parseShardName('gguf/tiny-1-of-2.gguf')).toEqual({
      prefix: 'tiny',
      index: 1,
      total: 2,
      extension: 'gguf',
      directory: 'gguf'
    })
  })

  it('returns undefined for a single unsharded file', () => {
    expect(parseShardName('model-Q4_K_M.gguf')).toBeUndefined()
    expect(parseShardName('model.safetensors')).toBeUndefined()
  })

  it('returns undefined when total is zero', () => {
    expect(parseShardName('model-00001-of-00000.gguf')).toBeUndefined()
  })
})

describe('exportToolsFor', () => {
  it('offers all targets for GGUF files', () => {
    expect(exportToolsFor('model-Q4_K_M.gguf')).toEqual(['ollama', 'lmstudio', 'comfyui'])
    expect(exportToolsFor('MODEL.GGUF')).toEqual(['ollama', 'lmstudio', 'comfyui'])
  })

  it('offers only ComfyUI for diffusion weight formats', () => {
    expect(exportToolsFor('sd_xl_base_1.0.safetensors')).toEqual(['comfyui'])
    expect(exportToolsFor('v1-5-pruned.ckpt')).toEqual(['comfyui'])
    expect(exportToolsFor('control_lora.pt')).toEqual(['comfyui'])
    expect(exportToolsFor('vae.pth')).toEqual(['comfyui'])
    expect(exportToolsFor('pytorch_model.bin')).toEqual(['comfyui'])
  })

  it('offers nothing for ONNX or non-exportable files', () => {
    expect(exportToolsFor('graph.onnx')).toEqual([])
    expect(exportToolsFor('README.md')).toEqual([])
    expect(exportToolsFor('config.json')).toEqual([])
  })
})

describe('buildLocalReadiness', () => {
  it('groups a single GGUF as detected and not cached', () => {
    const report = buildLocalReadiness({
      files: [{ path: 'model-Q4_K_M.gguf', size: 1024 }],
      cachedPaths: NONE_CACHED,
      exportTargets: targets(['ollama'])
    })
    expect(report.groups).toHaveLength(1)
    const group = report.groups[0]
    expect(group?.format).toBe('gguf')
    expect(group?.shardState).toBe('single')
    expect(group?.totalBytes).toBe(1024)
    expect(group?.files[0]?.cached).toBe(false)
    expect(group?.architecture).toBeUndefined()
    expect(group?.quantization).toBeUndefined()
    expect(group?.opset).toBeUndefined()
    expect(group?.exportTargets.find((row) => row.tool === 'ollama')).toEqual({
      tool: 'ollama',
      installed: true,
      adapterAvailable: true
    })
  })

  it('marks a complete four-shard GGUF set cached when every shard is present', () => {
    const files = [1, 2, 3, 4].map((index) => ({
      path: `model-${String(index).padStart(5, '0')}-of-00004.gguf`,
      size: 100
    }))
    const report = buildLocalReadiness({
      files,
      cachedPaths: new Set(files.map((file) => file.path)),
      exportTargets: targets(['ollama', 'lmstudio'])
    })
    expect(report.groups).toHaveLength(1)
    const group = report.groups[0]
    expect(group?.shardState).toBe('complete')
    expect(group?.missingIndices).toEqual([])
    expect(group?.duplicateIndices).toEqual([])
    expect(group?.totalBytes).toBe(400)
    expect(group?.files.every((file) => file.cached)).toBe(true)
  })

  it('reports missing shards without claiming the set cannot run', () => {
    const report = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00004.gguf', size: 10 },
        { path: 'model-00002-of-00004.gguf', size: 10 },
        { path: 'model-00004-of-00004.gguf', size: 10 }
      ],
      cachedPaths: NONE_CACHED,
      exportTargets: targets([])
    })
    const group = report.groups[0]
    expect(group?.shardState).toBe('incomplete')
    expect(group?.missingIndices).toEqual([3])
    expect(group?.totalBytes).toBe(30)
  })

  it('reports duplicate shard indices from conflicting padding', () => {
    const report = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00004.gguf', size: 10 },
        { path: 'model-0001-of-00004.gguf', size: 11 },
        { path: 'model-00002-of-00004.gguf', size: 10 },
        { path: 'model-00003-of-00004.gguf', size: 10 },
        { path: 'model-00004-of-00004.gguf', size: 10 }
      ],
      cachedPaths: NONE_CACHED,
      exportTargets: targets([])
    })
    const group = report.groups[0]
    expect(group?.shardState).toBe('duplicate')
    expect(group?.duplicateIndices).toEqual([1])
  })

  it('flags mixed-format shard sets', () => {
    const report = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00002.gguf', size: 10 },
        { path: 'model-00002-of-00002.safetensors', size: 20 }
      ],
      cachedPaths: NONE_CACHED,
      exportTargets: targets([])
    })
    const group = report.groups[0]
    expect(group?.shardState).toBe('mixed')
    expect(group?.formats).toEqual(['gguf', 'safetensors'])
  })

  it('keeps ONNX, safetensors, and workflow files in separate format groups', () => {
    const report = buildLocalReadiness({
      files: [
        { path: 'graph.onnx', size: 5 },
        { path: 'weights.safetensors', size: 6 },
        { path: 'v1-5-pruned.ckpt', size: 7 },
        { path: 'README.md', size: 1 }
      ],
      cachedPaths: NONE_CACHED,
      exportTargets: targets(['comfyui'])
    })
    expect(report.groups.map((group) => group.format)).toEqual(['onnx', 'safetensors', 'workflow'])
    expect(report.groups.find((group) => group.format === 'onnx')?.exportTargets).toEqual([
      { tool: 'ollama', installed: false, adapterAvailable: false },
      { tool: 'lmstudio', installed: false, adapterAvailable: false },
      { tool: 'comfyui', installed: true, adapterAvailable: false }
    ])
    expect(
      report.groups.find((group) => group.format === 'safetensors')?.exportTargets.find(
        (row) => row.tool === 'comfyui'
      )
    ).toEqual({ tool: 'comfyui', installed: true, adapterAvailable: true })
  })

  it('attaches architecture, quantization, and opset only when metadata is present', () => {
    const withMeta = buildLocalReadiness({
      files: [
        { path: 'model.gguf', size: 1 },
        { path: 'graph.onnx', size: 2 }
      ],
      cachedPaths: NONE_CACHED,
      exportTargets: targets([]),
      metadata: [
        { path: 'model.gguf', architecture: 'llama', quantization: 'Q4_K' },
        { path: 'graph.onnx', opset: 'ai.onnx @ 17' }
      ]
    })
    expect(withMeta.groups.find((group) => group.format === 'gguf')).toMatchObject({
      architecture: 'llama',
      quantization: 'Q4_K'
    })
    expect(withMeta.groups.find((group) => group.format === 'onnx')?.opset).toBe('ai.onnx @ 17')

    const absent = buildLocalReadiness({
      files: [{ path: 'model.gguf', size: 1 }],
      cachedPaths: NONE_CACHED,
      exportTargets: targets([])
    })
    expect(absent.groups[0]?.architecture).toBeUndefined()
    expect(absent.groups[0]?.quantization).toBeUndefined()
  })

  it('reports cached vs not-cached per file and per export target', () => {
    const report = buildLocalReadiness({
      files: [
        { path: 'cached.gguf', size: 10 },
        { path: 'missing.gguf', size: 20 }
      ],
      cachedPaths: new Set(['cached.gguf']),
      exportTargets: targets(['lmstudio'])
    })
    expect(report.groups.find((group) => group.files[0]?.path === 'cached.gguf')?.files[0]?.cached).toBe(
      true
    )
    expect(report.groups.find((group) => group.files[0]?.path === 'missing.gguf')?.files[0]?.cached).toBe(
      false
    )
    expect(
      report.groups[0]?.exportTargets.find((row) => row.tool === 'lmstudio')?.installed
    ).toBe(true)
    expect(report.groups[0]?.exportTargets.find((row) => row.tool === 'ollama')?.installed).toBe(
      false
    )
  })

  it('picks a cached supported file for export and skips incomplete shard sets', () => {
    const incomplete = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00002.gguf', size: 10 },
        { path: 'model-00002-of-00002.gguf', size: 10 }
      ],
      cachedPaths: new Set(['model-00001-of-00002.gguf']),
      exportTargets: targets(['ollama'])
    })
    // After dropping shard 2 from the input, the remaining file is incomplete.
    const missing = buildLocalReadiness({
      files: [{ path: 'model-00001-of-00002.gguf', size: 10 }],
      cachedPaths: new Set(['model-00001-of-00002.gguf']),
      exportTargets: targets(['ollama'])
    })
    expect(missing.groups[0]?.shardState).toBe('incomplete')
    expect(exportFileForTool(missing.groups[0]!, 'ollama')).toBeUndefined()

    const complete = buildLocalReadiness({
      files: [
        { path: 'model-00001-of-00002.gguf', size: 10 },
        { path: 'model-00002-of-00002.gguf', size: 10 }
      ],
      cachedPaths: new Set(['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf']),
      exportTargets: targets(['ollama'])
    })
    expect(exportFileForTool(complete.groups[0]!, 'ollama')).toBe('model-00001-of-00002.gguf')
    expect(exportFileForTool(incomplete.groups[0]!, 'ollama')).toBeUndefined()

    const single = buildLocalReadiness({
      files: [{ path: 'ready.gguf', size: 8 }],
      cachedPaths: new Set(['ready.gguf']),
      exportTargets: targets(['ollama'])
    })
    expect(exportFileForTool(single.groups[0]!, 'ollama')).toBe('ready.gguf')
  })

  it('does not expose export when the target is missing even if the adapter exists', () => {
    const report = buildLocalReadiness({
      files: [{ path: 'ready.gguf', size: 8 }],
      cachedPaths: new Set(['ready.gguf']),
      exportTargets: targets([])
    })
    expect(exportFileForTool(report.groups[0]!, 'ollama')).toBeUndefined()
    expect(report.groups[0]?.exportTargets.find((row) => row.tool === 'ollama')).toEqual({
      tool: 'ollama',
      installed: false,
      adapterAvailable: true
    })
  })
})
