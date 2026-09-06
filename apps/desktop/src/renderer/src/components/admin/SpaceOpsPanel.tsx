import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  KeyRound,
  Pencil,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  ShieldAlert,
  SquareFunction,
  Trash2
} from 'lucide-react'
import { SPACE_FREE_FLAVOR, type SpaceHardwareFlavor, type SpaceRuntime } from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'
import { MANAGE_REPOS_SCOPE, scopeMissing } from '@/lib/scopes'
import { resolveLocale, useAppStore } from '@/stores/app'
import { useHubEndpointKey } from '@/hooks/use-hub-endpoint'

/** Secret/variable keys must look like environment variable names. */
const KEY_PATTERN = /^[a-zA-Z][_a-zA-Z0-9]*$/

type LogType = 'build' | 'run'

const LOG_TYPES: readonly LogType[] = ['build', 'run']

/**
 * Bounded runtime polling after a lifecycle mutation: refetch every few
 * seconds until the deadline passes or the runtime settles. The window is
 * always bounded — polling never runs forever.
 */
const RUNTIME_POLL_INTERVAL_MS = 2000
const RUNTIME_POLL_TIMEOUT_MS = 30_000

/** Stages that end the post-mutation polling window early. */
const SETTLED_STAGES: ReadonlySet<string> = new Set([
  'NO_APP_FILE',
  'BUILD_ERROR',
  'RUNNING',
  'PAUSED',
  'SLEEPING',
  'RUNTIME_ERROR',
  'STOPPED'
])

/** Official Space stages with localized labels (unknown stages fall back to raw text). */
const KNOWN_STAGES: readonly string[] = [
  'NO_APP_FILE',
  'BUILDING',
  'BUILD_ERROR',
  'APP_STARTING',
  'RUNNING',
  'RUNNING_APP_STARTING',
  'RUNNING_BUILDING',
  'PAUSED',
  'SLEEPING',
  'RUNTIME_ERROR',
  'DELETING',
  'STOPPED'
]

function stageToneClass(stage: string): string {
  if (stage === 'RUNNING') return 'bg-success/10 text-ink'
  if (stage === 'BUILD_ERROR' || stage === 'RUNTIME_ERROR') return 'bg-error/10 text-ink'
  if (
    stage === 'BUILDING' ||
    stage === 'APP_STARTING' ||
    stage === 'RUNNING_APP_STARTING' ||
    stage === 'RUNNING_BUILDING'
  ) {
    return 'bg-warning/10 text-ink'
  }
  return 'bg-panel-2 text-ink'
}

/** Formats an official sleep window without inventing any default. */
function formatSleepDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  if (seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

type SleepDisplay =
  { kind: 'duration'; seconds: number } | { kind: 'never' } | { kind: 'hubManaged' }

/**
 * Sleep window reported by the runtime: `-1` means never sleep (where the API
 * reports it); a null/absent window on the free tier is Hub-managed automatic
 * sleep. Never fabricates a duration the Hub did not send.
 */
function sleepDisplayOf(runtime: SpaceRuntime): SleepDisplay {
  const seconds = runtime.sleepTime ?? runtime.gcTimeout
  if (seconds === -1) return { kind: 'never' }
  if (typeof seconds === 'number' && seconds > 0) return { kind: 'duration', seconds }
  return { kind: 'hubManaged' }
}

/**
 * Custom sleep control is available only when the Hub reports a sleep window
 * or the Space runs on upgraded hardware. Free-tier Spaces with no reported
 * window are Hub-managed.
 */
function customSleepEnabled(runtime: SpaceRuntime): boolean {
  if (runtime.gcTimeout != null || runtime.sleepTime != null) return true
  return runtime.hardware != null && runtime.hardware !== SPACE_FREE_FLAVOR
}

type GateDialog =
  { kind: 'pause' } | { kind: 'factory' } | { kind: 'hardware'; flavor: SpaceHardwareFlavor } | null

function SectionHeading({
  icon: Icon,
  children
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <h3 className="flex items-center gap-2 text-[12px] font-semibold text-ink-faint">
      <Icon className="size-3.5 text-ink-faint" aria-hidden />
      {children}
    </h3>
  )
}

function InlineError({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
      <span className="min-w-0 flex-1">{message}</span>
      <Button size="sm" onClick={onRetry}>
        {t('common:retry')}
      </Button>
    </div>
  )
}

/**
 * Confirmation gate for lifecycle actions. Pausing needs a plain
 * confirmation; factory reboots and paid hardware changes additionally
 * require typing the exact repo id. Hardware changes state that billing may
 * start immediately — with no currency or estimate anywhere.
 */
function SpaceGateDialog({
  gate,
  repoId,
  pending,
  onClose,
  onConfirm
}: {
  gate: NonNullable<GateDialog>
  repoId: string
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation(['admin', 'common'])
  const [confirmText, setConfirmText] = useState('')
  const needsTyping = gate.kind !== 'pause'
  const confirmed = !needsTyping || confirmText === repoId

  const title =
    gate.kind === 'pause'
      ? t('admin:space.runtime.pauseTitle')
      : gate.kind === 'factory'
        ? t('admin:space.restart.factory')
        : t('admin:space.runtime.hardwareTitle')
  const body =
    gate.kind === 'pause'
      ? t('admin:space.runtime.pauseBody', { repoId })
      : gate.kind === 'factory'
        ? t('admin:space.restart.factoryHint')
        : t('admin:space.runtime.hardwareBilling')

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle className="text-[14px] font-semibold">{title}</DialogTitle>
        <DialogDescription className="mt-2 text-[13px] text-ink-muted">{body}</DialogDescription>
        {needsTyping && (
          <div className="mt-3 flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-ink-muted" htmlFor="space-gate-confirm">
              {t('admin:space.runtime.confirmLabel', { repoId })}
            </label>
            <Input
              id="space-gate-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={repoId}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            variant={gate.kind === 'hardware' ? 'cta' : 'danger'}
            size="sm"
            disabled={!confirmed || pending}
            loading={pending}
            onClick={onConfirm}
          >
            {gate.kind === 'pause'
              ? t('admin:space.runtime.pause')
              : gate.kind === 'factory'
                ? t('admin:space.restart.factory')
                : t('admin:space.runtime.hardwareApply')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Owner operations panel for a Space: live runtime state (stage, hardware,
 * sleep), bounded pause/resume/restart/hardware/sleep controls, secrets
 * (write-only values), variables, and a build/run log snapshot viewer.
 */
export function SpaceOpsPanel({ repoId }: { repoId: string }): React.JSX.Element {
  const { t } = useTranslation(['admin', 'common'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const auth = useAppStore((s) => s.auth)
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const locale = resolveLocale(settings, appInfo)
  const endpointKey = useHubEndpointKey()

  const canManage = !scopeMissing(auth, MANAGE_REPOS_SCOPE)

  // Runtime ---------------------------------------------------------------
  const [pollDeadline, setPollDeadline] = useState<number | null>(null)
  const [gate, setGate] = useState<GateDialog>(null)
  const [flavor, setFlavor] = useState<SpaceHardwareFlavor | ''>('')
  const [sleepSeconds, setSleepSeconds] = useState('')

  const runtime = useQuery({
    queryKey: ['space-runtime', repoId, endpointKey],
    queryFn: () => invoke('hub:spaceRuntime', { repoId }),
    enabled: canManage,
    // Bounded polling: refetch on the interval only while a mutation window is
    // open and the runtime has not settled yet; the deadline effect below
    // always closes the window.
    refetchInterval: (query): number | false => {
      if (pollDeadline === null) return false
      const data = query.state.data as SpaceRuntime | undefined
      if (
        data &&
        SETTLED_STAGES.has(data.stage) &&
        (!data.requestedHardware || data.requestedHardware === data.hardware)
      ) {
        return false
      }
      return RUNTIME_POLL_INTERVAL_MS
    }
  })

  // The polling window is bounded: it always closes at its deadline.
  useEffect(() => {
    if (pollDeadline === null) return
    const timer = setTimeout(() => setPollDeadline(null), Math.max(0, pollDeadline - Date.now()))
    return () => clearTimeout(timer)
  }, [pollDeadline])

  const refreshAfterMutation = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['space-runtime', repoId] })
    void queryClient.invalidateQueries({ queryKey: ['repo', 'space', repoId] })
    setPollDeadline(Date.now() + RUNTIME_POLL_TIMEOUT_MS)
  }

  const pause = useMutation({
    mutationFn: () => invoke('hub:spacePause', { repoId }),
    onSuccess: () => {
      push(t('admin:space.runtime.pauseDone'), 'success')
      setGate(null)
      refreshAfterMutation()
    },
    onError: (err) => push(err.message, 'error')
  })

  /** Resume a paused Space: a normal restart brings it back. */
  const resume = useMutation({
    mutationFn: () => invoke('hub:spaceRestart', { repoId }),
    onSuccess: () => {
      push(t('admin:space.runtime.resumeDone'), 'success')
      refreshAfterMutation()
    },
    onError: (err) => push(err.message, 'error')
  })

  const setHardware = useMutation({
    mutationFn: (args: { flavor: SpaceHardwareFlavor }) =>
      invoke('hub:spaceHardwareSet', { repoId, flavor: args.flavor }),
    onSuccess: () => {
      push(t('admin:space.runtime.hardwareDone'), 'success')
      setGate(null)
      setFlavor('')
      refreshAfterMutation()
    },
    onError: (err) => push(err.message, 'error')
  })

  const setSleep = useMutation({
    mutationFn: (args: { seconds: number }) =>
      invoke('hub:spaceSleepTimeSet', { repoId, seconds: args.seconds }),
    onSuccess: () => {
      push(t('admin:space.runtime.sleepDone'), 'success')
      setSleepSeconds('')
      refreshAfterMutation()
    },
    onError: (err) => push(err.message, 'error')
  })

  // Hardware catalog (public read; the client strips every pricing field) ----
  const catalog = useQuery({
    queryKey: ['space-hardware', endpointKey],
    queryFn: () => invoke('hub:spaceHardwareList', undefined),
    enabled: canManage
  })
  const currentHardware = runtime.data?.hardware ?? null
  const flavorChanged = flavor !== '' && flavor !== currentHardware
  const selectedPaid = flavor !== '' && flavor !== SPACE_FREE_FLAVOR

  // Sleep-time controls -----------------------------------------------------
  const sleepCustom = runtime.data ? customSleepEnabled(runtime.data) : false
  const parsedSleep = Number.parseInt(sleepSeconds, 10)
  const sleepValid = Number.isInteger(parsedSleep) && parsedSleep >= 1

  // Secrets --------------------------------------------------------------
  const [secretKey, setSecretKey] = useState('')
  const [secretValue, setSecretValue] = useState('')
  const [secretDescription, setSecretDescription] = useState('')

  const secrets = useQuery({
    queryKey: ['space-secrets', repoId, endpointKey],
    queryFn: () => invoke('hub:spaceSecrets', { repoId })
  })

  const setSecret = useMutation({
    mutationFn: () =>
      invoke('hub:spaceSecretSet', {
        repoId,
        key: secretKey.trim(),
        value: secretValue,
        description: secretDescription.trim() || undefined
      }),
    onSuccess: () => {
      push(t('admin:space.secrets.saved'), 'success')
      setSecretKey('')
      setSecretValue('')
      setSecretDescription('')
      void queryClient.invalidateQueries({ queryKey: ['space-secrets', repoId] })
    },
    onError: (err) => push(err.message, 'error')
  })

  const deleteSecret = useMutation({
    mutationFn: (key: string) => invoke('hub:spaceSecretDelete', { repoId, key }),
    onSuccess: () => {
      push(t('admin:space.secrets.deleted'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['space-secrets', repoId] })
    },
    onError: (err) => push(err.message, 'error')
  })

  const secretKeyValid = KEY_PATTERN.test(secretKey.trim())
  const canAddSecret = secretKeyValid && secretValue !== '' && !setSecret.isPending

  // Variables ------------------------------------------------------------
  const [variableKey, setVariableKey] = useState('')
  const [variableValue, setVariableValue] = useState('')
  const [variableDescription, setVariableDescription] = useState('')

  const variables = useQuery({
    queryKey: ['space-variables', repoId, endpointKey],
    queryFn: () => invoke('hub:spaceVariables', { repoId })
  })

  const setVariable = useMutation({
    mutationFn: () =>
      invoke('hub:spaceVariableSet', {
        repoId,
        key: variableKey.trim(),
        value: variableValue,
        description: variableDescription.trim() || undefined
      }),
    onSuccess: () => {
      push(t('admin:space.variables.saved'), 'success')
      setVariableKey('')
      setVariableValue('')
      setVariableDescription('')
      void queryClient.invalidateQueries({ queryKey: ['space-variables', repoId] })
    },
    onError: (err) => push(err.message, 'error')
  })

  const deleteVariable = useMutation({
    mutationFn: (key: string) => invoke('hub:spaceVariableDelete', { repoId, key }),
    onSuccess: () => {
      push(t('admin:space.variables.deleted'), 'success')
      void queryClient.invalidateQueries({ queryKey: ['space-variables', repoId] })
    },
    onError: (err) => push(err.message, 'error')
  })

  const variableKeyValid = KEY_PATTERN.test(variableKey.trim())
  const canSaveVariable = variableKeyValid && !setVariable.isPending

  // Logs -----------------------------------------------------------------
  const [logType, setLogType] = useState<LogType>('run')

  const logs = useQuery({
    queryKey: ['space-logs', repoId, logType, endpointKey],
    queryFn: () => invoke('hub:spaceLogs', { repoId, logType }),
    staleTime: 0
  })

  // Restart ----------------------------------------------------------------
  const restart = useMutation({
    mutationFn: (factory: boolean) =>
      invoke('hub:spaceRestart', { repoId, factory: factory || undefined }),
    onSuccess: () => {
      push(t('admin:space.restart.done'), 'success')
      setGate(null)
      refreshAfterMutation()
    },
    onError: (err) => push(err.message, 'error')
  })

  const runtimeData = runtime.data
  const stage = runtimeData?.stage
  const sleep = runtimeData ? sleepDisplayOf(runtimeData) : null

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
      {!canManage && (
        <p className="flex items-start gap-2 rounded-md border bg-panel px-3 py-2 text-[12.5px] text-ink-muted">
          <ShieldAlert className="mt-px size-4 shrink-0 text-warning" aria-hidden />
          {t('admin:gatedHint.body')}
        </p>
      )}

      {/* Runtime */}
      {canManage && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <SectionHeading icon={Activity}>{t('admin:space.runtime.title')}</SectionHeading>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              aria-label={t('admin:space.runtime.refresh')}
              loading={runtime.isFetching}
              onClick={() => void runtime.refetch()}
            >
              {!runtime.isFetching && <RefreshCw className="size-3.5" aria-hidden />}
            </Button>
          </div>
          {runtime.isPending && <Skeleton className="h-16" />}
          {runtime.isError && (
            <InlineError message={runtime.error.message} onRetry={() => void runtime.refetch()} />
          )}
          {runtimeData && (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium',
                    stageToneClass(runtimeData.stage)
                  )}
                >
                  {stage != null && KNOWN_STAGES.includes(stage)
                    ? t(`admin:space.runtime.stage.${stage}`)
                    : (stage ?? '').toLowerCase().replace(/_/g, ' ')}
                </span>
                {pollDeadline !== null && (
                  <span className="text-[11px] text-ink-faint">
                    {t('admin:space.runtime.polling')}
                  </span>
                )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
                <dt className="text-ink-faint">{t('admin:space.runtime.hardware')}</dt>
                <dd className="min-w-0 truncate font-mono text-ink">{currentHardware ?? '—'}</dd>
                {runtimeData.requestedHardware && (
                  <>
                    <dt className="text-ink-faint">{t('admin:space.runtime.requestedHardware')}</dt>
                    <dd className="min-w-0 truncate font-mono text-ink">
                      {runtimeData.requestedHardware}
                    </dd>
                  </>
                )}
                <dt className="text-ink-faint">{t('admin:space.runtime.sleepTime')}</dt>
                <dd className="min-w-0 truncate text-ink">
                  {sleep?.kind === 'never'
                    ? t('admin:space.runtime.sleepNever')
                    : sleep?.kind === 'duration'
                      ? formatSleepDuration(sleep.seconds)
                      : t('admin:space.runtime.hubManagedSleep')}
                </dd>
              </dl>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pause.isPending || stage === 'PAUSED'}
                  loading={pause.isPending}
                  onClick={() => setGate({ kind: 'pause' })}
                >
                  <Pause className="size-3.5" aria-hidden />
                  {t('admin:space.runtime.pause')}
                </Button>
                {stage === 'PAUSED' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={resume.isPending}
                    loading={resume.isPending}
                    onClick={() => resume.mutate()}
                  >
                    <Play className="size-3.5" aria-hidden />
                    {t('admin:space.runtime.resume')}
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-1.5 border-t pt-3">
                <p className="text-[11.5px] font-medium text-ink-faint">
                  {t('admin:space.runtime.hardwareChange')}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    aria-label={t('admin:space.runtime.hardwareChange')}
                    value={flavor}
                    onChange={(e) => setFlavor(e.target.value as SpaceHardwareFlavor)}
                    disabled={catalog.isPending || setHardware.isPending}
                    className="h-8 w-56 rounded-md border border-border-card bg-panel px-2 text-[12.5px] text-ink disabled:opacity-50"
                  >
                    <option value="" disabled>
                      {t('admin:space.runtime.hardwarePlaceholder')}
                    </option>
                    {catalog.data?.map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {(entry.prettyName ?? entry.name) +
                          (entry.accelerator ? ` · ${entry.accelerator}` : '')}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!flavorChanged || setHardware.isPending}
                    loading={setHardware.isPending}
                    onClick={() =>
                      flavor !== '' &&
                      (selectedPaid
                        ? setGate({ kind: 'hardware', flavor })
                        : setHardware.mutate({ flavor }))
                    }
                  >
                    {t('admin:space.runtime.hardwareApply')}
                  </Button>
                </div>
                {selectedPaid && (
                  <p className="text-[11.5px] text-warning">
                    {t('admin:space.runtime.hardwareBilling')}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5 border-t pt-3">
                <p className="text-[11.5px] font-medium text-ink-faint">
                  {t('admin:space.runtime.sleepChange')}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input
                    value={sleepSeconds}
                    onChange={(e) => setSleepSeconds(e.target.value)}
                    placeholder={t('admin:space.runtime.sleepPlaceholder')}
                    className="w-28 flex-none font-mono"
                    inputMode="numeric"
                    spellCheck={false}
                    disabled={!sleepCustom}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!sleepCustom || !sleepValid || setSleep.isPending}
                    loading={setSleep.isPending && setSleep.variables?.seconds !== -1}
                    onClick={() => setSleep.mutate({ seconds: parsedSleep })}
                  >
                    {t('admin:space.runtime.sleepApply')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!sleepCustom || setSleep.isPending}
                    loading={setSleep.isPending && setSleep.variables?.seconds === -1}
                    onClick={() => setSleep.mutate({ seconds: -1 })}
                  >
                    {t('admin:space.runtime.sleepNeverApply')}
                  </Button>
                </div>
                {!sleepCustom && (
                  <p className="text-[11.5px] text-ink-faint">
                    {t('admin:space.runtime.sleepDisabledHint')}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Secrets */}
      <section className="flex flex-col gap-3">
        <SectionHeading icon={KeyRound}>{t('admin:space.secrets.title')}</SectionHeading>
        <p className="text-[12px] text-ink-faint">{t('admin:space.secrets.writeOnly')}</p>
        {secrets.isPending && <Skeleton className="h-10" />}
        {secrets.isError && (
          <InlineError message={secrets.error.message} onRetry={() => void secrets.refetch()} />
        )}
        {secrets.data?.length === 0 && (
          <p className="text-[12.5px] text-ink-faint">{t('admin:space.secrets.empty')}</p>
        )}
        <div className="flex flex-col gap-1">
          {secrets.data?.map((secret) => (
            <div key={secret.key} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{secret.key}</span>
              {secret.description && (
                <span className="hidden min-w-0 truncate text-[11.5px] text-ink-faint sm:block">
                  {secret.description}
                </span>
              )}
              {secret.updatedAt && (
                <span className="nums shrink-0 text-[11px] text-ink-faint">
                  {formatRelativeTime(secret.updatedAt, locale)}
                </span>
              )}
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t('common:delete')}
                  disabled={deleteSecret.isPending}
                  onClick={() => deleteSecret.mutate(secret.key)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={t('admin:space.keyPlaceholder')}
              className="w-40 flex-none font-mono"
              spellCheck={false}
            />
            <Input
              type="password"
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              placeholder={t('admin:space.valuePlaceholder')}
              className="w-40 flex-none font-mono"
              autoComplete="new-password"
            />
            <Input
              value={secretDescription}
              onChange={(e) => setSecretDescription(e.target.value)}
              placeholder={t('admin:space.descriptionPlaceholder')}
              className="w-40 flex-none"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!canAddSecret}
              loading={setSecret.isPending}
              onClick={() => setSecret.mutate()}
            >
              {t('admin:space.secrets.add')}
            </Button>
          </div>
        )}
      </section>

      {/* Variables */}
      <section className="flex flex-col gap-3">
        <SectionHeading icon={SquareFunction}>{t('admin:space.variables.title')}</SectionHeading>
        {variables.isPending && <Skeleton className="h-10" />}
        {variables.isError && (
          <InlineError message={variables.error.message} onRetry={() => void variables.refetch()} />
        )}
        {variables.data?.length === 0 && (
          <p className="text-[12.5px] text-ink-faint">{t('admin:space.variables.empty')}</p>
        )}
        <div className="flex flex-col gap-1">
          {variables.data?.map((variable) => (
            <div key={variable.key} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <span className="min-w-0 truncate font-mono text-[12.5px]">{variable.key}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
                {variable.value ?? ''}
              </span>
              {variable.updatedAt && (
                <span className="nums shrink-0 text-[11px] text-ink-faint">
                  {formatRelativeTime(variable.updatedAt, locale)}
                </span>
              )}
              {canManage && (
                <span className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t('admin:space.variables.edit')}
                    onClick={() => {
                      setVariableKey(variable.key)
                      setVariableValue(variable.value ?? '')
                      setVariableDescription(variable.description ?? '')
                    }}
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={t('common:delete')}
                    disabled={deleteVariable.isPending}
                    onClick={() => deleteVariable.mutate(variable.key)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={variableKey}
              onChange={(e) => setVariableKey(e.target.value)}
              placeholder={t('admin:space.keyPlaceholder')}
              className="w-40 flex-none font-mono"
              spellCheck={false}
            />
            <Input
              value={variableValue}
              onChange={(e) => setVariableValue(e.target.value)}
              placeholder={t('admin:space.valuePlaceholder')}
              className="w-40 flex-none font-mono"
              spellCheck={false}
            />
            <Input
              value={variableDescription}
              onChange={(e) => setVariableDescription(e.target.value)}
              placeholder={t('admin:space.descriptionPlaceholder')}
              className="w-40 flex-none"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={!canSaveVariable}
              loading={setVariable.isPending}
              onClick={() => setVariable.mutate()}
            >
              {t('admin:space.variables.save')}
            </Button>
          </div>
        )}
      </section>

      {/* Logs */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <SectionHeading icon={ScrollText}>{t('admin:space.logs.title')}</SectionHeading>
          <div className="ml-auto flex items-center gap-0.5">
            {LOG_TYPES.map((type) => (
              <Button
                key={type}
                variant="ghost"
                size="sm"
                aria-pressed={logType === type}
                className={cn(logType === type && 'bg-panel-2 text-ink-strong')}
                onClick={() => setLogType(type)}
              >
                {t(`admin:space.logs.${type}`)}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('admin:space.logs.refresh')}
              loading={logs.isFetching}
              onClick={() => void logs.refetch()}
            >
              {!logs.isFetching && <RefreshCw className="size-3.5" aria-hidden />}
            </Button>
          </div>
        </div>
        {logs.isError ? (
          <InlineError message={logs.error.message} onRetry={() => void logs.refetch()} />
        ) : (
          <pre className="h-64 overflow-auto rounded-lg border border-border-card bg-panel p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">
            {logs.isPending
              ? t('common:loading')
              : logs.data.text.trim() !== ''
                ? logs.data.text
                : t('admin:space.logs.empty')}
          </pre>
        )}
      </section>

      {/* Restart */}
      {canManage && (
        <section className="flex flex-col gap-3">
          <SectionHeading icon={RotateCw}>{t('admin:space.restart.title')}</SectionHeading>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              loading={restart.isPending && restart.variables === false}
              disabled={restart.isPending}
              onClick={() => restart.mutate(false)}
            >
              <RotateCw className="size-3.5" aria-hidden />
              {t('admin:space.restart.restart')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={restart.isPending && restart.variables === true}
              disabled={restart.isPending}
              onClick={() => setGate({ kind: 'factory' })}
            >
              {t('admin:space.restart.factory')}
            </Button>
          </div>
          <p className="text-[12px] text-ink-faint">{t('admin:space.restart.factoryHint')}</p>
        </section>
      )}

      {gate && (
        <SpaceGateDialog
          gate={gate}
          repoId={repoId}
          pending={
            gate.kind === 'pause'
              ? pause.isPending
              : gate.kind === 'factory'
                ? restart.isPending
                : setHardware.isPending
          }
          onClose={() => setGate(null)}
          onConfirm={() => {
            if (gate.kind === 'pause') pause.mutate()
            else if (gate.kind === 'factory') restart.mutate(true)
            else if (gate.kind === 'hardware') setHardware.mutate({ flavor: gate.flavor })
          }}
        />
      )}
    </div>
  )
}
