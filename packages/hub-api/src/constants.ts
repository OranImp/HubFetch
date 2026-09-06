import type { RepoKind } from '@hubfetch/shared'
import { DEFAULT_HUB_ENDPOINT } from '@hubfetch/shared'

export const DEFAULT_ENDPOINT = DEFAULT_HUB_ENDPOINT

export const DATASETS_SERVER = 'https://datasets-server.huggingface.co'

export const API_PATH: Record<RepoKind, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces'
}

export const RESOLVE_PREFIX: Record<RepoKind, string> = {
  model: '',
  dataset: 'datasets/',
  space: 'spaces/'
}
