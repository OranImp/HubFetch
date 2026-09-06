// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmTranslateResult, PostSummary } from '@hubfetch/shared'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false
    })
  })
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => undefined
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined
  }
})

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  openExternal: vi.fn()
}))
const router = vi.hoisted(() => ({ navigate: vi.fn() }))
const ids = vi.hoisted(() => ({
  values: [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333'
  ],
  index: 0
}))

vi.mock('@/lib/ipc', () => ipc)
vi.mock('@/lib/syntax-highlighting', () => ({
  highlightCode: vi.fn().mockResolvedValue('<pre class="shiki"><code></code></pre>')
}))
vi.mock('@/components/ui/lightbox', () => ({
  Lightbox: () => null
}))
vi.mock('react-router', () => ({
  useNavigate: () => router.navigate
}))
vi.mock('react-i18next', () => {
  const TEMPLATES: Record<string, string> = {
    'profile:post.translate.action': 'Translate to {{language}}',
    'profile:post.translate.original': 'Original',
    'profile:post.translate.translated': 'Translated',
    'profile:post.translate.view': 'Translation view',
    'profile:post.translate.sameLanguage': 'Already in {{language}}',
    'profile:post.translate.openSettings': 'Open Translation Settings',
    'profile:post.translate.translating': 'Translating…',
    'common:language.en': 'English',
    'common:language.zh-CN': '简体中文',
    'common:retry': 'Retry',
    'common:openOnHub': 'Open on the Hub',
    'home:kind.post': 'Post'
  }
  return {
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        let out = TEMPLATES[key] ?? key
        if (!opts) return out
        for (const [name, value] of Object.entries(opts)) {
          out = out.replaceAll(`{{${name}}}`, String(value))
        }
        return out
      }
    })
  }
})

import { TranslatablePostBody } from './TranslatablePostBody'
import { PostCard } from '@/components/home/FeedItems'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/stores/app'

const ORIGINAL = 'Alpha post body'
const TRANSLATED = 'Texto traducido del post'
const POST_ID = 'alice/hello-post'

const POST: PostSummary = {
  slug: 'hello-post',
  author: 'alice',
  content: ORIGINAL,
  reactions: [],
  attachments: [],
  url: 'https://huggingface.co/posts/alice/hello-post',
  publishedAt: '2026-01-01T00:00:00.000Z',
  numComments: 0,
  numReactions: 0
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderBody(
  props: Partial<{
    markdown: string
    postId: string
    targetLocale: 'en' | 'zh-CN'
    compact: boolean
  }> = {}
): ReturnType<typeof render> {
  return render(
    <TranslatablePostBody
      markdown={props.markdown ?? ORIGINAL}
      postId={props.postId ?? POST_ID}
      targetLocale={props.targetLocale ?? 'en'}
      compact={props.compact}
    />
  )
}

async function openTranslateMenu(body = ORIGINAL): Promise<HTMLElement> {
  fireEvent.contextMenu(screen.getByText(body), { clientX: 24, clientY: 24 })
  return screen.findByRole('menu')
}

async function chooseTranslate(body = ORIGINAL): Promise<void> {
  await openTranslateMenu(body)
  fireEvent.click(screen.getByRole('menuitem', { name: /Translate to English/ }))
}

const originalOpenSettings = useAppStore.getState().openSettings

afterEach(() => {
  cleanup()
  ipc.invoke.mockReset()
  ipc.openExternal.mockReset()
  router.navigate.mockReset()
  useAppStore.setState({ openSettings: originalOpenSettings })
})

beforeEach(() => {
  ids.index = 0
  vi.stubGlobal('crypto', {
    randomUUID: () => {
      const value = ids.values[ids.index] ?? '44444444-4444-4444-8444-444444444444'
      ids.index += 1
      return value
    }
  })
})

describe('TranslatablePostBody', () => {
  it('shows a right-click menu with the resolved target language and does not request before selection', async () => {
    renderBody()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(ipc.invoke).not.toHaveBeenCalled()

    await openTranslateMenu()
    expect(screen.getByRole('menuitem', { name: 'Translate to English' })).toBeTruthy()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('resolves the target language for a non-English locale', async () => {
    renderBody({ targetLocale: 'zh-CN' })
    fireEvent.contextMenu(screen.getByText(ORIGINAL), { clientX: 24, clientY: 24 })
    await screen.findByRole('menu')
    expect(screen.getByRole('menuitem', { name: 'Translate to 简体中文' })).toBeTruthy()
  })

  it('sends one translate request per action with a UUID request id', async () => {
    ipc.invoke.mockResolvedValue({
      status: 'translated',
      sourceLanguage: 'en',
      markdown: TRANSLATED
    } satisfies LlmTranslateResult)
    renderBody()
    await chooseTranslate()

    await screen.findByText(TRANSLATED)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke).toHaveBeenCalledWith('llm:translate', {
      requestId: '11111111-1111-4111-8111-111111111111',
      markdown: ORIGINAL,
      targetLocale: 'en'
    })
  })

  it('disables the translate action while a request is pending', async () => {
    const pending = deferred<LlmTranslateResult>()
    ipc.invoke.mockReturnValueOnce(pending.promise)
    renderBody()
    await chooseTranslate()
    await screen.findByText('Translating…')

    await openTranslateMenu()
    const item = screen.getByRole('menuitem', { name: 'Translate to English' })
    expect(item.getAttribute('data-disabled')).not.toBeNull()
    fireEvent.click(item)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    pending.resolve({ status: 'translated', sourceLanguage: 'en', markdown: TRANSLATED })
  })

  it('cancels the in-flight request on unmount', async () => {
    const pending = deferred<LlmTranslateResult>()
    ipc.invoke.mockReturnValueOnce(pending.promise)
    const view = renderBody()
    await chooseTranslate()
    expect(ipc.invoke).toHaveBeenCalledWith('llm:translate', expect.anything())

    view.unmount()
    expect(ipc.invoke).toHaveBeenCalledWith('llm:cancel', {
      requestId: '11111111-1111-4111-8111-111111111111'
    })
  })

  it('cancels the in-flight request when a later source supersedes it', async () => {
    const first = deferred<LlmTranslateResult>()
    ipc.invoke.mockReturnValueOnce(first.promise)
    const view = renderBody()
    await chooseTranslate()

    view.rerender(
      <TranslatablePostBody markdown="Beta post body" postId={POST_ID} targetLocale="en" />
    )
    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith('llm:cancel', {
        requestId: '11111111-1111-4111-8111-111111111111'
      })
    })
    expect(screen.getByText('Beta post body')).toBeTruthy()
    expect(screen.queryByText('Translating…')).toBeNull()
  })

  it('toggles original and translated markdown without another request', async () => {
    ipc.invoke.mockResolvedValue({
      status: 'translated',
      sourceLanguage: 'en',
      markdown: TRANSLATED
    } satisfies LlmTranslateResult)
    renderBody()
    await chooseTranslate()
    await screen.findByText(TRANSLATED)

    const group = screen.getByRole('radiogroup', { name: 'Translation view' })
    expect(screen.getByRole('radio', { name: 'Translated' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }))
    expect(screen.getByText(ORIGINAL)).toBeTruthy()
    expect(screen.queryByText(TRANSLATED)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Translated' }))
    expect(screen.getByText(TRANSLATED)).toBeTruthy()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(group).toBeTruthy()
  })

  it('keeps the original and shows a same-language status', async () => {
    ipc.invoke.mockResolvedValue({
      status: 'same-language',
      sourceLanguage: 'en'
    } satisfies LlmTranslateResult)
    renderBody()
    await chooseTranslate()
    await screen.findByText('Already in English')
    expect(screen.getByText(ORIGINAL)).toBeTruthy()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('shows a typed error with Retry that issues a new request', async () => {
    ipc.invoke
      .mockResolvedValueOnce({
        status: 'error',
        error: 'rate-limited'
      } satisfies LlmTranslateResult)
      .mockResolvedValueOnce({
        status: 'translated',
        sourceLanguage: 'en',
        markdown: TRANSLATED
      } satisfies LlmTranslateResult)
    renderBody()
    await chooseTranslate()
    await screen.findByRole('alert')
    expect(screen.getByText('profile:post.translate.error.rate-limited')).toBeTruthy()
    expect(screen.getByText(ORIGINAL)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(TRANSLATED)
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'llm:translate', {
      requestId: '22222222-2222-4222-8222-222222222222',
      markdown: ORIGINAL,
      targetLocale: 'en'
    })
  })

  it('opens translation settings from a failure', async () => {
    const openSettings = vi.fn()
    useAppStore.setState({ openSettings })
    ipc.invoke.mockResolvedValue({
      status: 'error',
      error: 'not-configured'
    } satisfies LlmTranslateResult)
    renderBody()
    await chooseTranslate()
    fireEvent.click(await screen.findByRole('button', { name: 'Open Translation Settings' }))
    expect(openSettings).toHaveBeenCalled()
  })

  it('resets chrome when the target locale changes', async () => {
    ipc.invoke.mockResolvedValue({
      status: 'translated',
      sourceLanguage: 'en',
      markdown: TRANSLATED
    } satisfies LlmTranslateResult)
    const view = renderBody()
    await chooseTranslate()
    await screen.findByText(TRANSLATED)

    view.rerender(
      <TranslatablePostBody markdown={ORIGINAL} postId={POST_ID} targetLocale="zh-CN" />
    )
    expect(screen.getByText(ORIGINAL)).toBeTruthy()
    expect(screen.queryByText(TRANSLATED)).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('strips malicious HTML from translated markdown through MarkdownView', async () => {
    ipc.invoke.mockResolvedValue({
      status: 'translated',
      sourceLanguage: 'en',
      markdown: 'Safe **bold** <script>alert(1)</script><img src=x onerror="alert(1)">'
    } satisfies LlmTranslateResult)
    const { container } = renderBody()
    await chooseTranslate()
    await waitFor(() => expect(container.querySelector('strong, b')).not.toBeNull())
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img[onerror]')).toBeNull()
    expect(container.innerHTML).not.toContain('alert(1)')
  })
})

describe('PostCard translation menu', () => {
  it('does not navigate the feed card when the translate action is selected', async () => {
    ipc.invoke.mockResolvedValue({
      status: 'translated',
      sourceLanguage: 'en',
      markdown: TRANSLATED
    } satisfies LlmTranslateResult)
    render(
      <TooltipProvider>
        <PostCard post={POST} locale="en" />
      </TooltipProvider>
    )
    expect(router.navigate).not.toHaveBeenCalled()

    fireEvent.contextMenu(screen.getByText(ORIGINAL), { clientX: 24, clientY: 24 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Translate to English' }))
    await screen.findByText(TRANSLATED)
    expect(router.navigate).not.toHaveBeenCalled()
  })

  it('still navigates the feed card when the markdown body is clicked', () => {
    render(
      <TooltipProvider>
        <PostCard post={POST} locale="en" />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByText(ORIGINAL))
    expect(router.navigate).toHaveBeenCalledWith('/posts/alice/hello-post')
  })
})
