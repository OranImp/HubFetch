import { useTranslation } from 'react-i18next'
import { KeyRound, RotateCcw, Trash2 } from 'lucide-react'
import { DEFAULT_LLM_BASE_URLS, type LlmProvider } from '@hubfetch/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ProviderDraft } from './translation-drafts'

interface TranslationProviderFormProps {
  readonly ids: string
  readonly provider: LlmProvider
  readonly draft: ProviderDraft
  readonly configured: boolean
  readonly urlInvalid: boolean
  readonly modelInvalid: boolean
  readonly savePending: boolean
  readonly onPatch: (patch: Partial<ProviderDraft>) => void
  readonly onSaveKey: () => void
  readonly onDeleteKey: () => void
}

export function TranslationProviderForm(props: TranslationProviderFormProps): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const { ids, provider, draft, configured, urlInvalid, modelInvalid, savePending } = props
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <Badge variant={configured ? 'success' : 'neutral'}>
        {t(configured ? 'settings:translation.configured' : 'settings:translation.notConfigured')}
      </Badge>

      <label htmlFor={`${ids}-base`} className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-strong">
          {t('settings:translation.baseUrl')}
        </span>
        <Input
          id={`${ids}-base`}
          value={draft.baseUrl}
          placeholder={DEFAULT_LLM_BASE_URLS[provider]}
          spellCheck={false}
          aria-invalid={urlInvalid}
          aria-describedby={urlInvalid ? `${ids}-base-error` : undefined}
          onChange={(event) => props.onPatch({ baseUrl: event.target.value })}
        />
        {urlInvalid ? (
          <span id={`${ids}-base-error`} className="text-[12px] text-error">
            {t('settings:translation.invalidUrl')}
          </span>
        ) : null}
      </label>

      <label htmlFor={`${ids}-model`} className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-strong">
          {t('settings:translation.model')}
        </span>
        <Input
          id={`${ids}-model`}
          value={draft.modelId}
          spellCheck={false}
          aria-invalid={modelInvalid}
          aria-describedby={modelInvalid ? `${ids}-model-error` : undefined}
          onChange={(event) => props.onPatch({ modelId: event.target.value })}
        />
        {modelInvalid ? (
          <span id={`${ids}-model-error`} className="text-[12px] text-error">
            {t('settings:translation.invalidModel')}
          </span>
        ) : null}
      </label>

      <label htmlFor={`${ids}-key`} className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-strong">
          {t('settings:translation.apiKey')}
        </span>
        <Input
          id={`${ids}-key`}
          type="password"
          value={draft.apiKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => props.onPatch({ apiKey: event.target.value })}
        />
      </label>
      <p className="text-[12px] text-ink-faint">{t('settings:translation.apiKeyHint')}</p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={savePending}
          onClick={() => {
            if (draft.apiKey.trim() === '') return
            props.onSaveKey()
          }}
        >
          <KeyRound className="size-3.5" aria-hidden />
          {t('settings:translation.saveKey')}
        </Button>
        <Button variant="ghost" size="sm" disabled={!configured} onClick={props.onDeleteKey}>
          <Trash2 className="size-3.5" aria-hidden />
          {t('settings:translation.deleteKey')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => props.onPatch({ baseUrl: '' })}>
          <RotateCcw className="size-3.5" aria-hidden />
          {t('settings:translation.reset')}
        </Button>
      </div>
    </div>
  )
}
