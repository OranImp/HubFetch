// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryErrorState } from './QueryErrorState'

const app = vi.hoisted(() => ({
  openSettings: vi.fn(),
  settings: { hubEndpoint: null }
}))
const ipc = vi.hoisted(() => ({ openExternal: vi.fn() }))

vi.mock('@/stores/app', () => ({
  useAppStore: (selector: (state: typeof app) => unknown) => selector(app)
}))
vi.mock('@/lib/ipc', () => ipc)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'errors:capability.session-required': 'This capability needs a Hub web session.',
        'errors:capability.forbidden': 'The Hub denied this capability.',
        'errors:query.title': 'Could not load this content',
        'auth:hubSession.connect': 'Connect Hub web session',
        'common:openOnHub': 'Open on the Hub',
        'common:retry': 'Retry'
      })[key] ?? key
  })
}))

describe('QueryErrorState capability recovery', () => {
  afterEach(() => {
    cleanup()
    app.openSettings.mockReset()
    ipc.openExternal.mockReset()
  })

  it('offers session connection without rendering secret-bearing error text', () => {
    render(
      <QueryErrorState
        error={
          new Error(
            'token=secret [HUB_CAPABILITY_ERROR key=listWatched code=session-required] HUB_WEB_SESSION_REQUIRED'
          )
        }
      />
    )

    expect(screen.getByRole('alert').textContent ?? '').not.toContain('secret')
    fireEvent.click(screen.getByRole('button', { name: 'Connect Hub web session' }))
    expect(app.openSettings).toHaveBeenCalledWith('account')
  })

  it('opens the safe Hub root for forbidden capability errors', () => {
    render(
      <QueryErrorState
        error={new Error('[HUB_CAPABILITY_ERROR key=getPosts code=forbidden]')}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open on the Hub' }))
    expect(ipc.openExternal).toHaveBeenCalledWith('https://huggingface.co')
  })
})
