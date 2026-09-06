import type {
  AuthState,
  HubCapabilityKey,
  HubCapabilityStatus,
  SearchQuery
} from '@hubfetch/shared'
import { HUB_CAPABILITY_KEYS } from '@hubfetch/shared'
import {
  HUB_CAPABILITIES,
  HubCapabilityError,
  toHubCapabilityError,
  type HubClient
} from '@hubfetch/hub-api'

type ProbeClient = Pick<
  HubClient,
  | 'searchRepos'
  | 'getPosts'
  | 'getPostComments'
  | 'listWatched'
  | 'getProfileSettings'
  | 'getDatasetSplits'
  | 'getDatasetRows'
  | 'getDatasetSampleRows'
  | 'whoAmI'
>

export interface CompatibilityServiceOptions {
  readonly getClient: () => ProbeClient
  readonly getAuthState: () => AuthState
  readonly now?: () => string
}

const MODEL_PROBE: SearchQuery = { kind: 'model', sort: 'trending', limit: 1 }
const PROBE_DATASET = 'stanfordnlp/imdb'

const IPC_CAPABILITY_ALIASES: Readonly<Record<string, HubCapabilityKey>> = {
  search: 'searchRepos',
  papers: 'getDailyPapers',
  repoDetail: 'getRepoDetail',
  readme: 'getReadme',
  fileTree: 'getFileTree',
  discussions: 'listDiscussions',
  discussionDiff: 'getDiscussionDiff',
  posts: 'getPosts',
  recentActivity: 'getRecentActivity',
  notifications: 'getNotifications',
  notificationsMarkRead: 'markNotificationsRead',
  notificationsClear: 'clearNotifications',
  watchUpdate: 'updateWatch',
  watchList: 'listWatched',
  watchSet: 'setWatch',
  collections: 'listCollections',
  collection: 'getCollection',
  likeSet: 'setLike',
  followSet: 'setFollow',
  spaceRuntime: 'getSpaceRuntime',
  spaceHardwareList: 'listSpaceHardware',
  spacePause: 'pauseSpace',
  spaceHardwareSet: 'requestSpaceHardware',
  spaceSleepTimeSet: 'setSpaceSleepTime',
  postCanCreate: 'canCreatePost',
  profileGet: 'getProfileSettings',
  profileUpdate: 'updateProfileSettings'
}

/**
 * Local capability knowledge plus explicit, user-triggered compatibility probes.
 * `read()` never touches the network; `probe()` calls only the active client.
 */
export class CompatibilityService {
  private readonly getClient: () => ProbeClient
  private readonly getAuthState: () => AuthState
  private readonly now: () => string

  constructor(options: CompatibilityServiceOptions) {
    this.getClient = options.getClient
    this.getAuthState = options.getAuthState
    this.now = options.now ?? (() => new Date().toISOString())
  }

  read(): HubCapabilityStatus[] {
    const checkedAt = this.now()
    return HUB_CAPABILITY_KEYS.map((key) => this.staticStatus(key, checkedAt))
  }

  async probe(key: HubCapabilityKey): Promise<HubCapabilityStatus> {
    const checkedAt = this.now()
    const base = this.staticStatus(key, checkedAt)
    if (base.status !== 'available' && this.requiresCredentialForProbe(key)) return base

    try {
      await this.runProbe(key)
      return { ...base, status: 'available', lastCheckedAt: this.now() }
    } catch (error) {
      const mapped =
        error instanceof HubCapabilityError
          ? error
          : toHubCapabilityError(key, HUB_CAPABILITIES[key].class, error)
      return { ...base, status: mapped.code, lastCheckedAt: this.now() }
    }
  }

  private staticStatus(key: HubCapabilityKey, checkedAt: string): HubCapabilityStatus {
    const record = HUB_CAPABILITIES[key]
    const state = this.getAuthState()
    let status: HubCapabilityStatus['status'] = 'available'
    if (record.class === 'cookie-web' || record.class === 'ssr-scrape') {
      status = state.status === 'signedIn' && state.hubSession ? 'available' : 'session-required'
    } else if (record.class === 'official-token' && state.status !== 'signedIn') {
      status = 'unauthorized'
    }
    return {
      key,
      sourceClass: record.class,
      domain: record.domain,
      status,
      lastCheckedAt: checkedAt
    }
  }

  private requiresCredentialForProbe(key: HubCapabilityKey): boolean {
    const sourceClass = HUB_CAPABILITIES[key].class
    return sourceClass === 'cookie-web' || sourceClass === 'ssr-scrape' || sourceClass === 'official-token'
  }

  private async runProbe(key: HubCapabilityKey): Promise<void> {
    const client = this.getClient()
    switch (key) {
      case 'searchRepos':
        await client.searchRepos(MODEL_PROBE)
        return
      case 'getPosts':
        await client.getPosts()
        return
      case 'getPostComments':
        await client.getPostComments('huggingface', 'compatibility-probe')
        return
      case 'listWatched':
      case 'updateWatch':
        await client.listWatched()
        return
      case 'getProfileSettings':
      case 'updateProfileSettings':
        await client.getProfileSettings()
        return
      case 'getDatasetSplits':
      case 'getDatasetSampleRows':
        await client.getDatasetSplits(PROBE_DATASET)
        return
      case 'getDatasetRows':
        await client.getDatasetRows(PROBE_DATASET, 'default', 'train', 0, 1)
        return
      case 'whoAmI':
      case 'whoAmIWithToken':
        await client.whoAmI()
        return
      case 'buildSearchUrl':
      case 'resolveUrl':
      case 'invalidateCache':
        return
      default:
        await this.runBySourceClass(key, client)
    }
  }

  private async runBySourceClass(key: HubCapabilityKey, client: ProbeClient): Promise<void> {
    const sourceClass = HUB_CAPABILITIES[key].class
    switch (sourceClass) {
      case 'official-public':
        await client.searchRepos(MODEL_PROBE)
        return
      case 'official-token':
        await client.whoAmI()
        return
      case 'cookie-web':
        await client.listWatched()
        return
      case 'ssr-scrape':
        await client.getProfileSettings()
        return
      case 'datasets-server':
        await client.getDatasetSplits(PROBE_DATASET)
        return
      default:
        return assertNever(sourceClass)
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Hub capability source class: ${String(value)}`)
}

/** Map a typed Hub IPC channel to its registry key for error context. */
export function capabilityForIpcChannel(channel: string): HubCapabilityKey | undefined {
  if (!channel.startsWith('hub:')) return undefined
  const tail = channel.slice('hub:'.length)
  const candidate = IPC_CAPABILITY_ALIASES[tail] ?? tail
  return HUB_CAPABILITY_KEYS.find((key) => key === candidate)
}
