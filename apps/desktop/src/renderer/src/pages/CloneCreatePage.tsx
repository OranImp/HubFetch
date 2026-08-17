import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cloneBranchSchema,
  cloneCommitShaSchema,
  cloneDestinationSchema,
  cloneNamespaceNameSchema,
  cloneTagSchema,
  deriveCloneUrl,
  type CloneAuthMode,
  type CloneRepoKind,
  type CloneRequest,
  type CloneRevision,
  type CloneTransport,
  type DiagnosticCheck,
  type ProxyMode
} from '@hubfetch/shared'
import { CheckCircle2, GitBranch, RefreshCw, XCircle } from 'lucide-react'
import { createClone } from '@/lib/clones'
import { runDiagnostics } from '@/lib/diagnostics'
import { describeError } from '@/lib/errors'
import { parseManualProxyDraft } from '@/lib/proxy'
import { useAppStore } from '@/stores/app'
import { ProxySelector, type ProxySelectorLabels } from '@/components/settings/ProxySelector'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Skeleton } from '@/components/ui/skeleton'
import { useToasts } from '@/components/ui/toaster'

const GIT_CHECK_ID = 'git.version'
const GIT_XET_CHECK_ID = 'git.xet'
const GIT_GCM_CHECK_ID = 'git.gcm'
const GIT_SSH_CHECK_ID = 'git.ssh'

function checkById(
  checks: readonly DiagnosticCheck[] | undefined,
  id: string
): DiagnosticCheck | undefined {
  return checks?.find((check) => check.id === id)
}

type RevisionKind = 'branch' | 'tag' | 'commit'

interface ValidationState {
  id: string | null
  revision: string | null
  destination: string | null
  proxy: string | null
  form: string | null
}

export function CloneCreatePage(): React.JSX.Element {
  const { t } = useTranslation(['clones', 'common', 'errors'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const auth = useAppStore((s) => s.auth)

  // Form state
  const [kind, setKind] = useState<CloneRepoKind>('model')
  const [repoId, setRepoId] = useState('')
  const [hasRevision, setHasRevision] = useState(false)
  const [revisionKind, setRevisionKind] = useState<RevisionKind>('branch')
  const [revisionValue, setRevisionValue] = useState('')
  const [transport, setTransport] = useState<CloneTransport>('https')
  const [authMode, setAuthMode] = useState<CloneAuthMode>('system')
  const [destination, setDestination] = useState('')
  const [proxyMode, setProxyMode] = useState<ProxyMode>('system')
  const [manualProxyDraft, setManualProxyDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)

  // Validation errors
  const [errors, setErrors] = useState<ValidationState>({
    id: null,
    revision: null,
    destination: null,
    proxy: null,
    form: null
  })

  // Diagnostics — existing Todo 28 IPC via the renderer convenience surface.
  const diagnostics = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => runDiagnostics(),
    staleTime: 60_000
  })

  const rerunDiagnostics = useMutation({
    mutationFn: () => runDiagnostics(),
    onSuccess: (report) => {
      queryClient.setQueryData(['diagnostics'], report)
    }
  })

  // Validation functions
  const validateRepoId = useCallback(
    (value: string): string | null => {
      if (!value.trim()) return t('clones:id.invalid')
      const result = cloneNamespaceNameSchema.safeParse(value.trim())
      return result.success ? null : t('clones:id.invalid')
    },
    [t]
  )

  const validateRevision = useCallback(
    (kind: RevisionKind, value: string): string | null => {
      if (!value.trim()) return null // Optional
      const trimmed = value.trim()
      if (kind === 'branch') {
        const result = cloneBranchSchema.safeParse(trimmed)
        return result.success ? null : t('clones:revision.invalidBranch')
      }
      if (kind === 'tag') {
        const result = cloneTagSchema.safeParse(trimmed)
        return result.success ? null : t('clones:revision.invalidTag')
      }
      // commit
      const result = cloneCommitShaSchema.safeParse(trimmed)
      return result.success ? null : t('clones:revision.invalidSha')
    },
    [t]
  )

  const validateDestination = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim()
      if (!trimmed) return t('clones:destination.invalid')
      return cloneDestinationSchema.safeParse(trimmed).success
        ? null
        : t('clones:destination.invalid')
    },
    [t]
  )

  const validateProxy = useCallback(
    (mode: ProxyMode, draft: string): string | null => {
      if (mode !== 'manual') return null
      const parsed = parseManualProxyDraft(draft)
      return parsed.ok && parsed.value !== null ? null : t('clones:proxy.invalid')
    },
    [t]
  )

  // Derived state
  const tokenAvailable = auth.status === 'signedIn'
  const effectiveAuthMode: CloneAuthMode =
    authMode === 'app-token' && tokenAvailable ? 'app-token' : 'system'

  const derivedUrl = useMemo(() => {
    const trimmedId = repoId.trim()
    if (!trimmedId || !cloneNamespaceNameSchema.safeParse(trimmedId).success) return ''
    try {
      return deriveCloneUrl(kind, trimmedId, transport)
    } catch {
      return ''
    }
  }, [kind, repoId, transport])

  const revision: CloneRevision | undefined = useMemo(() => {
    if (!hasRevision || !revisionValue.trim()) return undefined
    const trimmed = revisionValue.trim()
    if (revisionKind === 'branch' && cloneBranchSchema.safeParse(trimmed).success) {
      return { kind: 'branch', name: trimmed }
    }
    if (revisionKind === 'tag' && cloneTagSchema.safeParse(trimmed).success) {
      return { kind: 'tag', name: trimmed }
    }
    if (revisionKind === 'commit' && cloneCommitShaSchema.safeParse(trimmed).success) {
      return { kind: 'commit', sha: trimmed }
    }
    return undefined
  }, [hasRevision, revisionKind, revisionValue])

  const proxyOverride = useMemo(() => {
    if (proxyMode === 'system') return { mode: 'system' as const }
    if (proxyMode === 'direct') return { mode: 'direct' as const }
    const parsed = parseManualProxyDraft(manualProxyDraft)
    return parsed.ok && parsed.value !== null
      ? { mode: 'manual' as const, url: parsed.value }
      : null
  }, [proxyMode, manualProxyDraft])

  // Prerequisites — consume existing diagnostic check ids (Todo 28). Missing
  // Git blocks create; other statuses are reported as text only.
  const gitCheck = checkById(diagnostics.data?.checks, GIT_CHECK_ID)
  const gitXetCheck = checkById(diagnostics.data?.checks, GIT_XET_CHECK_ID)
  const gcmCheck = checkById(diagnostics.data?.checks, GIT_GCM_CHECK_ID)
  const sshCheck = checkById(diagnostics.data?.checks, GIT_SSH_CHECK_ID)
  const gitAvailable = gitCheck?.status === 'pass'
  const gitXetAvailable = gitXetCheck?.status === 'pass'
  const credHelperAvailable = gcmCheck?.status === 'pass'
  const sshAvailable = sshCheck?.status === 'pass'

  const canSubmit = useMemo(() => {
    if (submitting) return false
    if (!gitAvailable) return false
    if (transport === 'ssh' && !sshAvailable) return false
    if (authMode === 'app-token' && !tokenAvailable) return false
    if (!repoId.trim() || validateRepoId(repoId.trim()) !== null) return false
    if (validateDestination(destination) !== null) return false
    if (hasRevision && revisionValue.trim() && !revision) return false
    if (proxyMode === 'manual' && proxyOverride === null) return false
    return true
  }, [
    submitting,
    gitAvailable,
    sshAvailable,
    tokenAvailable,
    transport,
    authMode,
    repoId,
    destination,
    hasRevision,
    revisionValue,
    revision,
    proxyMode,
    proxyOverride,
    validateRepoId,
    validateDestination
  ])

  // Destination is a text input — user provides the path directly.
  const handleDestinationChange = useCallback((value: string) => {
    setDestination(value)
    setErrors((prev) => ({ ...prev, destination: null, form: null }))
  }, [])

  const handleCreate = useCallback(async () => {
    if (submitting || submitLock.current) return
    submitLock.current = true

    const idError = validateRepoId(repoId.trim())
    const revError = hasRevision ? validateRevision(revisionKind, revisionValue) : null
    const proxyError = validateProxy(proxyMode, manualProxyDraft)
    const destError = validateDestination(destination)
    const formError = !gitAvailable
      ? t('clones:errors.gitNotFound')
      : transport === 'ssh' && !sshAvailable
        ? t('clones:errors.sshNotAvailable')
        : authMode === 'app-token' && !tokenAvailable
          ? t('clones:errors.tokenRequired')
          : null

    if (idError || revError || proxyError || destError || formError) {
      submitLock.current = false
      setErrors({
        id: idError,
        revision: revError,
        destination: destError,
        proxy: proxyError,
        form: formError
      })
      return
    }

    setSubmitting(true)
    try {
      const request: CloneRequest = {
        kind,
        id: repoId.trim(),
        revision,
        transport,
        destination: destination.trim(),
        auth: effectiveAuthMode,
        proxy: proxyOverride ?? undefined
      }

      const record = await createClone(request)
      push(t('clones:created'), 'success')
      navigate(`/clones?selected=${encodeURIComponent(record.id)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const localized = /not empty|nonempty|already reserved/i.test(message)
        ? t('clones:errors.nonEmptyDestination')
        : /destination/i.test(message)
          ? t('clones:errors.destinationError')
          : /git is not available|dependency/i.test(message)
            ? t('clones:errors.gitNotFound')
            : describeError(t, error)
      setErrors((prev) => ({ ...prev, form: localized }))
      push(localized, 'error')
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }
  }, [
    kind,
    repoId,
    revision,
    transport,
    destination,
    effectiveAuthMode,
    proxyOverride,
    hasRevision,
    revisionKind,
    revisionValue,
    proxyMode,
    manualProxyDraft,
    submitting,
    gitAvailable,
    sshAvailable,
    tokenAvailable,
    authMode,
    validateRepoId,
    validateRevision,
    validateProxy,
    validateDestination,
    t,
    push,
    navigate
  ])

  const kindOptions = useMemo(
    () => [
      { value: 'model' as const, label: t('clones:kind.model') },
      { value: 'dataset' as const, label: t('clones:kind.dataset') },
      { value: 'space' as const, label: t('clones:kind.space') }
    ],
    [t]
  )

  const transportOptions = useMemo(
    () => [
      { value: 'https' as const, label: t('clones:transport.https') },
      { value: 'ssh' as const, label: t('clones:transport.ssh') }
    ],
    [t]
  )

  const authOptions = useMemo(
    () => [
      { value: 'system' as const, label: t('clones:auth.system') },
      {
        value: 'app-token' as const,
        label: tokenAvailable ? t('clones:auth.appToken') : t('clones:auth.appTokenUnavailable'),
        disabled: !tokenAvailable
      }
    ],
    [t, tokenAvailable]
  )

  const proxyLabels: ProxySelectorLabels = useMemo(
    () => ({
      modeLabel: t('clones:proxy.label'),
      system: t('clones:proxy.system'),
      direct: t('clones:proxy.direct'),
      manual: t('clones:proxy.manual'),
      hintSystem: t('clones:proxy.hintSystem'),
      hintDirect: t('clones:proxy.hintDirect'),
      hintManual: t('clones:proxy.hintManual'),
      manualLabel: t('clones:proxy.manualLabel'),
      invalid: t('clones:proxy.invalid')
    }),
    [t]
  )

  const revisionKindOptions = useMemo(
    () => [
      { value: 'branch' as const, label: t('clones:revision.branch') },
      { value: 'tag' as const, label: t('clones:revision.tag') },
      { value: 'commit' as const, label: t('clones:revision.commit') }
    ],
    [t]
  )

  const repoIdInputId = useId()
  const revisionInputId = useId()
  const destinationId = useId()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-5">
        <header>
          <h1 className="text-[15px] font-semibold text-ink-strong">{t('clones:title')}</h1>
        </header>

        <div className="flex flex-col gap-4 rounded-lg border border-border-card bg-card-gradient p-4">
          {/* Repository Kind */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium text-ink-strong">
              {t('clones:kind.label')}
            </label>
            <SegmentedControl options={kindOptions} value={kind} onChange={setKind} />
          </div>

          {/* Repository ID */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={repoIdInputId} className="text-[12.5px] font-medium text-ink-strong">
              {t('clones:id.label')}
            </label>
            <Input
              id={repoIdInputId}
              value={repoId}
              onChange={(e) => {
                setRepoId(e.target.value)
                setErrors((prev) => ({ ...prev, id: null }))
              }}
              placeholder={t('clones:id.placeholder')}
              aria-invalid={errors.id !== null}
            />
            {errors.id && (
              <span role="alert" className="text-[12px] text-error">
                {errors.id}
              </span>
            )}
          </div>

          {/* Revision */}
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={hasRevision}
                onChange={(e) => setHasRevision(e.target.checked)}
                className="size-4 accent-[var(--c-ink-strong)]"
              />
              <span className="text-[12.5px] font-medium text-ink-strong">
                {t('clones:revision.label')}
              </span>
            </label>
            {hasRevision && (
              <div className="flex flex-col gap-2">
                <SegmentedControl
                  options={revisionKindOptions}
                  value={revisionKind}
                  onChange={setRevisionKind}
                />
                <Input
                  id={revisionInputId}
                  value={revisionValue}
                  onChange={(e) => {
                    setRevisionValue(e.target.value)
                    setErrors((prev) => ({ ...prev, revision: null }))
                  }}
                  placeholder={
                    revisionKind === 'commit'
                      ? t('clones:revision.shaLabel')
                      : t('clones:revision.nameLabel')
                  }
                  aria-invalid={errors.revision !== null}
                />
                {errors.revision && (
                  <span role="alert" className="text-[12px] text-error">
                    {errors.revision}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Transport */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium text-ink-strong">
              {t('clones:transport.label')}
            </label>
            <SegmentedControl
              options={transportOptions}
              value={transport}
              onChange={setTransport}
            />
          </div>

          {/* Authentication */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium text-ink-strong">
              {t('clones:auth.label')}
            </label>
            <SegmentedControl options={authOptions} value={authMode} onChange={setAuthMode} />
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              {authMode === 'app-token'
                ? t('clones:auth.appTokenHint')
                : t('clones:auth.systemHint')}
            </p>
          </div>

          {/* Destination */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={destinationId} className="text-[12.5px] font-medium text-ink-strong">
              {t('clones:destination.label')}
            </label>
            <Input
              id={destinationId}
              value={destination}
              onChange={(e) => handleDestinationChange(e.target.value)}
              placeholder={t('clones:destination.placeholder')}
              spellCheck={false}
              aria-invalid={errors.destination !== null}
            />
            {errors.destination && (
              <span role="alert" className="text-[12px] text-error">
                {errors.destination}
              </span>
            )}
          </div>

          {/* Proxy — reusable Todo 21 selector; URL rule is the shared validator. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-strong">
              {t('clones:proxy.label')}
            </span>
            <ProxySelector
              mode={proxyMode}
              manualDraft={manualProxyDraft}
              onModeChange={setProxyMode}
              onManualDraftChange={(draft) => {
                setManualProxyDraft(draft)
                setErrors((prev) => ({ ...prev, proxy: null, form: null }))
              }}
              invalid={errors.proxy !== null}
              labels={proxyLabels}
            />
          </div>

          {/* Derived URL Display */}
          {derivedUrl && (
            <div className="flex flex-col gap-1.5 rounded-md bg-panel p-3">
              <span className="text-[11.5px] font-medium text-ink-strong">
                {t('clones:derivedUrl.label')}
              </span>
              <code className="text-[12px] text-ink-muted break-all font-mono">{derivedUrl}</code>
              <span className="text-[10.5px] text-ink-faint">{t('clones:derivedUrl.hint')}</span>
            </div>
          )}
        </div>

        {/* Diagnostics */}
        <div className="flex flex-col gap-3 rounded-lg border border-border-card bg-card-gradient p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13.5px] font-semibold text-ink-strong">
              {t('clones:diagnostics.title')}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => rerunDiagnostics.mutate()}
              disabled={rerunDiagnostics.isPending}
            >
              <RefreshCw
                className={`size-3.5 ${rerunDiagnostics.isPending ? 'animate-spin' : ''}`}
                aria-hidden
              />
              {t('clones:diagnostics.recheck')}
            </Button>
          </div>

          {diagnostics.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <DiagnosticItem
                label={t('clones:diagnostics.git')}
                status={gitAvailable ? 'pass' : 'missing'}
                message={
                  gitCheck?.message ??
                  (gitAvailable ? t('clones:diagnostics.pass') : t('clones:diagnostics.gitMissing'))
                }
              />
              <DiagnosticItem
                label={t('clones:diagnostics.gitXet')}
                status={gitXetAvailable ? 'pass' : 'missing'}
                message={
                  gitXetCheck?.message ??
                  (gitXetAvailable
                    ? t('clones:diagnostics.pass')
                    : t('clones:diagnostics.gitXetMissing'))
                }
                warning={!gitXetAvailable}
              />
              {transport === 'https' && (
                <DiagnosticItem
                  label={t('clones:diagnostics.credentialHelper')}
                  status={credHelperAvailable ? 'pass' : 'missing'}
                  message={
                    gcmCheck?.message ??
                    (credHelperAvailable
                      ? t('clones:diagnostics.pass')
                      : t('clones:diagnostics.credentialHelperMissing'))
                  }
                  warning={!credHelperAvailable}
                />
              )}
              {transport === 'ssh' && (
                <DiagnosticItem
                  label={t('clones:diagnostics.sshAgent')}
                  status={sshAvailable ? 'pass' : 'missing'}
                  message={
                    sshCheck?.message ??
                    (sshAvailable
                      ? t('clones:diagnostics.pass')
                      : t('clones:diagnostics.sshMissing'))
                  }
                />
              )}
            </div>
          )}
        </div>

        {errors.form && (
          <p role="alert" className="text-[12.5px] text-error">
            {errors.form}
          </p>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            {t('clones:cancel')}
          </Button>
          <Button
            variant="cta"
            size="sm"
            onClick={handleCreate}
            disabled={!canSubmit}
            loading={submitting}
          >
            <GitBranch className="size-4" aria-hidden />
            {submitting ? t('clones:creating') : t('clones:create')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function DiagnosticItem({
  label,
  status,
  message,
  warning
}: {
  label: string
  status: 'pass' | 'missing'
  message: string
  warning?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[12.5px]">
      {status === 'pass' ? (
        <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <XCircle
          className={`size-4 shrink-0 ${warning ? 'text-warning' : 'text-error'}`}
          aria-hidden
        />
      )}
      <span className="min-w-[120px] font-medium text-ink-strong">{label}</span>
      <span
        className={`flex-1 ${warning ? 'text-warning' : status === 'pass' ? 'text-success' : 'text-error'}`}
      >
        {message}
      </span>
    </div>
  )
}
