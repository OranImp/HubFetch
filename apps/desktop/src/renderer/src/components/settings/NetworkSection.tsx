import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, RotateCcw, Wifi } from 'lucide-react'
import {
  DEFAULT_HUB_ENDPOINT,
  DEFAULT_MANUAL_PROXY_URL,
  DEFAULT_PROXY_CONFIG,
  normalizeHubEndpoint
} from '@hubfetch/shared'
import type { ProxyConfig, ProxyMode } from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import { isHubRemoteQuery } from '@/lib/query'
import { parseManualProxyDraft, proxyConfigFromDraft, resolveCreateProxy } from '@/lib/proxy'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProxySelector, type ProxySelectorLabels } from '@/components/settings/ProxySelector'
import { useToasts } from '@/components/ui/toaster'
import { useAppStore } from '@/stores/app'

const ENDPOINT_INPUT_ID = 'settings-network-endpoint'
const ENDPOINT_ERROR_ID = 'settings-network-endpoint-error'

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Empty → null; otherwise require http(s) URL. */
function parseOptionalUrl(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!isHttpUrl(trimmed)) return { ok: false }
  return { ok: true, value: trimmed.replace(/\/$/, '') }
}

export function NetworkSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setAuth = useAppStore((s) => s.setAuth)
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)

  const [endpointDraft, setEndpointDraft] = useState(settings.hubEndpoint ?? '')
  const [modeDraft, setModeDraft] = useState<ProxyMode>(settings.proxy.mode)
  const [manualDraft, setManualDraft] = useState(settings.proxy.manualUrl ?? '')
  const [syncedEndpoint, setSyncedEndpoint] = useState(settings.hubEndpoint)
  const [syncedMode, setSyncedMode] = useState(settings.proxy.mode)
  const [syncedManual, setSyncedManual] = useState(settings.proxy.manualUrl)

  const applyNetworkSettings = async (
    hubEndpoint: string | null,
    proxy: ProxyConfig
  ): Promise<void> => {
    const previousEndpoint = normalizeHubEndpoint(settings.hubEndpoint)
    const endpointChanged = previousEndpoint !== normalizeHubEndpoint(hubEndpoint)
    if (endpointChanged) {
      await queryClient.cancelQueries({
        predicate: (query) => isHubRemoteQuery(query.queryKey)
      })
    }
    await updateSettings({ hubEndpoint, proxy })
    if (!endpointChanged) return
    // Every endpoint-aware remote key ends in its canonical endpoint. Remove
    // only the old partition, then reset any legacy/unkeyed active observers
    // against the newly attached main-process HubClient.
    queryClient.removeQueries({
      predicate: (query) =>
        isHubRemoteQuery(query.queryKey) && query.queryKey.at(-1) === previousEndpoint
    })
    await queryClient.resetQueries({
      predicate: (query) =>
        isHubRemoteQuery(query.queryKey) && query.queryKey.at(-1) !== previousEndpoint
    })
    setAuth(await invoke('auth:refreshUser', undefined))
  }

  // Reset drafts when store values change externally (e.g. reset / apply from elsewhere).
  if (settings.hubEndpoint !== syncedEndpoint) {
    setSyncedEndpoint(settings.hubEndpoint)
    setEndpointDraft(settings.hubEndpoint ?? '')
  }
  if (settings.proxy.mode !== syncedMode) {
    setSyncedMode(settings.proxy.mode)
    setModeDraft(settings.proxy.mode)
  }
  if (settings.proxy.manualUrl !== syncedManual) {
    setSyncedManual(settings.proxy.manualUrl)
    setManualDraft(settings.proxy.manualUrl ?? '')
  }

  // Live inline validation: derived, never stored. The Manual URL rule is the
  // SHARED normalizeManualProxyUrl — the same one the IPC schema enforces.
  const endpointParsed = parseOptionalUrl(endpointDraft)
  const manualParsed = parseManualProxyDraft(manualDraft)
  const endpointInvalid = !endpointParsed.ok
  const manualInvalid = modeDraft === 'manual' && (!manualParsed.ok || manualParsed.value === null)
  const draftsInvalid = endpointInvalid || manualInvalid

  const labels: ProxySelectorLabels = {
    modeLabel: t('settings:network.proxy.modeLabel'),
    system: t('settings:network.proxy.modeSystem'),
    direct: t('settings:network.proxy.modeDirect'),
    manual: t('settings:network.proxy.modeManual'),
    hintSystem: t('settings:network.proxy.hintSystem'),
    hintDirect: t('settings:network.proxy.hintDirect'),
    hintManual: t('settings:network.proxy.hintManual'),
    manualLabel: t('settings:network.proxy.manualLabel'),
    invalid: t('settings:network.proxy.invalid')
  }

  const apply = useMutation({
    mutationFn: async () => {
      const built = proxyConfigFromDraft(modeDraft, manualDraft, settings.proxy)
      if (!built.ok) throw new Error(t('settings:network.proxy.invalid'))
      if (!endpointParsed.ok) throw new Error(t('settings:network.invalidUrl'))
      await applyNetworkSettings(
        endpointParsed.value === null ? null : normalizeHubEndpoint(endpointParsed.value),
        built.config
      )
    },
    onSuccess: () => push(t('settings:network.saved'), 'success'),
    onError: (err) => push(err.message, 'error')
  })

  const test = useMutation({
    // Probe the drafts as typed (untouched drafts equal the applied config),
    // so a mode change + Test reflects what Apply would save. The probe runs
    // on a throwaway client and never changes the saved value.
    mutationFn: async () => {
      if (!endpointParsed.ok) throw new Error(t('settings:network.invalidUrl'))
      const override = resolveCreateProxy({
        useDefault: false,
        mode: modeDraft,
        manualUrl: manualDraft
      })
      if (!override) throw new Error(t('settings:network.proxy.invalid'))
      return invoke('network:testConnection', {
        endpoint: endpointParsed.value === null ? null : normalizeHubEndpoint(endpointParsed.value),
        proxy: override
      })
    },
    onSuccess: (result) => {
      if (result.ok) {
        push(t('settings:network.proxy.testOkLatency', { ms: result.latencyMs }), 'success')
      } else {
        push(t('settings:network.testFail', { error: result.error }), 'error')
      }
    },
    onError: (err) => push(err.message, 'error')
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{t('settings:network.title')}</h2>

      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        {t('settings:network.description')}
      </p>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <label htmlFor={ENDPOINT_INPUT_ID} className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-strong">
            {t('settings:network.hubEndpoint')}
          </span>
          <Input
            id={ENDPOINT_INPUT_ID}
            value={endpointDraft}
            placeholder={DEFAULT_HUB_ENDPOINT}
            spellCheck={false}
            aria-invalid={endpointInvalid}
            aria-describedby={endpointInvalid ? ENDPOINT_ERROR_ID : undefined}
            onChange={(e) => {
              setEndpointDraft(e.target.value)
            }}
          />
          {endpointInvalid && (
            <span id={ENDPOINT_ERROR_ID} className="text-[12px] text-error">
              {t('settings:network.invalidUrl')}
            </span>
          )}
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEndpointDraft('')
              void applyNetworkSettings(null, settings.proxy).then(() =>
                push(t('settings:network.resetEndpoint'), 'success')
              )
            }}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t('settings:network.reset')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <ProxySelector
          mode={modeDraft}
          manualDraft={manualDraft}
          onModeChange={setModeDraft}
          onManualDraftChange={setManualDraft}
          invalid={manualInvalid}
          labels={labels}
          seedPlaceholder={DEFAULT_MANUAL_PROXY_URL}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setModeDraft('system')
              setManualDraft(settings.proxy.manualUrl ?? DEFAULT_MANUAL_PROXY_URL)
              void updateSettings({ proxy: { ...DEFAULT_PROXY_CONFIG } }).then(() =>
                push(t('settings:network.proxy.resetProxy'), 'success')
              )
            }}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t('settings:network.reset')}
          </Button>
        </div>
      </div>

      <p className="text-[12px] text-ink-faint">{t('settings:network.downloadWarning')}</p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="cta"
          size="sm"
          loading={apply.isPending}
          disabled={draftsInvalid}
          onClick={() => apply.mutate()}
        >
          <Globe className="size-3.5" aria-hidden />
          {t('settings:network.apply')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={test.isPending}
          disabled={draftsInvalid}
          onClick={() => test.mutate()}
        >
          <Wifi className="size-3.5" aria-hidden />
          {t('settings:network.test')}
        </Button>
      </div>
    </section>
  )
}
