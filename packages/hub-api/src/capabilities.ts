import type { HubClient } from './client'
import type {
  HUB_CAPABILITY_KEYS,
  HubCapabilityClass,
  HubCapabilityDegradation,
  HubCapabilityDomain
} from '@hubfetch/shared'

export {
  HUB_CAPABILITY_CLASSES,
  HUB_CAPABILITY_DEGRADATIONS,
  HUB_CAPABILITY_KEYS,
  type HubCapabilityClass,
  type HubCapabilityDegradation,
  type HubCapabilityDomain
} from '@hubfetch/shared'

export type HubCapabilityRecord = {
  readonly class: HubCapabilityClass
  readonly domain: HubCapabilityDomain
  readonly degradation: HubCapabilityDegradation
}

type MethodKeys<T> = {
  [Name in keyof T]-?: T[Name] extends (...args: infer _Arguments) => unknown ? Name : never
}[keyof T]

export type PublicHubClientMethod = MethodKeys<HubClient>

export const HUB_CAPABILITIES = {
  buildSearchUrl: { class: 'official-public', domain: 'transport', degradation: 'available' },
  searchRepos: { class: 'official-public', domain: 'models', degradation: 'network' },
  getRepoDetail: { class: 'official-public', domain: 'models', degradation: 'network' },
  resolveUrl: { class: 'official-public', domain: 'transport', degradation: 'available' },
  getReadme: { class: 'official-public', domain: 'models', degradation: 'upstream-changed' },
  getFileTree: { class: 'official-public', domain: 'models', degradation: 'network' },
  getDailyPapers: { class: 'official-public', domain: 'papers', degradation: 'network' },
  getPaper: { class: 'official-public', domain: 'papers', degradation: 'network' },
  getPaperComments: { class: 'official-public', domain: 'papers', degradation: 'network' },
  listDiscussions: { class: 'official-public', domain: 'discussions', degradation: 'network' },
  getDiscussionDiff: { class: 'official-public', domain: 'discussions', degradation: 'network' },
  getPosts: { class: 'official-public', domain: 'community', degradation: 'network' },
  getRecentActivity: { class: 'official-token', domain: 'account', degradation: 'unauthorized' },
  getDiscussion: { class: 'official-public', domain: 'discussions', degradation: 'network' },
  commentOnDiscussion: {
    class: 'official-token',
    domain: 'discussions',
    degradation: 'unauthorized'
  },
  createDiscussion: { class: 'official-token', domain: 'discussions', degradation: 'unauthorized' },
  whoAmI: { class: 'official-token', domain: 'account', degradation: 'unauthorized' },
  whoAmIWithToken: { class: 'official-token', domain: 'account', degradation: 'unauthorized' },
  whoAmIWithCookie: { class: 'cookie-web', domain: 'account', degradation: 'session-required' },
  getNotifications: {
    class: 'official-token',
    domain: 'notifications',
    degradation: 'unauthorized'
  },
  markNotificationsRead: {
    class: 'official-token',
    domain: 'notifications',
    degradation: 'unauthorized'
  },
  clearNotifications: {
    class: 'official-token',
    domain: 'notifications',
    degradation: 'unauthorized'
  },
  listByAuthor: { class: 'official-public', domain: 'models', degradation: 'network' },
  getFileText: { class: 'official-public', domain: 'models', degradation: 'upstream-changed' },
  fetchFileResponse: { class: 'official-public', domain: 'models', degradation: 'network' },
  fetchFileRange: { class: 'official-public', domain: 'datasets', degradation: 'upstream-changed' },
  getSafetensorsHeader: {
    class: 'official-public',
    domain: 'models',
    degradation: 'upstream-changed'
  },
  getRepoAccessGate: {
    class: 'ssr-scrape',
    domain: 'gated-access',
    degradation: 'upstream-changed'
  },
  askRepoAccess: { class: 'cookie-web', domain: 'gated-access', degradation: 'session-required' },
  getDatasetSampleRows: {
    class: 'ssr-scrape',
    domain: 'datasets',
    degradation: 'upstream-changed'
  },
  getDatasetSplits: { class: 'datasets-server', domain: 'datasets-server', degradation: 'network' },
  getDatasetRows: { class: 'datasets-server', domain: 'datasets-server', degradation: 'network' },
  getPostDetail: { class: 'official-public', domain: 'community', degradation: 'upstream-changed' },
  getUserOverview: {
    class: 'official-public',
    domain: 'profiles',
    degradation: 'upstream-changed'
  },
  getOrgMembers: { class: 'official-public', domain: 'profiles', degradation: 'network' },
  getUserFollowing: { class: 'official-public', domain: 'profiles', degradation: 'network' },
  searchUsers: { class: 'official-public', domain: 'profiles', degradation: 'upstream-changed' },
  searchOrgs: { class: 'official-public', domain: 'profiles', degradation: 'upstream-changed' },
  searchPapers: { class: 'official-public', domain: 'papers', degradation: 'upstream-changed' },
  searchCollections: {
    class: 'official-public',
    domain: 'collections',
    degradation: 'upstream-changed'
  },
  isInferenceAvailable: {
    class: 'official-public',
    domain: 'models',
    degradation: 'upstream-changed'
  },
  listCollections: { class: 'official-public', domain: 'collections', degradation: 'network' },
  getCollection: { class: 'official-public', domain: 'collections', degradation: 'network' },
  createCollection: { class: 'official-token', domain: 'collections', degradation: 'unauthorized' },
  updateCollection: { class: 'official-token', domain: 'collections', degradation: 'unauthorized' },
  deleteCollection: { class: 'official-token', domain: 'collections', degradation: 'unauthorized' },
  addCollectionItem: {
    class: 'official-token',
    domain: 'collections',
    degradation: 'unauthorized'
  },
  updateCollectionItem: {
    class: 'official-token',
    domain: 'collections',
    degradation: 'unauthorized'
  },
  removeCollectionItem: {
    class: 'official-token',
    domain: 'collections',
    degradation: 'unauthorized'
  },
  updateWatch: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  listWatched: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  setWatch: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  listMyRepos: { class: 'official-token', domain: 'repository-admin', degradation: 'unauthorized' },
  updateRepoSettings: {
    class: 'official-token',
    domain: 'repository-admin',
    degradation: 'unauthorized'
  },
  moveRepo: { class: 'official-token', domain: 'repository-admin', degradation: 'unauthorized' },
  deleteRepo: { class: 'official-token', domain: 'repository-admin', degradation: 'unauthorized' },
  duplicateSpace: {
    class: 'official-token',
    domain: 'repository-admin',
    degradation: 'unauthorized'
  },
  createBranch: {
    class: 'official-token',
    domain: 'repository-admin',
    degradation: 'unauthorized'
  },
  deleteBranch: {
    class: 'official-token',
    domain: 'repository-admin',
    degradation: 'unauthorized'
  },
  createTag: { class: 'official-token', domain: 'repository-admin', degradation: 'unauthorized' },
  deleteTag: { class: 'official-token', domain: 'repository-admin', degradation: 'unauthorized' },
  listAccessRequests: { class: 'official-token', domain: 'gated-access', degradation: 'forbidden' },
  handleAccessRequest: {
    class: 'official-token',
    domain: 'gated-access',
    degradation: 'forbidden'
  },
  grantAccess: { class: 'official-token', domain: 'gated-access', degradation: 'forbidden' },
  listSpaceSecrets: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  setSpaceSecret: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  deleteSpaceSecret: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  listSpaceVariables: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  setSpaceVariable: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  deleteSpaceVariable: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  getSpaceLogsSnapshot: { class: 'official-token', domain: 'spaces', degradation: 'network' },
  restartSpace: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  getSpaceRuntime: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  listSpaceHardware: { class: 'official-public', domain: 'spaces', degradation: 'network' },
  pauseSpace: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  requestSpaceHardware: {
    class: 'official-token',
    domain: 'spaces',
    degradation: 'unauthorized'
  },
  setSpaceSleepTime: { class: 'official-token', domain: 'spaces', degradation: 'unauthorized' },
  setLike: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  setFollow: { class: 'official-token', domain: 'community', degradation: 'unauthorized' },
  getUserLikes: { class: 'official-public', domain: 'community', degradation: 'network' },
  commentOnPost: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  setPostReaction: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  setPostCommentReaction: {
    class: 'cookie-web',
    domain: 'community',
    degradation: 'session-required'
  },
  hidePostComment: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  uploadCommentAsset: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  getProfileSettings: { class: 'ssr-scrape', domain: 'profiles', degradation: 'session-required' },
  updateProfileSettings: {
    class: 'ssr-scrape',
    domain: 'profiles',
    degradation: 'session-required'
  },
  getPostComments: { class: 'ssr-scrape', domain: 'community', degradation: 'upstream-changed' },
  canCreatePost: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  createPost: { class: 'cookie-web', domain: 'community', degradation: 'session-required' },
  setPaperUpvote: { class: 'cookie-web', domain: 'papers', degradation: 'session-required' },
  setCollectionUpvote: {
    class: 'cookie-web',
    domain: 'collections',
    degradation: 'session-required'
  },
  setDiscussionCommentReaction: {
    class: 'cookie-web',
    domain: 'discussions',
    degradation: 'session-required'
  },
  commentOnPaper: { class: 'cookie-web', domain: 'papers', degradation: 'session-required' },
  setPaperCommentReaction: {
    class: 'cookie-web',
    domain: 'papers',
    degradation: 'session-required'
  },
  mergePullRequest: { class: 'official-token', domain: 'discussions', degradation: 'unauthorized' },
  setDiscussionStatus: {
    class: 'official-token',
    domain: 'discussions',
    degradation: 'unauthorized'
  },
  setDiscussionTitle: {
    class: 'official-token',
    domain: 'discussions',
    degradation: 'unauthorized'
  },
  getBillingUsage: { class: 'official-token', domain: 'account', degradation: 'unauthorized' },
  invalidateCache: { class: 'official-public', domain: 'transport', degradation: 'available' }
} satisfies Record<PublicHubClientMethod, HubCapabilityRecord>

type MissingCapabilityEntries = Exclude<PublicHubClientMethod, keyof typeof HUB_CAPABILITIES>
type ExtraCapabilityEntries = Exclude<keyof typeof HUB_CAPABILITIES, PublicHubClientMethod>
type RegistryExhaustive = [MissingCapabilityEntries] extends [never]
  ? [ExtraCapabilityEntries] extends [never]
    ? true
    : never
  : never

export const HUB_CAPABILITY_REGISTRY_IS_EXHAUSTIVE: RegistryExhaustive = true

type MissingSharedCapabilityKeys = Exclude<PublicHubClientMethod, (typeof HUB_CAPABILITY_KEYS)[number]>
type StaleSharedCapabilityKeys = Exclude<(typeof HUB_CAPABILITY_KEYS)[number], PublicHubClientMethod>
type SharedCapabilityKeysExhaustive = [MissingSharedCapabilityKeys] extends [never]
  ? [StaleSharedCapabilityKeys] extends [never]
    ? true
    : never
  : never

export const HUB_SHARED_CAPABILITY_KEYS_ARE_EXHAUSTIVE: SharedCapabilityKeysExhaustive = true
