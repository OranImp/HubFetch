import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Wifi } from 'lucide-react'
import { LLM_PROVIDERS, type LlmProvider } from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useToasts } from '@/components/ui/toaster'
import { useAppStore } from '@/stores/app'
import { TranslationProviderForm } from './TranslationProviderForm'
import {
  assertNever,
  configFromDraft,
  draftsFromSettings,
  isLlmProvider,
  keepKeys,
  parseBaseUrl,
  testErrorKey,
  type Drafts,
  type ProviderDraft,
  type TestView
} from './translation-drafts'

const STATUS_QUERY_KEY = ['llm-status'] as const
const TAB_CLASS =
  '-mb-px border-b-2 border-transparent px-3.5 py-2 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:border-border hover:text-ink data-[state=active]:border-ink data-[state=active]:font-semibold data-[state=active]:text-ink-strong'

export function TranslationSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const ids = useId()

  const [selected, setSelected] = useState<LlmProvider>(settings.llm.activeProvider)
  const [drafts, setDrafts] = useState<Drafts>(() => draftsFromSettings(settings.llm))
  const [synced, setSynced] = useState(settings.llm)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [testView, setTestView] = useState<TestView>({ kind: 'idle' })

  if (settings.llm !== synced) {
    setSynced(settings.llm)
    setDrafts((prev) => keepKeys(prev, settings.llm))
  }

  const status = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => invoke('llm:get-status', undefined)
  })

  const current = drafts[selected]
  const urlParsed = parseBaseUrl(current.baseUrl)
  const modelId = current.modelId.trim()
  const urlInvalid = !urlParsed.ok
  const modelInvalid = modelId === ''
  const configured = status.data?.configured[selected] === true
  const typedKey = current.apiKey.trim()
  const canTest = !urlInvalid && !modelInvalid && (configured || typedKey !== '')

  const patchDraft = (patch: Partial<ProviderDraft>): void => {
    setTestView({ kind: 'idle' })
    setDrafts((prev) => ({ ...prev, [selected]: { ...prev[selected], ...patch } }))
  }

  const apply = useMutation({
    mutationFn: async () => {
      const openai = configFromDraft(drafts.openai)
      const anthropic = configFromDraft(drafts.anthropic)
      const gemini = configFromDraft(drafts.gemini)
      if (!openai || !anthropic || !gemini) throw new Error(t('settings:translation.invalidUrl'))
      await updateSettings({
        llm: { activeProvider: selected, providers: { openai, anthropic, gemini } }
      })
    },
    onSuccess: () => push(t('settings:translation.saved'), 'success'),
    onError: (err) => push(err.message, 'error')
  })

  const saveKey = useMutation({
    mutationFn: () => invoke('llm:set-credential', { provider: selected, apiKey: typedKey }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, next)
      patchDraft({ apiKey: '' })
      push(t('settings:translation.keySaved'), 'success')
    },
    onError: (err) => push(err.message, 'error')
  })

  const deleteKey = useMutation({
    mutationFn: () => invoke('llm:delete-credential', { provider: selected }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, next)
      setConfirmOpen(false)
      push(t('settings:translation.keyDeleted'), 'success')
    },
    onError: (err) => push(err.message, 'error')
  })

  const test = useMutation({
    mutationFn: () => {
      if (!urlParsed.ok) throw new Error(t('settings:translation.invalidUrl'))
      if (modelInvalid) throw new Error(t('settings:translation.invalidModel'))
      return invoke(
        'llm:test-connection',
        typedKey === ''
          ? { provider: selected, modelId, baseUrl: urlParsed.value }
          : { provider: selected, modelId, baseUrl: urlParsed.value, apiKey: typedKey }
      )
    },
    onSuccess: (result) => {
      if (result.ok) setTestView({ kind: 'ok', latencyMs: result.latencyMs })
      else setTestView({ kind: 'error', code: result.error })
    },
    onError: (err) => push(err.message, 'error')
  })

  const selectProvider = (value: string): void => {
    if (!isLlmProvider(value)) return
    setSelected(value)
    setTestView({ kind: 'idle' })
  }

  let testStatus: React.ReactNode = null
  switch (testView.kind) {
    case 'idle':
      break
    case 'ok':
      testStatus = (
        <p role="status" className="text-[12.5px] text-ink">
          {t('settings:translation.testOkLatency', { ms: testView.latencyMs })}
        </p>
      )
      break
    case 'error':
      testStatus = <p className="text-[12px] text-error">{t(testErrorKey(testView.code))}</p>
      break
    default:
      assertNever(testView)
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{t('settings:translation.title')}</h2>
      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        {t('settings:translation.description')}
      </p>

      <div role="tablist" className="flex items-center gap-1 border-b px-1">
        {LLM_PROVIDERS.map((provider) => (
          <button
            key={provider}
            type="button"
            role="tab"
            aria-selected={selected === provider}
            data-state={selected === provider ? 'active' : 'inactive'}
            className={TAB_CLASS}
            onClick={() => selectProvider(provider)}
          >
            {t(`settings:translation.providers.${provider}`)}
          </button>
        ))}
      </div>

      <TranslationProviderForm
        ids={ids}
        provider={selected}
        draft={current}
        configured={configured}
        urlInvalid={urlInvalid}
        modelInvalid={modelInvalid}
        savePending={saveKey.isPending}
        onPatch={patchDraft}
        onSaveKey={() => saveKey.mutate()}
        onDeleteKey={() => setConfirmOpen(true)}
      />

      {!configured && typedKey === '' ? (
        <p className="text-[12px] text-ink-faint">{t('settings:translation.noKey')}</p>
      ) : null}
      <p className="text-[12px] text-ink-faint">{t('settings:translation.testHint')}</p>
      {testStatus}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="cta"
          size="sm"
          loading={apply.isPending}
          disabled={urlInvalid}
          onClick={() => apply.mutate()}
        >
          {t('settings:translation.apply')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={test.isPending}
          disabled={!canTest}
          onClick={() => test.mutate()}
        >
          <Wifi className="size-3.5" aria-hidden />
          {t('settings:translation.test')}
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!deleteKey.isPending) setConfirmOpen(open)
        }}
      >
        <DialogContent>
          <DialogTitle className="text-[14px] font-semibold">
            {t('settings:translation.deleteTitle')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-[13px] text-ink-muted">
            {t('settings:translation.deleteBody')}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={deleteKey.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleteKey.isPending}
              onClick={() => deleteKey.mutate()}
            >
              {t('settings:translation.deleteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
