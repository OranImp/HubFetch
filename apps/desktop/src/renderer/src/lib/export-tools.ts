import type { ExportTool } from '@hubfetch/shared'

export const READINESS_FORMATS = ['gguf', 'onnx', 'safetensors', 'workflow'] as const
export type ReadinessFormat = (typeof READINESS_FORMATS)[number]

export const EXPORT_TOOLS = ['ollama', 'lmstudio', 'comfyui'] as const

const TOOL_EXTENSIONS: Record<ExportTool, readonly string[]> = {
  ollama: ['.gguf'],
  lmstudio: ['.gguf'],
  comfyui: ['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf']
}

export function assertNever(value: never): never {
  throw new Error(`unexpected readiness variant: ${String(value)}`)
}

/** Export tools that can ingest the given file, by extension. */
export function exportToolsFor(name: string): ExportTool[] {
  const lower = name.toLowerCase()
  return EXPORT_TOOLS.filter((tool) => TOOL_EXTENSIONS[tool].some((ext) => lower.endsWith(ext)))
}

export function formatOf(path: string): ReadinessFormat | undefined {
  const base = (path.split('/').at(-1) ?? path).toLowerCase()
  const dot = base.lastIndexOf('.')
  const ext = dot === -1 ? '' : base.slice(dot + 1)
  if (ext === 'gguf') return 'gguf'
  if (ext === 'onnx') return 'onnx'
  if (ext === 'safetensors') return 'safetensors'
  if (exportToolsFor(path).length > 0) return 'workflow'
  return undefined
}

export function missingGuidanceKey(tool: ExportTool): string {
  switch (tool) {
    case 'ollama':
      return 'export.ollamaMissing'
    case 'lmstudio':
      return 'export.lmstudioMissing'
    case 'comfyui':
      return 'export.comfyuiMissing'
    default:
      return assertNever(tool)
  }
}
