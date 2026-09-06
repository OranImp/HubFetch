import { useEffect, useRef, useState } from 'react'
import type { Locale } from '@hubfetch/shared'
import { invoke } from '@/lib/ipc'
import {
  IDLE_VIEW,
  type TranslateView,
  type TranslationPane,
  viewFromResult
} from './translatable-post-state'

export function useTranslatablePost(args: {
  readonly markdown: string
  readonly postId: string
  readonly targetLocale: Locale
}): {
  readonly view: TranslateView
  readonly translate: () => void
  readonly setPane: (pane: TranslationPane) => void
} {
  const { markdown, postId, targetLocale } = args
  const [view, setView] = useState<TranslateView>(IDLE_VIEW)
  const activeId = useRef<string | null>(null)

  useEffect(() => {
    const cancel = (): void => {
      const id = activeId.current
      if (id === null) return
      activeId.current = null
      void invoke('llm:cancel', { requestId: id })
    }
    cancel()
    setView(IDLE_VIEW)
    return cancel
  }, [markdown, postId, targetLocale])

  const translate = (): void => {
    if (activeId.current !== null) return
    const requestId = crypto.randomUUID()
    activeId.current = requestId
    setView({ kind: 'pending', requestId })
    void invoke('llm:translate', { requestId, markdown, targetLocale })
      .then((result) => {
        if (activeId.current !== requestId) return
        activeId.current = null
        setView(viewFromResult(result))
      })
      .catch((err: unknown) => {
        if (activeId.current !== requestId) return
        activeId.current = null
        if (err instanceof Error && err.name === 'AbortError') {
          setView(IDLE_VIEW)
          return
        }
        setView({ kind: 'error', error: 'unknown' })
      })
  }

  const setPane = (pane: TranslationPane): void => {
    setView((current) => (current.kind === 'translated' ? { ...current, showing: pane } : current))
  }

  return { view, translate, setPane }
}
