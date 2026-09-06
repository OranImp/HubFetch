import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Download, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type {
  DiagnosticCategory,
  DiagnosticStatus,
  DiagnosticsProgress,
  HubCapabilityStatus
} from '@hubfetch/shared'
import {
  cancelBundleExport,
  cancelDiagnostics,
  exportSupportBundle,
  runDiagnostics
} from '@/lib/diagnostics'
import { probeHubCapability, readHubCapabilities } from '@/lib/compatibility'
import { useIpcEvent } from '@/hooks/use-ipc-event'
import { describeError } from '@/lib/errors'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { useAppStore } from '@/stores/app'
import { openExternal } from '@/lib/ipc'
import { hubRelativeUrl } from '@hubfetch/shared'

const CATEGORY_ORDER: DiagnosticCategory[] = [
  'app',
  'system',
  'disk',
  'cache',
  'destination',
  'symlink',
  'notifications',
  'network',
  'git',
  'credentials',
  'database'
]

const STATUS_VARIANT: Record<DiagnosticStatus, 'success' | 'warning' | 'error' | 'neutral'> = {
  pass: 'success',
  warning: 'warning',
  failure: 'error',
  unknown: 'neutral'
}

const CAPABILITY_VARIANT: Record<
  HubCapabilityStatus['status'],
  'success' | 'warning' | 'error'
> = {
  available: 'success',
  'session-required': 'warning',
  unauthorized: 'warning',
  forbidden: 'error',
  'rate-limited': 'warning',
  'upstream-changed': 'error',
  network: 'error'
}

export function DiagnosticsPage(): React.JSX.Element {
  const { t } = useTranslation(['diagnostics', 'common', 'errors'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const openSettings = useAppStore((state) => state.openSettings)
  const hubEndpoint = useAppStore((state) => state.settings.hubEndpoint)
  const [runProgress, setRunProgress] = useState<DiagnosticsProgress | null>(null)
  const [exportProgress, setExportProgress] = useState<DiagnosticsProgress | null>(null)

  const report = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => runDiagnostics(),
    staleTime: 0,
    placeholderData: keepPreviousData,
    retry: false
  })

  const capabilities = useQuery({
    queryKey: ['hub-capabilities'],
    queryFn: () => readHubCapabilities(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })

  const probe = useMutation({
    mutationFn: (key: HubCapabilityStatus['key']) => probeHubCapability(key),
    onSuccess: (next) => {
      queryClient.setQueryData<HubCapabilityStatus[]>(['hub-capabilities'], (current) =>
        current?.map((entry) => (entry.key === next.key ? next : entry))
      )
    },
    onError: (err) => push(describeError(t, err), 'error')
  })

  useIpcEvent(
    'evt:diagnosticsProgress',
    useCallback((progress: DiagnosticsProgress) => {
      if (progress.phase === 'run') setRunProgress(progress)
      else setExportProgress(progress)
    }, [])
  )

  const rerun = useMutation({
    mutationFn: () => runDiagnostics(),
    onSuccess: (next) => queryClient.setQueryData(['diagnostics'], next),
    onError: (err) => push(describeError(t, err), 'error')
  })

  const cancel = useMutation({
    mutationFn: () => cancelDiagnostics()
  })

  const exportBundle = useMutation({
    mutationFn: () => exportSupportBundle(),
    onSuccess: (result) => {
      setExportProgress(null)
      if (result.canceled) {
        push(t('diagnostics:exportCanceled'), 'info')
        return
      }
      push(t('diagnostics:exported', { path: result.path }), 'success')
    },
    onError: (err) => {
      setExportProgress(null)
      push(t('diagnostics:exportFailed'), 'error')
      push(err instanceof Error ? err.message : String(err), 'error')
    }
  })

  const cancelExportNow = useMutation({
    mutationFn: () => cancelBundleExport()
  })

  const checks = useMemo(() => report.data?.checks ?? [], [report.data])
  const grouped = useMemo(() => {
    const map = new Map<DiagnosticCategory, (typeof checks)[number][]>()
    for (const category of CATEGORY_ORDER) {
      const inCategory = checks.filter((check) => check.category === category)
      if (inCategory.length > 0) map.set(category, inCategory)
    }
    return map
  }, [checks])

  const running = report.isFetching || rerun.isPending
  const exporting = exportBundle.isPending

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-smd nums font-semibold text-ink-strong">
              {t('diagnostics:title')}
            </h1>
            <p className="text-[12.5px] text-ink-muted">{t('diagnostics:subtitle')}</p>
            {report.data && (
              <p className="nums text-[12.5px] text-ink-muted">
                {t('diagnostics:checksCount', { count: checks.length })}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={running}
              disabled={running}
              onClick={() => {
                if (running) void cancel.mutate()
                else void rerun.mutate()
              }}
            >
              {running ? (
                <>
                  <X className="size-3.5" aria-hidden />
                  {t('diagnostics:cancel')}
                </>
              ) : (
                <>
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t('diagnostics:rerun')}
                </>
              )}
            </Button>
            <Button
              variant="cta"
              size="sm"
              loading={exporting}
              disabled={exporting}
              onClick={() => {
                if (exporting) void cancelExportNow.mutate()
                else void exportBundle.mutate()
              }}
            >
              {exporting ? (
                <>
                  <X className="size-3.5" aria-hidden />
                  {t('diagnostics:cancel')}
                </>
              ) : (
                <>
                  <Download className="size-3.5" aria-hidden />
                  {t('diagnostics:exportBundle')}
                </>
              )}
            </Button>
          </div>
        </header>

        {runProgress && running && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(runProgress.percent * 100)}
            aria-label={t('diagnostics:running')}
            className="flex items-center gap-2 text-[12px] text-ink-muted"
          >
            <span className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-panel">
              <span
                className="block h-full bg-select transition-all duration-200"
                style={{ width: `${Math.round(runProgress.percent * 100)}%` }}
              />
            </span>
            <span className="truncate">
              {runProgress.status} ({runProgress.completedChecks}/{runProgress.totalChecks})
            </span>
          </div>
        )}

        {exportProgress && exporting && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(exportProgress.percent * 100)}
            aria-label={t('diagnostics:exporting')}
            className="flex items-center gap-2 text-[12px] text-ink-muted"
          >
            <span className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-panel">
              <span
                className="block h-full bg-brand transition-all duration-200"
                style={{ width: `${Math.round(exportProgress.percent * 100)}%` }}
              />
            </span>
            <span className="truncate">{exportProgress.status}</span>
          </div>
        )}

        {capabilities.data && (
          <section className="rounded-lg border">
            <header className="flex items-center justify-between rounded-t-lg border-b px-3 py-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-3.5 text-ink-muted" aria-hidden />
                <h2 className="text-[13px] font-semibold text-ink-strong">
                  {t('diagnostics:hubCapabilities.title')}
                </h2>
                <Badge variant="outline" className="nums">
                  {capabilities.data.length}
                </Badge>
              </div>
            </header>
            <ul className="divide-y">
              {capabilities.data.map((capability) => (
                <li key={capability.key} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={CAPABILITY_VARIANT[capability.status]} className="shrink-0">
                      {t(`diagnostics:capabilityStatus.${capability.status}`)}
                    </Badge>
                    <code className="min-w-0 flex-1 truncate text-[11.5px] text-ink-strong">
                      {capability.key}
                    </code>
                    <span className="shrink-0 text-[10.5px] text-ink-faint">
                      {capability.sourceClass}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={probe.isPending && probe.variables === capability.key}
                      disabled={probe.isPending}
                      onClick={() => void probe.mutate(capability.key)}
                    >
                      {t('diagnostics:hubCapabilities.probe')}
                    </Button>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-ink-faint">
                    <span>{capability.domain}</span>
                    <span>{capability.lastCheckedAt}</span>
                  </div>
                  {capability.status === 'session-required' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-1.5"
                      onClick={() => openSettings('account')}
                    >
                      {t('auth:hubSession.connect')}
                    </Button>
                  )}
                  {capability.status === 'forbidden' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-1.5"
                      onClick={() => openExternal(hubRelativeUrl('', hubEndpoint))}
                    >
                      {t('common:openOnHub')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {report.isLoading && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        )}

        {report.error !== null && !report.isLoading && (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="max-w-72 text-[13px] text-ink-muted">{describeError(t, report.error)}</p>
            <Button size="sm" onClick={() => void rerun.mutate()}>
              {t('common:retry')}
            </Button>
          </div>
        )}

        {report.error === null && !report.isLoading && checks.length === 0 && (
          <EmptyState
            icon={Activity}
            title={t('diagnostics:noResults.title')}
            body={t('diagnostics:noResults.body')}
          />
        )}

        {report.error === null &&
          !report.isLoading &&
          [...grouped.entries()].map(([category, categoryChecks]) => (
            <section key={category} className="rounded-lg border">
              <header className="flex items-center justify-between rounded-t-lg border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-3.5 text-ink-muted" aria-hidden />
                  <h2 className="text-[13px] font-semibold text-ink-strong">
                    {t(`diagnostics:category.${category}`)}
                  </h2>
                  <Badge variant="outline" className="nums">
                    {categoryChecks.length}
                  </Badge>
                </div>
              </header>
              <ul className="divide-y">
                {categoryChecks.map((check) => (
                  <li key={check.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <Badge variant={STATUS_VARIANT[check.status]} className="mt-0.5 shrink-0">
                        {t(`diagnostics:status.${check.status}`)}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-ink-strong">{check.message}</p>
                        {check.detail !== undefined && (
                          <p className="mt-0.5 font-mono text-[11.5px] break-all text-ink-faint">
                            {check.detail}
                          </p>
                        )}
                        {check.action !== undefined && (
                          <div className="mt-1.5 flex items-start gap-1.5 text-[12px] text-ink-muted">
                            <span className="shrink-0 font-semibold text-ink">
                              {t('diagnostics:actions')}:
                            </span>
                            <span>{check.action}</span>
                          </div>
                        )}
                      </div>
                      <span className="nums shrink-0 font-mono text-[10.5px] text-ink-faint">
                        {t('diagnostics:durationMs', { ms: check.durationMs })}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  )
}
