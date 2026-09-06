import { useTranslation } from 'react-i18next'
import type { Locale, LlmErrorCode } from '@hubfetch/shared'
import { cn } from '@/lib/utils'
import { MarkdownView, type MarkdownViewProps } from '@/components/browse/MarkdownView'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useAppStore } from '@/stores/app'
import { displayedMarkdown } from './translatable-post-state'
import { useTranslatablePost } from './useTranslatablePost'

export type { TranslationPane, TranslateView } from './translatable-post-state'
export { translationLocale } from './translatable-post-state'

export type TranslatablePostBodyProps = {
  readonly markdown: string
  readonly postId: string
  readonly targetLocale: Locale
  readonly compact?: boolean
  readonly kind?: MarkdownViewProps['kind']
  readonly repoId?: MarkdownViewProps['repoId']
  readonly revision?: MarkdownViewProps['revision']
}

const ERROR_KEYS = {
  'not-configured': 'profile:post.translate.error.not-configured',
  'invalid-config': 'profile:post.translate.error.invalid-config',
  auth: 'profile:post.translate.error.auth',
  forbidden: 'profile:post.translate.error.forbidden',
  'model-not-found': 'profile:post.translate.error.model-not-found',
  'rate-limited': 'profile:post.translate.error.rate-limited',
  timeout: 'profile:post.translate.error.timeout',
  canceled: 'profile:post.translate.error.canceled',
  'provider-unavailable': 'profile:post.translate.error.provider-unavailable',
  'malformed-response': 'profile:post.translate.error.malformed-response',
  'empty-response': 'profile:post.translate.error.empty-response',
  refused: 'profile:post.translate.error.refused',
  'input-too-long': 'profile:post.translate.error.input-too-long',
  unknown: 'profile:post.translate.error.unknown'
} as const satisfies Record<LlmErrorCode, string>

function stopCardNav(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

export function TranslatablePostBody({
  markdown,
  postId,
  targetLocale,
  compact,
  kind,
  repoId,
  revision
}: TranslatablePostBodyProps): React.JSX.Element {
  const { t } = useTranslation(['profile', 'common'])
  const openSettings = useAppStore((s) => s.openSettings)
  const { view, translate, setPane } = useTranslatablePost({ markdown, postId, targetLocale })
  const pending = view.kind === 'pending'
  const language = t(`common:language.${targetLocale}`)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn('flex flex-col', compact ? 'gap-1' : 'gap-2')}
          onContextMenu={stopCardNav}
        >
          {view.kind === 'pending' ? (
            <p className="text-[12px] text-ink-faint">{t('profile:post.translate.translating')}</p>
          ) : null}
          {view.kind === 'same-language' ? (
            <p className="text-[12px] text-ink-faint">
              {t('profile:post.translate.sameLanguage', { language })}
            </p>
          ) : null}
          {view.kind === 'translated' ? (
            <div onClick={stopCardNav} onKeyDown={stopCardNav}>
              <SegmentedControl
                aria-label={t('profile:post.translate.view')}
                value={view.showing}
                onChange={setPane}
                options={[
                  { value: 'original', label: t('profile:post.translate.original') },
                  { value: 'translated', label: t('profile:post.translate.translated') }
                ]}
              />
            </div>
          ) : null}
          {view.kind === 'error' ? (
            <div
              role="alert"
              onClick={stopCardNav}
              onKeyDown={stopCardNav}
              className="flex flex-col gap-2 rounded-lg border border-border-card bg-panel px-3 py-2"
            >
              <p className="text-[12.5px] text-ink">{t(ERROR_KEYS[view.error])}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={translate}>
                  {t('common:retry')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openSettings()}>
                  {t('profile:post.translate.openSettings')}
                </Button>
              </div>
            </div>
          ) : null}
          <MarkdownView
            markdown={displayedMarkdown(view, markdown)}
            kind={kind}
            repoId={repoId}
            revision={revision}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => event.preventDefault()}
        onClick={stopCardNav}
      >
        <ContextMenuItem loading={pending} disabled={pending} onSelect={() => translate()}>
          {t('profile:post.translate.action', { language })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
