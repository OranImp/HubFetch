import { useTranslation } from 'react-i18next'
import { ArrowDownToLine, Layers, Share } from 'lucide-react'
import type { ExportTool } from '@hubfetch/shared'
import {
  assertNever,
  EXPORT_TOOLS,
  missingGuidanceKey,
  READINESS_FORMATS,
  type ReadinessFormat
} from '@/lib/export-tools'
import {
  downloadPathsForGroup,
  exportFileForTool,
  type LocalReadiness,
  type ReadinessGroup,
  type ShardState
} from '@/lib/local-readiness'
import { formatBytes } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const TOOL_LABELS: Record<ExportTool, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  comfyui: 'ComfyUI'
}

type LocalReadinessPanelProps = {
  readonly readiness: LocalReadiness
  readonly onDownload: (paths: readonly string[]) => void
  readonly onExport: (tool: ExportTool, filePath: string) => void
  readonly downloadPending: boolean
  readonly exportPending: boolean
}

function shardStateKey(state: ShardState): string {
  switch (state) {
    case 'single':
      return 'readiness.shardSingle'
    case 'complete':
      return 'readiness.shardComplete'
    case 'incomplete':
      return 'readiness.shardIncomplete'
    case 'duplicate':
      return 'readiness.shardDuplicate'
    case 'mixed':
      return 'readiness.shardMixed'
    default:
      return assertNever(state)
  }
}

function formatGroupKey(format: ReadinessFormat): string {
  switch (format) {
    case 'gguf':
      return 'readiness.groupGguf'
    case 'onnx':
      return 'readiness.groupOnnx'
    case 'safetensors':
      return 'readiness.groupSafetensors'
    case 'workflow':
      return 'readiness.groupWorkflow'
    default:
      return assertNever(format)
  }
}

function padIndex(index: number): string {
  return String(index).padStart(5, '0')
}

function GroupCard({
  group,
  onDownload,
  onExport,
  downloadPending,
  exportPending
}: {
  readonly group: ReadinessGroup
  readonly onDownload: (paths: readonly string[]) => void
  readonly onExport: (tool: ExportTool, filePath: string) => void
  readonly downloadPending: boolean
  readonly exportPending: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['detail', 'integrations'])
  const exportable = EXPORT_TOOLS.map((tool) => ({
    tool,
    filePath: exportFileForTool(group, tool)
  })).filter((row): row is { tool: ExportTool; filePath: string } => row.filePath !== undefined)

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border-card bg-card-gradient p-3">
      <header className="flex flex-wrap items-center gap-1.5">
        <h3 className="min-w-0 truncate font-mono text-[13px] font-medium text-ink-strong">
          {group.displayName}
        </h3>
        <Badge variant="outline" data-readiness-label="detected">
          {t('readiness.detected')}
        </Badge>
        <Badge variant="outline">{t(shardStateKey(group.shardState))}</Badge>
        <span className="nums font-mono text-[11.5px] text-ink-faint">
          {t('readiness.totalBytes', { size: formatBytes(group.totalBytes) })}
        </span>
      </header>

      {(group.architecture || group.quantization || group.opset) && (
        <div className="flex flex-wrap gap-1.5">
          {group.architecture && (
            <Badge variant="select">{t('readiness.architecture', { value: group.architecture })}</Badge>
          )}
          {group.quantization && (
            <Badge variant="select">{t('readiness.quantization', { value: group.quantization })}</Badge>
          )}
          {group.opset && <Badge variant="select">{t('readiness.opset', { value: group.opset })}</Badge>}
        </div>
      )}

      <ul className="flex flex-col gap-1">
        {group.files.map((file) => (
          <li key={file.path} className="flex items-center gap-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate font-mono text-ink">{file.path}</span>
            {file.cached ? (
              <Badge variant="success" data-readiness-label="cached">
                {t('readiness.cached')}
              </Badge>
            ) : (
              <Badge variant="outline" data-readiness-label="not-cached">
                {t('readiness.notCached')}
              </Badge>
            )}
          </li>
        ))}
      </ul>

      {group.missingIndices.length > 0 && (
        <p className="text-[12px] text-ink-muted">
          {t('readiness.missingShards', { shards: group.missingIndices.map(padIndex).join(', ') })}
        </p>
      )}
      {group.duplicateIndices.length > 0 && (
        <p className="text-[12px] text-ink-muted">
          {t('readiness.duplicateShards', { shards: group.duplicateIndices.map(padIndex).join(', ') })}
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {group.exportTargets.map((row) => (
          <li key={row.tool} className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="w-24 font-medium text-ink">{TOOL_LABELS[row.tool]}</span>
            {row.installed ? (
              <Badge variant="success" data-readiness-label="target-installed" data-tool={row.tool}>
                {t('readiness.targetInstalled')}
              </Badge>
            ) : (
              <Badge variant="outline" data-readiness-label="target-not-installed" data-tool={row.tool}>
                {t('readiness.targetNotInstalled')}
              </Badge>
            )}
            {row.adapterAvailable ? (
              <Badge variant="select" data-readiness-label="adapter-available" data-tool={row.tool}>
                {t('readiness.adapterAvailable')}
              </Badge>
            ) : (
              <Badge variant="outline" data-readiness-label="adapter-unavailable" data-tool={row.tool}>
                {t('readiness.adapterUnavailable')}
              </Badge>
            )}
            {row.adapterAvailable && !row.installed && (
              <p className="basis-full text-[12px] text-ink-muted">
                {t(`integrations:${missingGuidanceKey(row.tool)}`)}
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          data-readiness-action="download"
          loading={downloadPending}
          onClick={() => onDownload(downloadPathsForGroup(group))}
        >
          <ArrowDownToLine className="size-3.5" aria-hidden />
          {t('readiness.download')}
        </Button>
        {exportable.map((row) => (
          <Button
            key={row.tool}
            variant="secondary"
            size="sm"
            data-readiness-action="export"
            data-tool={row.tool}
            loading={exportPending}
            onClick={() => onExport(row.tool, row.filePath)}
          >
            <Share className="size-3.5" aria-hidden />
            {t('readiness.export', { tool: TOOL_LABELS[row.tool] })}
          </Button>
        ))}
      </div>
    </article>
  )
}

export function LocalReadinessPanel({
  readiness,
  onDownload,
  onExport,
  downloadPending,
  exportPending
}: LocalReadinessPanelProps): React.JSX.Element {
  const { t } = useTranslation(['detail', 'integrations'])
  const sections = READINESS_FORMATS.map((format) => ({
    format,
    groups: readiness.groups.filter((group) => group.format === format)
  })).filter((section) => section.groups.length > 0)

  return (
    <section
      data-testid="local-readiness"
      aria-labelledby="local-readiness-title"
      className="mb-4 flex flex-col gap-3 rounded-lg border border-border-card bg-card-gradient p-4"
    >
      <header className="flex items-start gap-2">
        <Layers className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
        <div className="min-w-0">
          <h2 id="local-readiness-title" className="text-smd font-semibold text-ink-strong">
            {t('readiness.title')}
          </h2>
          <p className="mt-1 text-[12px] text-ink-faint">{t('readiness.evidenceNote')}</p>
        </div>
      </header>
      {sections.map((section) => (
        <div key={section.format} className="flex flex-col gap-2">
          <h3 className="text-[12px] font-medium text-ink-muted">{t(formatGroupKey(section.format))}</h3>
          {section.groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              onDownload={onDownload}
              onExport={onExport}
              downloadPending={downloadPending}
              exportPending={exportPending}
            />
          ))}
        </div>
      ))}
    </section>
  )
}
