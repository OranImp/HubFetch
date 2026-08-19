import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleAlert, Copy, ExternalLink, RefreshCw, XCircle } from 'lucide-react'
import {
  cloneToolRowActions,
  type CloneToolId,
  type DiagnosticCheck,
  type DiagnosticStatus
} from '@hubfetch/shared'
import { runDiagnostics } from '@/lib/diagnostics'
import { performCloneToolInstall } from '@/lib/clone-tools'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToasts } from '@/components/ui/toaster'

const GIT_CHECK_ID = 'git.version'
const GIT_XET_CHECK_ID = 'git.xet'
const GIT_GCM_CHECK_ID = 'git.gcm'

interface ToolRow {
  id: CloneToolId
  checkId: string
  nameKey: string
  badgeKey: string
}

const TOOL_ROWS: ToolRow[] = [
  {
    id: 'git',
    checkId: GIT_CHECK_ID,
    nameKey: 'settings:cloneTools.git',
    badgeKey: 'settings:cloneTools.required'
  },
  {
    id: 'git-xet',
    checkId: GIT_XET_CHECK_ID,
    nameKey: 'settings:cloneTools.gitXet',
    badgeKey: 'settings:cloneTools.recommended'
  },
  {
    id: 'gcm',
    checkId: GIT_GCM_CHECK_ID,
    nameKey: 'settings:cloneTools.gcm',
    badgeKey: 'settings:cloneTools.recommended'
  }
]

function checkById(
  checks: readonly DiagnosticCheck[] | undefined,
  id: string
): DiagnosticCheck | undefined {
  return checks?.find((check) => check.id === id)
}

function StatusIcon({ status }: { status: DiagnosticStatus | undefined }): React.JSX.Element {
  if (status === 'pass') return <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
  if (status === 'failure') return <XCircle className="size-4 shrink-0 text-error" aria-hidden />
  return <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
}

export function CloneToolsSection(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const [rechecked, setRechecked] = useState(false)

  // Shared with the clone create page and detail drawer via the same key.
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => runDiagnostics(),
    staleTime: 60_000
  })

  const recheck = useMutation({
    mutationFn: () => runDiagnostics(),
    onSuccess: (report) => {
      queryClient.setQueryData(['diagnostics'], report)
      setRechecked(true)
    }
  })

  const checks = diagnostics.data?.checks
  const gitPass = checkById(checks, GIT_CHECK_ID)?.status === 'pass'

  const copyText = (text: string): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => push(t('settings:cloneTools.copied'), 'success'))
      .catch(() => push(t('settings:cloneTools.copyFailed'), 'error'))
  }

  const rows = TOOL_ROWS.map((row) => {
    const check = checkById(checks, row.checkId)
    const actions = cloneToolRowActions({
      tool: row.id,
      status: check?.status ?? 'unknown',
      gitPass
    })
    const wingetCommand = actions.showCopyWinget ? actions.wingetCommand : null
    const configureCommand = actions.showCopyConfigure ? actions.configureCommand : null
    return { ...row, check, actions, wingetCommand, configureCommand }
  })

  const showRestartHint = rechecked && rows.some((row) => row.check?.status !== 'pass')

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-smd font-semibold text-ink-strong">
            {t('settings:cloneTools.title')}
          </h2>
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {t('settings:cloneTools.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          loading={recheck.isPending}
          onClick={() => recheck.mutate()}
        >
          <RefreshCw className="size-3.5" aria-hidden />
          {t('settings:cloneTools.recheck')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const wingetCommand = row.wingetCommand
          const configureCommand = row.configureCommand
          return (
            <div
              key={row.id}
              data-testid={`clone-tool-row-${row.id}`}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <StatusIcon status={row.check?.status} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-ink-strong">
                      {t(row.nameKey)}
                    </span>
                    <Badge variant={row.id === 'git' ? 'warning' : 'neutral'}>
                      {t(row.badgeKey)}
                    </Badge>
                  </div>
                  {row.check?.message ? (
                    <span className="truncate text-[12px] text-ink-muted">
                      {row.check.message}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {row.actions.showInstall ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => performCloneToolInstall(row.id)}
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t('settings:cloneTools.install')}
                  </Button>
                ) : null}
                {wingetCommand ? (
                  <Button variant="ghost" size="sm" onClick={() => copyText(wingetCommand)}>
                    <Copy className="size-3.5" aria-hidden />
                    {t('settings:cloneTools.copyWinget')}
                  </Button>
                ) : null}
                {configureCommand ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyText(configureCommand)}
                  >
                    <Copy className="size-3.5" aria-hidden />
                    {t('settings:cloneTools.copyConfigure')}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {showRestartHint ? (
        <p className="text-[12px] text-ink-faint">{t('settings:cloneTools.restartHint')}</p>
      ) : null}
    </section>
  )
}
