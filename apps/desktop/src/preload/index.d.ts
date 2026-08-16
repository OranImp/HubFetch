import type { RendererApi } from '@hubfetch/shared'

declare global {
  interface Window {
    omh: RendererApi
  }
}

export {}
