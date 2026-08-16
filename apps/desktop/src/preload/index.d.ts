import type { RendererApi } from '@hubfetch/shared'

declare global {
  interface Window {
    hubfetch: RendererApi
  }
}

export {}
