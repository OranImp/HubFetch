// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
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

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './context-menu'

afterEach(() => {
  cleanup()
})

function Harness(props: {
  readonly onTranslate: () => void
  readonly onCopy: () => void
  readonly onDisabled: () => void
  readonly onLoading: () => void
}): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <article>Post body</article>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Post actions</ContextMenuLabel>
        <ContextMenuItem onSelect={props.onTranslate}>Translate</ContextMenuItem>
        <ContextMenuItem onSelect={props.onCopy}>Copy</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled onSelect={props.onDisabled}>
          Disabled action
        </ContextMenuItem>
        <ContextMenuItem loading onSelect={props.onLoading}>
          Loading action
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function renderMenu(): {
  readonly onTranslate: ReturnType<typeof vi.fn>
  readonly onCopy: ReturnType<typeof vi.fn>
  readonly onDisabled: ReturnType<typeof vi.fn>
  readonly onLoading: ReturnType<typeof vi.fn>
} {
  const onTranslate = vi.fn()
  const onCopy = vi.fn()
  const onDisabled = vi.fn()
  const onLoading = vi.fn()
  render(
    <Harness
      onTranslate={onTranslate}
      onCopy={onCopy}
      onDisabled={onDisabled}
      onLoading={onLoading}
    />
  )
  return { onTranslate, onCopy, onDisabled, onLoading }
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.contextMenu(screen.getByText('Post body'), { clientX: 24, clientY: 24 })
  return screen.findByRole('menu')
}

/** Radix menu/roving-focus handle keys on the focused node, then hop focus in a 0ms timeout. */
async function pressKey(key: string): Promise<HTMLElement> {
  const target = document.activeElement
  if (!(target instanceof HTMLElement)) {
    throw new Error('expected an HTMLElement to be focused for keyboard input')
  }
  fireEvent.keyDown(target, { key })
  return waitFor(() => {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) {
      throw new Error('expected focus to remain on an HTMLElement')
    }
    return focused
  })
}

describe('ContextMenu', () => {
  it('opens via contextmenu and exposes menu and item roles', async () => {
    renderMenu()
    expect(screen.queryByRole('menu')).toBeNull()

    const menu = await openMenu()
    expect(menu).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Translate' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Disabled action' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Loading action' })).toBeTruthy()
  })

  it('navigates highlighted items with ArrowDown and ArrowUp', async () => {
    renderMenu()
    await openMenu()
    const translate = screen.getByRole('menuitem', { name: 'Translate' })
    const copy = screen.getByRole('menuitem', { name: 'Copy' })

    await pressKey('ArrowDown')
    await waitFor(() => {
      expect(translate.getAttribute('data-highlighted')).not.toBeNull()
      expect(copy.getAttribute('data-highlighted')).toBeNull()
    })

    await pressKey('ArrowDown')
    await waitFor(() => {
      expect(copy.getAttribute('data-highlighted')).not.toBeNull()
      expect(translate.getAttribute('data-highlighted')).toBeNull()
    })

    await pressKey('ArrowUp')
    await waitFor(() => {
      expect(translate.getAttribute('data-highlighted')).not.toBeNull()
      expect(copy.getAttribute('data-highlighted')).toBeNull()
    })
  })

  it('selects the highlighted item with Enter and Space', async () => {
    const first = renderMenu()
    await openMenu()
    await pressKey('ArrowDown')
    await waitFor(() => {
      const item = screen.getByRole('menuitem', { name: 'Translate' })
      expect(item.getAttribute('data-highlighted')).not.toBeNull()
    })
    await pressKey('Enter')
    expect(first.onTranslate).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    cleanup()
    const second = renderMenu()
    await openMenu()
    await pressKey('ArrowDown')
    await waitFor(() => {
      const item = screen.getByRole('menuitem', { name: 'Translate' })
      expect(item.getAttribute('data-highlighted')).not.toBeNull()
    })
    await pressKey(' ')
    expect(second.onTranslate).toHaveBeenCalledTimes(1)
  })

  it('closes with Escape and restores the trigger focus target', async () => {
    renderMenu()
    const trigger = screen.getByText('Post body')
    const menu = await openMenu()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger.isConnected).toBe(true)
  })

  it('does not fire handlers for disabled or loading items', async () => {
    const { onDisabled, onLoading, onTranslate } = renderMenu()
    await openMenu()

    const disabledItem = screen.getByRole('menuitem', { name: 'Disabled action' })
    const loadingItem = screen.getByRole('menuitem', { name: 'Loading action' })

    expect(disabledItem.getAttribute('data-disabled')).not.toBeNull()
    expect(loadingItem.getAttribute('data-disabled')).not.toBeNull()
    expect(loadingItem.getAttribute('aria-busy')).toBe('true')

    fireEvent.click(disabledItem)
    fireEvent.keyDown(disabledItem, { key: 'Enter' })
    fireEvent.keyDown(disabledItem, { key: ' ' })
    fireEvent.click(loadingItem)
    fireEvent.keyDown(loadingItem, { key: 'Enter' })
    fireEvent.keyDown(loadingItem, { key: ' ' })

    expect(onDisabled).not.toHaveBeenCalled()
    expect(onLoading).not.toHaveBeenCalled()
    expect(onTranslate).not.toHaveBeenCalled()
  })
})
