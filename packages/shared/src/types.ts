/** Domain types shared between the main process, preload, and renderer. */

export const SUPPORTED_LOCALES = [
  'en',
  'zh-CN',
  'zh-TW',
  'ja',
  'ko',
  'de',
  'es',
  'fr',
  'pt-BR'
] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export type RepoKind = 'model' | 'dataset' | 'space'

/** Closed source classes used by the Hub capability registry. */
export const HUB_CAPABILITY_CLASSES = [
  'official-token',
  'official-public',
  'cookie-web',
  'ssr-scrape',
  'datasets-server'
] as const
export type HubCapabilitySourceClass = (typeof HUB_CAPABILITY_CLASSES)[number]
/** Compatibility alias used by the Hub API package's Todo 3 registry. */
export type HubCapabilityClass = HubCapabilitySourceClass

/** Closed capability outcomes. `available` is the only non-error outcome. */
export const HUB_CAPABILITY_DEGRADATIONS = [
  'available',
  'session-required',
  'unauthorized',
  'forbidden',
  'rate-limited',
  'upstream-changed',
  'network'
] as const
export type HubCapabilityDegradation = (typeof HUB_CAPABILITY_DEGRADATIONS)[number]
export const HUB_CAPABILITY_ERROR_CODES = [
  'session-required',
  'unauthorized',
  'forbidden',
  'rate-limited',
  'upstream-changed',
  'network'
] as const
export type HubCapabilityErrorCode = (typeof HUB_CAPABILITY_ERROR_CODES)[number]

export const HUB_CAPABILITY_DOMAINS = [
  'account',
  'collections',
  'community',
  'datasets',
  'datasets-server',
  'discussions',
  'gated-access',
  'models',
  'notifications',
  'papers',
  'profiles',
  'repository-admin',
  'spaces',
  'transport'
] as const
export type HubCapabilityDomain = (typeof HUB_CAPABILITY_DOMAINS)[number]

/**
 * Public HubClient method keys from Todo 3. Keeping the closed list in shared
 * lets IPC schemas reject unknown capability probes without importing Electron
 * or creating a package cycle back into hub-api.
 */
export const HUB_CAPABILITY_KEYS = [
  'buildSearchUrl',
  'searchRepos',
  'getRepoDetail',
  'resolveUrl',
  'getReadme',
  'getFileTree',
  'getDailyPapers',
  'getPaper',
  'getPaperComments',
  'listDiscussions',
  'getDiscussionDiff',
  'getPosts',
  'getRecentActivity',
  'getDiscussion',
  'commentOnDiscussion',
  'createDiscussion',
  'whoAmI',
  'whoAmIWithToken',
  'whoAmIWithCookie',
  'getNotifications',
  'markNotificationsRead',
  'clearNotifications',
  'listByAuthor',
  'getFileText',
  'fetchFileResponse',
  'fetchFileRange',
  'getSafetensorsHeader',
  'getRepoAccessGate',
  'askRepoAccess',
  'getDatasetSampleRows',
  'getDatasetSplits',
  'getDatasetRows',
  'getPostDetail',
  'getUserOverview',
  'getOrgMembers',
  'getUserFollowing',
  'searchUsers',
  'searchOrgs',
  'searchPapers',
  'searchCollections',
  'isInferenceAvailable',
  'listCollections',
  'getCollection',
  'createCollection',
  'updateCollection',
  'deleteCollection',
  'addCollectionItem',
  'updateCollectionItem',
  'removeCollectionItem',
  'updateWatch',
  'listWatched',
  'setWatch',
  'listMyRepos',
  'updateRepoSettings',
  'moveRepo',
  'deleteRepo',
  'duplicateSpace',
  'createBranch',
  'deleteBranch',
  'createTag',
  'deleteTag',
  'listAccessRequests',
  'handleAccessRequest',
  'grantAccess',
  'listSpaceSecrets',
  'setSpaceSecret',
  'deleteSpaceSecret',
  'listSpaceVariables',
  'setSpaceVariable',
  'deleteSpaceVariable',
  'getSpaceLogsSnapshot',
  'getSpaceRuntime',
  'listSpaceHardware',
  'restartSpace',
  'pauseSpace',
  'requestSpaceHardware',
  'setSpaceSleepTime',
  'setLike',
  'setFollow',
  'getUserLikes',
  'commentOnPost',
  'setPostReaction',
  'setPostCommentReaction',
  'hidePostComment',
  'uploadCommentAsset',
  'getProfileSettings',
  'updateProfileSettings',
  'getPostComments',
  'canCreatePost',
  'createPost',
  'setPaperUpvote',
  'setCollectionUpvote',
  'setDiscussionCommentReaction',
  'commentOnPaper',
  'setPaperCommentReaction',
  'mergePullRequest',
  'setDiscussionStatus',
  'setDiscussionTitle',
  'getBillingUsage',
  'invalidateCache'
] as const
export type HubCapabilityKey = (typeof HUB_CAPABILITY_KEYS)[number]

/** Secret-free capability state exposed to diagnostics and renderer recovery UI. */
export interface HubCapabilityStatus {
  readonly key: HubCapabilityKey
  readonly sourceClass: HubCapabilitySourceClass
  readonly domain: HubCapabilityDomain
  readonly status: HubCapabilityDegradation
  readonly lastCheckedAt: string
}

export const HUB_CAPABILITY_ERROR_MARKER = 'HUB_CAPABILITY_ERROR'

/** Native menu and renderer shortcut help consume this same navigation map. */
export const NAVIGATION_SHORTCUTS = [
  { key: '1', route: '/models', menuKey: 'menu.models', labelKey: 'models' },
  { key: '2', route: '/datasets', menuKey: 'menu.datasets', labelKey: 'datasets' },
  { key: '3', route: '/spaces', menuKey: 'menu.spaces', labelKey: 'spaces' },
  { key: '4', route: '/papers', menuKey: 'menu.papers', labelKey: 'papers' },
  { key: '5', route: '/favorites', menuKey: 'menu.favorites', labelKey: 'favorites' },
  { key: '6', route: '/downloads', menuKey: 'menu.downloads', labelKey: 'downloads' },
  { key: '7', route: '/cache', menuKey: 'menu.cache', labelKey: 'cache' },
  { key: '8', route: '/inbox', menuKey: 'menu.inbox', labelKey: 'inbox' },
  { key: '9', route: '/history', menuKey: 'menu.history', labelKey: 'history' }
] as const

export interface RepoSummary {
  id: string
  kind: RepoKind
  author: string
  name: string
  likes: number
  downloads: number
  /** ISO timestamp of last modification, when the API provides it. */
  updatedAt?: string
  createdAt?: string
  private: boolean
  gated: string | boolean
  tags: string[]
  /** Models only: task, e.g. "text-generation". */
  pipelineTag?: string
  /** Models only: e.g. "transformers". */
  libraryName?: string
  license?: string
  /** Total parameter count when the API exposes safetensors metadata. */
  paramCount?: number
  /** Spaces only: sdk, e.g. "gradio". */
  sdk?: string
  trendingScore?: number
  /** Spaces only: card emoji + gradient + runtime stage for gallery rendering. */
  emoji?: string
  colorFrom?: string
  colorTo?: string
  shortDescription?: string
  runtimeStage?: string
  /** Spaces only: current hardware id, e.g. "cpu-basic", "zero-a10g". */
  hardware?: string
}

export interface RepoDetail extends RepoSummary {
  sha?: string
  /** Spaces only: the *.hf.space host serving the app (for in-app embedding). */
  spaceDomain?: string
  lastModified?: string
  cardData?: Record<string, unknown>
  siblings?: Array<{ rfilename: string; size?: number }>
  spaces?: string[]
  usedStorage?: number
  downloadsAllTime?: number
}

export interface FileTreeEntry {
  type: 'file' | 'directory'
  path: string
  size: number
  oid?: string
  lfs?: { oid: string; size: number }
}

export interface PaperSummary {
  id: string
  title: string
  summary: string
  publishedAt?: string
  upvotes: number
  authors: string[]
  thumbnail?: string
  numComments?: number
}

export type RepoSort = 'trending' | 'downloads' | 'likes' | 'updated' | 'created'

export interface SearchQuery {
  kind: RepoKind
  search?: string
  author?: string
  /** Raw tag filters, e.g. "license:mit", "gguf". */
  tags?: string[]
  pipelineTag?: string
  library?: string
  license?: string
  sort: RepoSort
  /** Filter to models served by a specific inference provider (models only). */
  inferenceProvider?: string
  limit?: number
  /** Opaque pagination cursor (full URL of the next page). */
  cursor?: string
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

/**
 * Paid org plan from Hub overview / whoami (`plan` field).
 * `plus` is Enterprise Plus; `academia` is the academic org tier.
 */
export type HubOrgPlan = 'team' | 'enterprise' | 'plus' | 'academia'

export interface OrgSummary {
  name: string
  fullname?: string
  avatarUrl?: string
  /** Present when the Hub payload includes a paid org plan. */
  plan?: HubOrgPlan
}

export interface UserProfile {
  name: string
  fullname?: string
  email?: string
  avatarUrl?: string
  isPro?: boolean
  orgs: OrgSummary[]
}

/** Renderer-safe account inventory entry. Credential bytes never cross IPC. */
export interface AccountSummary {
  readonly id: string
  readonly endpoint: string
  readonly user: UserProfile
  readonly tokenDisplayName?: string
  readonly tokenRole?: string
  readonly hubSession: boolean
  readonly active: boolean
  /** Present only after a definitive 401; the profile needs reauthentication. */
  readonly invalid?: true
}

/** Account-bound work counts used to explain why profile removal is blocked. */
export interface AccountUsageCounts {
  readonly downloads: number
  readonly clones: number
  readonly uploads: number
  readonly total: number
}

export type AccountActionFailure =
  | { readonly ok: false; readonly error: 'not-found'; readonly accountId: string }
  | {
      readonly ok: false
      readonly error: 'account-in-use'
      readonly accountId: string
      readonly counts: AccountUsageCounts
    }

export type AuthState =
  | { status: 'signedOut' }
  /** The encrypted credential source was quarantined; only its backup basename crosses IPC. */
  | { status: 'credential-corrupt'; backupFile: string }
  /**
   * Access-token session. `scopes` is unused (token permissions are decided by
   * the Hub token itself; the UI lets attempts through and the API is the
   * referee). `method` is always `'token'`.
   */
  | {
      status: 'signedIn'
      accountId: string
      user: UserProfile
      scopes?: string[]
      method?: 'oauth' | 'token'
      /** User-chosen token name from whoami-v2, when the Hub reports it. */
      tokenDisplayName?: string
      /** 'read' | 'write' | 'fineGrained' when the Hub reports it. */
      tokenRole?: string
      /**
       * True when a supplemental Hub web-session cookie is connected. The
       * cookie itself never crosses IPC — this flag is all the renderer sees.
       * It unlocks the social writes the Hub blocks for Bearer tokens (like,
       * post reactions/comments, watch, discussion reactions).
       */
      hubSession?: boolean
    }

/** Result of a manual-token sign-in attempt; failures never throw across IPC. */
export type TokenSignInResult =
  { ok: true; state: AuthState } | { ok: false; error: 'invalid' | 'forbidden' | 'network' }

export type AccountSwitchResult =
  | { readonly ok: true; readonly state: AuthState }
  | {
      readonly ok: false
      readonly error: 'not-found' | 'invalid' | 'forbidden' | 'network'
      readonly accountId?: string
    }
  | {
      readonly ok: false
      readonly error: 'endpoint-mismatch'
      readonly accountId: string
      readonly settings: 'network'
    }

export type AccountRemoveResult =
  | { readonly ok: true; readonly accounts: AccountSummary[]; readonly state: AuthState }
  | AccountActionFailure

/** Successful sign-out retains its historic AuthState response shape. */
export type SignOutResult = AuthState | AccountActionFailure

/**
 * Result of connecting a Hub web session (cookie) via the login window.
 * `mismatch` = the browser login belongs to a different account than the
 * token session; `canceled` = the user closed the login window.
 */
export type HubSessionConnectResult =
  | { ok: true; state: AuthState }
  | { ok: false; error: 'canceled' | 'timeout' | 'mismatch' | 'invalid' | 'forbidden' | 'network' }

/**
 * Sentinel embedded in CookieRequiredError messages. Electron flattens errors
 * thrown across IPC to their message string, so the renderer matches on this
 * (see renderer lib/errors.ts).
 */
export const HUB_SESSION_REQUIRED_CODE = 'HUB_WEB_SESSION_REQUIRED'

export interface HubNotification {
  /** discussion id used by mark-as-read, when the notification is discussion-backed */
  discussionId?: string
  kind: 'repo' | 'paper' | 'post' | 'org' | 'other'
  read: boolean
  updatedAt?: string
  title: string
  /** in-app route, e.g. /models/{id}/discussions/{num} or /posts/{author}/{slug} */
  route?: string
  repoId?: string
  repoKind?: RepoKind
  discussionNum?: number
  discussionStatus?: 'draft' | 'open' | 'closed' | 'merged'
  isPullRequest?: boolean
  participants?: { user: string; avatar?: string }[]
}

export interface NotificationsPage {
  count: number
  items: HubNotification[]
}

export type DownloadStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'canceled'

export interface DownloadFileState {
  path: string
  size: number
  receivedBytes: number
  status: DownloadStatus
  /** sha256 expected for LFS files (from the HF etag). */
  sha256?: string
  verified?: boolean
  error?: string
}

export interface DownloadTask {
  id: string
  repoId: string
  kind: RepoKind
  /** Immutable account identity used for authenticated work; absent for public downloads. */
  accountId?: string
  /** Safe display label captured with the account identity; never a credential. */
  accountLabel?: string
  /** User-requested branch, tag, or commit. */
  revision: string
  /** Immutable 40-hex commit resolved before the task was queued. */
  resolvedCommit?: string
  errorCode?:
    | 'legacy-task'
    | 'environment-mismatch'
    | 'commit-mismatch'
    | 'network'
    | 'integrity'
    | 'account-unavailable'
  /** False when continuing the task could mix endpoint/cache environments. */
  resumable: boolean
  status: DownloadStatus
  totalBytes: number
  receivedBytes: number
  /** Rolling average, bytes per second. */
  speedBps: number
  files: DownloadFileState[]
  error?: string
  createdAt: string
  completedAt?: string
  /**
   * Frozen proxy selection captured at creation and never rewritten, even when
   * Settings change or the task is paused/resumed/retried.
   */
  proxy: ProxySnapshot
}

export interface DownloadRequest {
  repoId: string
  kind: RepoKind
  revision?: string
  /** File paths to fetch; omit to download the whole snapshot. */
  files?: string[]
  /**
   * Optional per-create proxy selection. When omitted the settings ProxyConfig
   * decides; when present it overrides for THIS task only.
   */
  proxy?: DownloadProxyOverride
}

/**
 * One file row in a download plan. All fields are resolved and immutable for
 * the plan's lifetime. The plan owner (main process) computes these from the
 * Hub file tree, cache scan, and live task inventory.
 */
export interface DownloadPlanFileRow {
  readonly path: string
  readonly size: number
  /** sha256 expected for LFS files (from the HF etag). */
  readonly sha256?: string
  /** True when the blob is already fully cached on disk. */
  readonly alreadyCached: boolean
  /** True when a queued or running task already covers this file. */
  readonly coveredByLiveTask: boolean
}

/**
 * Immutable download plan returned by `downloads:plan`. The plan is owned by
 * the main process and expires after 15 minutes. It captures every resolved
 * detail so the renderer can preview before committing.
 */
export interface DownloadPlan {
  readonly planId: string
  readonly repoId: string
  readonly kind: RepoKind
  /** User-requested branch, tag, or commit. */
  readonly revision: string
  /** Immutable 40-hex commit resolved at plan creation. */
  readonly resolvedCommit: string
  /** Frozen endpoint at plan creation. */
  readonly endpoint: string
  /** Frozen proxy snapshot at plan creation. */
  readonly proxy: ProxySnapshot
  /** Account identity if authenticated at plan creation. */
  readonly accountId?: string
  readonly accountLabel?: string
  /** All safe file rows from the resolved commit tree. */
  readonly files: readonly DownloadPlanFileRow[]
  /** Total bytes of all files in the plan (before selection). */
  readonly totalBytes: number
  /** Total file count in the plan (before selection). */
  readonly totalFiles: number
  /** ISO timestamp when the plan expires. */
  readonly expiresAt: string
  /**
   * Deterministic digest of the plan content (SHA-256 hex of canonical JSON).
   * Used by startPlanned to detect tampering.
   */
  readonly digest: string
}

/**
 * Request payload for `downloads:plan`. Same shape as DownloadRequest but
 * returns a preview instead of starting a download.
 */
export interface DownloadPlanRequest {
  repoId: string
  kind: RepoKind
  revision?: string
  /** File paths to scope the plan; omit to plan the whole snapshot. */
  files?: string[]
  /** Optional per-plan proxy override. */
  proxy?: DownloadProxyOverride
}

/**
 * Request payload for `downloads:startPlanned`. Only the plan ID and a subset
 * of paths already present in the plan are accepted.
 */
export interface DownloadPlanStartRequest {
  planId: string
  /** Subset of file paths from the plan to actually download. */
  paths: string[]
}

export interface CachedRevision {
  commitHash: string
  sizeOnDisk: number
  fileCount: number
  refs: string[]
  lastModified?: string
}

export interface CachedRepo {
  id: string
  kind: RepoKind
  sizeOnDisk: number
  revisions: CachedRevision[]
  lastModified?: string
  /** Bytes of leftover `*.incomplete*` download partials in blobs/ (absent/0 when none). */
  partialSize?: number
  /** Number of leftover partial files in blobs/. */
  partialCount?: number
}

export interface CacheReport {
  root: string
  totalSize: number
  repos: CachedRepo[]
  scannedAt: string
  /** Total bytes of leftover download partials across all repos. */
  partialSize?: number
}

/**
 * Closed union of cache integrity issues detected during offline verification.
 * Every variant is a read-only observation — the verifier never mutates state.
 */
export type CacheVerificationIssue =
  | 'invalid-blob-name'
  | 'hash-mismatch'
  | 'broken-snapshot-link'
  | 'snapshot-escape'
  | 'missing-blob'
  | 'unmatched-snapshot-copy'
  | 'unreadable'

export interface CacheVerificationEntry {
  issue: CacheVerificationIssue
  /** Relative display path from the cache root (always uses forward slashes). */
  path: string
  detail?: string
}

export interface CacheVerificationRepo {
  /** Logical repo id, e.g. "org/name". */
  id: string
  kind: RepoKind
  /** True when every blob and snapshot entry passed verification with zero issues. */
  ok: boolean
  /** Number of blobs whose content hash matched their filename. */
  verifiedBlobs: number
  /** Total bytes of verified blob content. */
  verifiedBytes: number
  /** Integrity issues found in this repo. */
  issues: CacheVerificationEntry[]
  /** Number of `.incomplete*` partial files skipped (not hashed). */
  partialFiles: number
  /** Total bytes of partial files. */
  partialBytes: number
}

export interface CacheVerificationReport {
  root: string
  /** True when every repo passed with zero issues. */
  ok: boolean
  repos: CacheVerificationRepo[]
  totalVerifiedBlobs: number
  totalVerifiedBytes: number
  totalIssues: number
  totalPartialFiles: number
  totalPartialBytes: number
  /** True when the issue limit was reached and the report was truncated. */
  truncated: boolean
  scannedAt: string
}

export interface CacheVerificationProgress {
  phase: 'scanning' | 'verifying' | 'done'
  currentRepo?: string
  completedRepos: number
  totalRepos: number
  verifiedBlobs: number
  issuesFound: number
}

// ---------------------------------------------------------------------------
// Cache action plans (plan Todo 15)
//
// A plan is created and stored by the MAIN process. The renderer-visible
// payload is sanitized: only logical repo identity and relative display paths
// ever cross IPC — absolute paths and expected content hashes live in a
// main-memory registry keyed by the unguessable plan ID and are never sent to
// the renderer.
// ---------------------------------------------------------------------------

/** Closed union of main-owned cache maintenance actions. */
export type CacheActionKind = 'prune' | 'repair'

/** One prune candidate: a detached snapshot, an orphan blob, or a stale partial. */
export interface CachePruneEntry {
  kind: 'detached-snapshot' | 'orphan-blob' | 'stale-partial'
  /** Relative display path from the cache root (always forward slashes). */
  path: string
  /** 40-hex commit (detached snapshot) or blob/partial file name. */
  name: string
  /** Estimated reclaimable bytes. */
  estimatedBytes: number
}

/**
 * One sanitized repair target. `path` is relative to the cache root and
 * `repoPath` is relative to the snapshot directory; the absolute blob path and
 * the expected content hash stay in the main-memory registry.
 */
export interface CacheRepairEntry {
  /** Todo 14 verification issue that mapped to this entry. */
  issue: CacheVerificationIssue
  /** Relative display path from the cache root (always forward slashes). */
  path: string
  /** Repo-relative file path inside the snapshot (forward slashes). */
  repoPath: string
  /** Estimated download bytes (size of the corrupt entry at plan time). */
  estimatedBytes: number
}

interface CacheActionPlanBase {
  /** Unguessable random UUID v4 minted in main. */
  planId: string
  kind: RepoKind
  /** Logical repo id, e.g. "org/name". Never a path. */
  repoId: string
  /** ISO timestamp of the source scan/verification the plan was built from. */
  scannedAt: string
  createdAt: string
  /** ISO timestamp; a plan is rejected once expired (15-minute TTL). */
  expiresAt: string
  /**
   * Account identity needed for the network refetch; absent for offline prune
   * and anonymous repair. Only the id crosses IPC — never a credential.
   */
  accountId?: string
  /** Safe display label captured with the account identity. */
  accountLabel?: string
  /** Commits protected by live/resumable downloads at plan time (exclusion proof). */
  protectedCommits: readonly string[]
  /** Task ids whose partials/commits are protected at plan time (exclusion proof). */
  protectedTaskIds: readonly string[]
  /**
   * Deterministic SHA-256 hex of the plan content (canonical JSON). Computed
   * in main over the full plan INCLUDING the registry-only absolute paths and
   * expected hashes; re-verified before the first mutation on apply.
   */
  digest: string
}

/** Offline cleanup: detached snapshots, orphaned blobs, and stale partials. */
export interface CachePrunePlan extends CacheActionPlanBase {
  action: 'prune'
  entries: readonly CachePruneEntry[]
  /** Total estimated reclaimable bytes. */
  estimatedBytes: number
}

/**
 * Network repair of mapped Todo 14 issues. Every entry belongs to ONE
 * resolved commit; the refetch uses the frozen endpoint/proxy captured here.
 */
export interface CacheRepairPlan extends CacheActionPlanBase {
  action: 'repair'
  /** Immutable 40-hex commit every entry is mapped to. */
  resolvedCommit: string
  /** Frozen endpoint at plan creation (stale rejection on change). */
  endpoint: string
  /** Frozen proxy snapshot at plan creation (stale rejection on change). */
  proxy: ProxySnapshot
  entries: readonly CacheRepairEntry[]
  /** Total estimated download bytes. */
  estimatedBytes: number
}

/** Closed prune | repair union of expiring main-owned cache plans. */
export type CacheActionPlan = CachePrunePlan | CacheRepairPlan

/** Issue identity: "<issue>:<relative display path>" from the verification report. */
export function cacheIssueIdOf(issue: CacheVerificationIssue, path: string): string {
  return `${issue}:${path}`
}

export interface CacheActionPlanRequest {
  action: CacheActionKind
  kind: RepoKind
  repoId: string
  /**
   * Repair only: issue identities selected from the latest verification
   * report; every id must match an issue main re-detects itself. Omit to plan
   * every mappable issue. Ignored by prune.
   */
  issueIds?: readonly string[]
  /** Prune only: user-selected 40-hex revisions to retain (never pruned). */
  retainCommits?: readonly string[]
}

/** Closed failure reasons for one-shot plan application. */
export const CACHE_APPLY_FAILURE_REASONS = [
  'plan-not-found',
  'plan-expired',
  'plan-digest-mismatch',
  'plan-stale-filesystem',
  'plan-stale-protected',
  'plan-stale-account',
  'plan-stale-environment',
  'unsupported-issue',
  'network',
  'integrity',
  'account-unavailable',
  'internal'
] as const
export type CacheApplyFailureReason = (typeof CACHE_APPLY_FAILURE_REASONS)[number]

/**
 * Result of applying one cache action plan. Failures NEVER mutate: `bytes`
 * and `changed` stay 0 and the original cache bytes remain intact.
 */
export interface CacheActionResult {
  ok: boolean
  action: CacheActionKind
  planId: string
  /** Reclaimed bytes (prune) or re-downloaded bytes (repair); 0 on failure. */
  bytes: number
  /** Entries removed (prune) or atomically replaced (repair); 0 on failure. */
  changed: number
  failure?: { reason: CacheApplyFailureReason; message: string }
}

/** A fully-resolved git commit SHA — the only revisions cached with no ref file. */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

/**
 * Revisions safe to offer in a one-click "clean stale" action: ref-less
 * revisions in a repo that still has at least one ref'd revision. Repos whose
 * revisions are ALL detached (e.g. SHA-pinned downloads) yield [] — deleting
 * those must stay an explicit per-revision action. `pinnedCommits` (commits
 * this app downloaded deliberately by SHA) are never considered stale.
 */
export function staleRevisionsOf(
  repo: CachedRepo,
  pinnedCommits?: ReadonlySet<string>
): CachedRevision[] {
  if (!repo.revisions.some((r) => r.refs.length > 0)) return []
  return repo.revisions.filter((r) => r.refs.length === 0 && !pinnedCommits?.has(r.commitHash))
}

/**
 * Per-worker slice of the aggregate download speed limit; null = unlimited.
 * Floors at 1 B/s so a tiny limit still throttles instead of dividing to 0.
 */
export function computeSpeedShare(
  limitBps: number | null | undefined,
  workerCount: number
): number | null {
  if (!limitBps || limitBps <= 0) return null
  return Math.max(1, Math.floor(limitBps / Math.max(1, workerCount)))
}

export interface FavoriteItem {
  repoId: string
  kind: RepoKind
  addedAt: string
  summary: RepoSummary
}

export interface HistoryItem {
  repoId: string
  kind: RepoKind
  viewedAt: string
  summary: RepoSummary
}

export type FollowTargetType = 'user' | 'org' | 'repo' | 'papers'

export interface Follow {
  id: string
  type: FollowTargetType
  /** username, org name, or "kind:repoId"; empty for 'papers'. */
  target: string
  createdAt: string
  lastCheckedAt?: string
  accountId?: string
  legacyOrigin?: 'legacy-local' | 'v1-migrated'
}

export type InboxItemKind = 'repo-update' | 'new-repo' | 'paper'

export interface InboxItem {
  id: string
  kind: InboxItemKind
  title: string
  body: string
  /** In-app route to open when clicked, e.g. "/models/meta-llama/Llama-3-8B". */
  route: string
  createdAt: string
  readAt?: string
  accountId?: string
  legacyOrigin?: 'legacy-local' | 'v1-migrated'
}

export interface DiscussionSummary {
  num: number
  title: string
  status: 'open' | 'closed' | 'merged' | 'draft'
  isPullRequest: boolean
  author?: string
  createdAt?: string
  numComments?: number
}

export interface DiscussionEvent {
  id: string
  type: string
  author?: string
  createdAt?: string
  /** Markdown content for comments. */
  content?: string
  /** status-change events: the new status. */
  status?: string
  /** commit events. */
  oid?: string
  subject?: string
  /** Per-emoji reactions on comment events (empty/absent otherwise). */
  reactions?: PostReaction[]
  /** title-change events: previous and new title. */
  titleFrom?: string
  titleTo?: string
  /** pinning-change events: true = pinned, false = unpinned. */
  pinned?: boolean
  /** locking-change events: true = locked, false = unlocked. */
  locked?: boolean
}

export interface DiscussionDetail extends DiscussionSummary {
  events: DiscussionEvent[]
  /** Pull requests only. */
  baseRef?: string
  diffUrl?: string
}

export type DiscussionType = 'discussion' | 'pull_request'
export type DiscussionStatusFilter = 'open' | 'closed'

/** One emoji reaction on a post, with who reacted (to derive the current user's state). */
export interface PostReaction {
  emoji: string
  count: number
  /** Usernames that reacted with this emoji; used to highlight the caller's own reaction. */
  users: string[]
}

/**
 * The fixed reaction set the Hub web UI offers on posts and discussion
 * comments. Live-captured from the huggingface.co picker 2026-07-11.
 */
export const HUB_REACTION_EMOJIS = [
  '🔥',
  '🚀',
  '👀',
  '❤️',
  '🤗',
  '😎',
  '➕',
  '🧠',
  '👍',
  '🤝',
  '😔',
  '🤯'
] as const

/**
 * A media attachment on a post. The Hub keeps these OUT of the markdown body —
 * they live in a separate `attachments` array — so they must be rendered
 * alongside the text, not inside it.
 */
export interface PostAttachment {
  type: 'image' | 'video'
  /** Absolute CDN URL (cdn-uploads.huggingface.co). */
  url: string
}

export interface PostSummary {
  slug: string
  author: string
  authorFullname?: string
  authorAvatarUrl?: string
  /** Hub `author.isPro` — drives compact Pro avatar frame when true. */
  authorIsPro?: boolean
  /** Raw markdown-ish text of the post. */
  content: string
  publishedAt?: string
  numComments?: number
  numReactions?: number
  /** Per-emoji reaction breakdown (empty when the post has no reactions). */
  reactions: PostReaction[]
  /** Image/video attachments the Hub stores separately from the markdown body. */
  attachments: PostAttachment[]
  /** Absolute huggingface.co URL. */
  url: string
}

/** One comment on a community post (parsed from the Hub post page's embedded data). */
export interface PostComment {
  /** 24-hex comment id; addressable for replies and reactions. */
  id: string
  author: string
  authorFullname?: string
  authorAvatarUrl?: string
  authorIsPro?: boolean
  createdAt?: string
  /** Raw markdown of the latest revision. */
  content: string
  reactions: PostReaction[]
  /** Nested replies to this comment (the Hub threads them one level deep). */
  replies?: PostComment[]
  /** Hidden comments keep their metadata but the content is withheld by the Hub. */
  hidden?: boolean
  /** Verbatim reason label the moderator picked (e.g. "Off-Topic"), when hidden. */
  hiddenReason?: string
  /** Username that hid the comment, when reported. */
  hiddenBy?: string
}

/**
 * The fixed reasons the Hub offers when hiding a comment. Sent VERBATIM as the
 * `reason` field (the API stores the display label, not a code). Live-captured
 * 2026-07-11. Hiding is optional-reason and irreversible.
 */
export const HUB_HIDE_REASONS = [
  'Spam',
  'Abuse',
  'Graphic Content',
  'Resolved',
  'Off-Topic',
  'Low Quality'
] as const
export type HubHideReason = (typeof HUB_HIDE_REASONS)[number]

/** One custom field on a gated repo's access-request form (the Hub uses the question text as the field name). */
export interface GatedFormField {
  name: string
  type: 'checkbox' | 'text' | 'textarea' | 'select' | 'date'
  required: boolean
  /** Choices when type is 'select'. */
  options?: string[]
}

/**
 * The signed-in account's standing with a gated repo.
 * granted — access already approved; ask — can submit the access form;
 * pending — submitted, awaiting manual review (gate form no longer offered).
 */
export interface RepoAccessGate {
  status: 'granted' | 'ask' | 'pending'
  /** Fields to render when status is 'ask'. */
  fields: GatedFormField[]
}

/** Whether the signed-in account may create community posts (Hub gates this behind a beta). */
export interface CanPostResult {
  canPost: boolean
  /** Hub-provided explanation when posting is unavailable. */
  reason?: string
}

/**
 * Editable public-profile fields, mirroring the Hub's Settings → Profile form
 * (no JSON endpoint — scraped from the SSR page; needs a Hub web session).
 */
export interface HubProfileSettings {
  fullname: string
  homepage: string
  /** The "AI & ML interests" textarea (the form's `details` field). */
  details: string
  github: string
  twitter: string
  linkedin: string
  bluesky: string
  /** Primary organization name; '' when none is set. */
  primaryOrg: string
  /** Orgs the Hub offers for primaryOrg (Team/Enterprise plans only). */
  primaryOrgOptions: Array<{ value: string; label: string }>
}

/** Profile fields posted back to the Hub. `avatar` is a freshly uploaded image URL; omit to keep the current one. */
export interface HubProfileUpdate {
  fullname: string
  homepage: string
  details: string
  github: string
  twitter: string
  linkedin: string
  bluesky: string
  primaryOrg: string
  avatar?: string
}

export interface UserOverview {
  /** 24-hex `_id` from the overview response — required for watch updates. */
  internalId?: string
  name: string
  fullname?: string
  avatarUrl?: string
  bio?: string
  /** Personal PRO subscription (users only). */
  isPro?: boolean
  /** Org plan when this overview is an organization (`team` / `enterprise` / `plus` / …). */
  plan?: HubOrgPlan
  numModels: number
  numDatasets: number
  numSpaces: number
  numPapers?: number
  numFollowers: number
  numFollowing: number
  /** Org member count (`numUsers` on the organizations overview). */
  numUsers?: number
  numLikes?: number
  orgs: OrgSummary[]
  createdAt?: string
  /** Whether the signed-in account follows this user on the Hub. */
  isFollowing?: boolean
  isOrg?: boolean
}

export interface FollowedAccount {
  name: string
  fullname?: string
  avatarUrl?: string
  isOrg?: boolean
}

/** One entry of the Hub watch list, as returned by PATCH /api/settings/watch. */
export interface WatchedEntry {
  /** 24-hex internal id, when the Hub reports it. */
  internalId?: string
  name: string
  type: 'user' | 'org'
}

/** A discussion/PR surfaced in the activity feed. */
export interface ActivityDiscussion {
  repoId: string
  repoKind: RepoKind
  num: number
  title: string
  isPullRequest: boolean
  status?: string
  numComments?: number
}

/**
 * One item in the personalized "following" activity feed
 * (`/api/recent-activity`). Discriminated by `kind`; each carries the actor and
 * a type-specific payload. Kinds the app doesn't render yet (collection, upvote,
 * paper-daily) are dropped by the mapper.
 */
export type ActivityItem =
  | {
      kind: 'like' | 'update' | 'publish' | 'new-repo'
      time?: string
      actor: string
      actorAvatarUrl?: string
      /** Hub activity `isPro` when present. */
      actorIsPro?: boolean
      repo: RepoSummary
    }
  | {
      kind: 'social-post'
      time?: string
      actor: string
      actorAvatarUrl?: string
      actorIsPro?: boolean
      post: PostSummary
    }
  | {
      kind: 'discussion'
      time?: string
      actor: string
      actorAvatarUrl?: string
      actorIsPro?: boolean
      discussion: ActivityDiscussion
    }

export interface ActivityFeed {
  items: ActivityItem[]
  /** Opaque cursor for the next page, when the Hub returns one. */
  cursor?: string
}

export type ThemeSetting = 'system' | 'light' | 'dark'

/**
 * Closed proxy policy. `system` follows the OS/Electron route, `direct`
 * bypasses every proxy layer, and `manual` uses a fixed HTTP(S) proxy URL.
 * The mode is always one of these three — never a nullable string.
 */
export type ProxyMode = 'system' | 'direct' | 'manual'

/** The seed Manual proxy URL baked into settings (the machine's working proxy). */
export const DEFAULT_MANUAL_PROXY_URL = 'http://127.0.0.1:7897'

/**
 * Product-level proxy configuration persisted in settings. `manualUrl` is a
 * normalized HTTP(S) host:port URL with NO userinfo/path/query/fragment; it is
 * retained across mode switches so Manual always remembers the last value.
 */
export interface ProxyConfig {
  mode: ProxyMode
  manualUrl: string | null
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: 'system',
  manualUrl: DEFAULT_MANUAL_PROXY_URL
}

/**
 * The resolved proxy selection frozen onto a download task at creation and
 * never rewritten afterwards. System stores NO endpoint (the OS route is
 * resolved at request execution, not frozen); Manual stores the normalized
 * URL; Direct stores nothing.
 */
export type ProxySnapshot =
  { mode: 'system' } | { mode: 'direct' } | { mode: 'manual'; url: string }

/**
 * Optional per-create proxy selection in DownloadRequest. When omitted the
 * settings ProxyConfig decides. A partial or unknown mode is rejected by the
 * IPC schema before it ever reaches the download manager.
 */
export type DownloadProxyOverride =
  { mode: 'system' } | { mode: 'direct' } | { mode: 'manual'; url: string }

export type DefaultHome = 'home' | 'models' | 'datasets' | 'spaces' | 'papers'

export type UiDensity = 'comfortable' | 'compact'

export type AccentPreset = 'default' | 'blue' | 'green' | 'orange' | 'violet'

export type BrowsePageSize = 20 | 30 | 50

export type RepoOpenTarget = 'app' | 'browser'

export type HistoryLimit = 50 | 100 | 200 | 500

export const LLM_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

/** Persisted provider config. API keys are never stored here. */
export type LlmProviderConfig = {
  readonly modelId: string
  /** null = use the provider's runtime default from DEFAULT_LLM_BASE_URLS. */
  readonly baseUrl: string | null
}

export type LlmSettings = {
  readonly activeProvider: LlmProvider
  readonly providers: {
    readonly openai: LlmProviderConfig
    readonly anthropic: LlmProviderConfig
    readonly gemini: LlmProviderConfig
  }
}

export const DEFAULT_LLM_SETTINGS = {
  activeProvider: 'openai',
  providers: {
    openai: { modelId: '', baseUrl: null },
    anthropic: { modelId: '', baseUrl: null },
    gemini: { modelId: '', baseUrl: null }
  }
} as const satisfies LlmSettings

/** Runtime endpoints used when a provider's persisted baseUrl is null. */
export const DEFAULT_LLM_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com'
} as const satisfies Record<LlmProvider, string>

export type LlmConfiguredStatus = {
  readonly openai: boolean
  readonly anthropic: boolean
  readonly gemini: boolean
}

export type LlmStatus = {
  readonly configured: LlmConfiguredStatus
}

export type LlmTestConnectionRequest = {
  readonly provider: LlmProvider
  readonly modelId: string
  readonly baseUrl: string | null
  readonly apiKey?: string
}

export type LlmTestConnectionResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly error: LlmErrorCode }

export type LlmTranslateRequest = {
  readonly requestId: string
  readonly markdown: string
  readonly targetLocale: Locale
}

export type LlmTranslationResult =
  | {
      readonly status: 'translated'
      readonly sourceLanguage: string
      readonly markdown: string
    }
  | { readonly status: 'same-language'; readonly sourceLanguage: string }

export type LlmTranslateResult =
  LlmTranslationResult | { readonly status: 'error'; readonly error: LlmErrorCode }

export const LLM_ERROR_CODES = [
  'not-configured',
  'invalid-config',
  'auth',
  'forbidden',
  'model-not-found',
  'rate-limited',
  'timeout',
  'canceled',
  'provider-unavailable',
  'malformed-response',
  'empty-response',
  'refused',
  'input-too-long',
  'unknown'
] as const
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number]

export interface AppSettings {
  locale: 'system' | Locale
  theme: ThemeSetting
  downloadConcurrency: number
  /** null = unlimited */
  speedLimitBps: number | null
  /** null = platform default HF cache dir */
  hfCacheDir: string | null
  notificationsEnabled: boolean
  pollIntervalMinutes: number
  /** UI zoom percentage (100 = default). */
  uiScale: number
  /** null = https://huggingface.co */
  hubEndpoint: string | null
  /** Closed proxy policy: system (OS route) / direct / manual URL. */
  proxy: ProxyConfig
  /** Open the app automatically when the user logs into the OS. */
  launchAtLogin: boolean
  /** Hide to the system tray instead of quitting when the window is closed. */
  closeToTray: boolean
  /** Landing route when opening the app at `/`. */
  defaultHome: DefaultHome
  /** Default browse sort for models/datasets/spaces. */
  defaultRepoSort: RepoSort
  /** List/sidebar spacing density. */
  uiDensity: UiDensity
  /** Focus/selection accent preset (does not change CTA or brand yellow). */
  accent: AccentPreset
  /** Root font-size percentage (100 = default); independent of uiScale zoom. */
  fontScale: number
  /** Manual sidebar collapse persisted in settings. */
  sidebarCollapsed: boolean
  /** Page size for main browse / search lists. */
  browsePageSize: BrowsePageSize
  /** Where favorites/history/global-search open repos. */
  repoOpenTarget: RepoOpenTarget
  /** Max local history rows retained. */
  historyLimit: HistoryLimit
  /** Translation LLM config. API keys are stored separately, never here. */
  llm: LlmSettings
}

/** Renderer-writable settings. Cache roots are selected and persisted by main. */
export type SettingsPatch = Partial<Omit<AppSettings, 'hfCacheDir'>>

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'system',
  theme: 'system',
  downloadConcurrency: 3,
  speedLimitBps: null,
  hfCacheDir: null,
  notificationsEnabled: true,
  pollIntervalMinutes: 30,
  uiScale: 100,
  hubEndpoint: null,
  proxy: DEFAULT_PROXY_CONFIG,
  launchAtLogin: false,
  closeToTray: false,
  defaultHome: 'home',
  defaultRepoSort: 'trending',
  uiDensity: 'comfortable',
  accent: 'default',
  fontScale: 100,
  sidebarCollapsed: false,
  browsePageSize: 30,
  repoOpenTarget: 'app',
  historyLimit: 200,
  llm: DEFAULT_LLM_SETTINGS
}

/** Subset of process.platform values the app runs on (kept Node-types-free for the renderer). */
export type Platform = 'darwin' | 'win32' | 'linux' | 'freebsd' | 'openbsd' | 'aix' | 'sunos'

export interface AppInfo {
  version: string
  platform: Platform
  electronVersion: string
  systemLocale: string
  hfCacheDir: string
  /** Windows-only Start Menu shortcut registration, surfaced to diagnostics. */
  notificationRegistration: NotificationRegistrationInfo
}

/**
 * Typed outcome of registering the portable Start Menu shortcut. The reason is
 * sanitized in the main process and never contains personal path details.
 */
export type NotificationRegistrationStatus = 'registered' | 'unsupported' | 'failed' | 'disabled'

export interface NotificationRegistrationInfo {
  status: NotificationRegistrationStatus
  reason?: string
}

export type ExportTool = 'ollama' | 'lmstudio' | 'comfyui'

export interface ExportTarget {
  tool: ExportTool
  detected: boolean
  path?: string
}

/** messageKey resolves in the renderer's `integrations` i18n namespace. */
export interface ExportResult {
  ok: boolean
  messageKey: string
  params?: Record<string, string>
}

export type UploadWarningCode = 'sensitive-path' | 'large-upload'

export interface UploadWarning {
  code: UploadWarningCode
  /** Relative paths only; never an executable local absolute path. */
  paths?: string[]
  overflow?: number
  requiresAcknowledgement: true
}

/** Opaque, one-use directory grant created by the main process. */
export interface UploadSelection {
  selectionId: string
  label: string
  expiresAt: string
  fileCount: number
  totalBytes: number
  excludedCount: number
  warnings: UploadWarning[]
}

export interface UploadStartRequest {
  selectionId: string
  kind: RepoKind
  name: string
  private: boolean
  acknowledgedWarningCodes: UploadWarningCode[]
}

/** Request to retry a persisted upload task by its DB row id. */
export interface UploadRetryRequest {
  taskId: string
}

/**
 * Persisted upload task row (append-only). Never contains token, file content,
 * ignored sensitive path samples, device/inode as restart identity, or open handles.
 */
export interface UploadTaskRecord {
  id: string
  accountId: string | null
  accountLabel: string | null
  repoKind: RepoKind
  repoName: string
  repoVisibility: 'public' | 'private'
  rootPath: string
  /** Deterministic SHA-256 hex over sorted (relativePath, size, contentSha256). */
  manifestFingerprint: string
  warningCodes: UploadWarningCode[]
  summaryFileCount: number
  summaryTotalBytes: number
  status: IntegrationTaskStatus
  phase: string
  progress: number
  messageKey?: string
  params?: Record<string, string>
  repoId?: string
  repoUrl?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ExportStartRequest {
  tool: ExportTool
  kind: RepoKind
  repoId: string
  filePath: string
}

export type IntegrationTaskStatus =
  | 'preparing'
  | 'running'
  | 'done'
  | 'error'
  | 'canceled'
  | 'interrupted'
  | 'selection-stale'
  | 'account-unavailable'

export interface IntegrationTaskBase {
  id: string
  kind: 'upload' | 'export'
  status: IntegrationTaskStatus
  phase: string
  /** 0..1 when the underlying operation exposes determinate progress. */
  progress?: number
  messageKey?: string
  params?: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface UploadIntegrationTask extends IntegrationTaskBase {
  kind: 'upload'
  accountId?: string
  accountLabel?: string
  repoId?: string
  repoKind: RepoKind
  path?: string
  repoUrl?: string
}

export interface ExportIntegrationTask extends IntegrationTaskBase {
  kind: 'export'
  tool: ExportTool
  repoKind: RepoKind
  repoId: string
  filePath: string
  /** Tracked main-process output; renderer reveals it only by task id. */
  outputLabel?: string
}

export type IntegrationTask = UploadIntegrationTask | ExportIntegrationTask

export interface InferenceRequest {
  model: string
  input: string
}

export interface InferenceResult {
  ok: boolean
  output?: string
  error?: string
}

export interface InferenceStreamEvent {
  id: string
  delta?: string
  done?: boolean
  error?: string
}

export interface FileTextResult {
  content: string
  truncated: boolean
  size: number
}

export interface SafetensorsTensor {
  name: string
  dtype: string
  shape: number[]
}

export interface SafetensorsHeader {
  tensors: SafetensorsTensor[]
  metadata?: Record<string, string>
  totalParams: number
}

export interface DatasetSplit {
  config: string
  split: string
}

export interface UserSearchResult {
  name: string
  fullname?: string
  avatarUrl?: string
}

/** Org hit from `/api/quicksearch?type=org` (Hub uses `name`, not `user`). */
export interface OrgSearchResult {
  name: string
  fullname?: string
  avatarUrl?: string
}

/** Paper hit from `/api/quicksearch?type=paper` (`_id` → `id`). */
export interface PaperSearchResult {
  id: string
  title: string
}

/** Collection hit from `/api/quicksearch?type=collection` (`_id` is the routable slug). */
export interface CollectionSearchResult {
  slug: string
  title: string
  description?: string
}

export interface DatasetRows {
  columns: string[]
  /** Cell values pre-stringified and truncated for display. */
  rows: string[][]
  /**
   * Untruncated JSON cell values from datasets-server. Absent on SSR sample
   * fallbacks. Nested/list/media values stay as JSON (not flattened).
   */
  values?: unknown[][]
  total?: number
  /**
   * True when these are the SSR sample rows from the dataset page — the
   * fallback the Hub itself shows when the full viewer isn't available.
   */
  sample?: boolean
}

/** Server page size used by the dataset viewer. */
export const DATASET_PREVIEW_PAGE_SIZE = 25

/** Hard cap on `dataset:exportPage` length (preview pages are 25). */
export const DATASET_EXPORT_MAX_LENGTH = 100

export const DATASET_EXPORT_FORMATS = ['csv', 'jsonl'] as const
export type DatasetExportFormat = (typeof DATASET_EXPORT_FORMATS)[number]

/** Outcome of a main-owned current-page dataset export. Never carries a filesystem path. */
export type DatasetExportPageResult =
  | { readonly status: 'canceled' }
  | { readonly status: 'saved'; readonly label: string }
  | { readonly status: 'error'; readonly message: string }

export interface CollectionSummary {
  /** "owner/title-slug-<24hex>" — the API path segment. */
  slug: string
  title: string
  description?: string
  owner: string
  private: boolean
  theme?: string
  itemCount?: number
  upvotes?: number
  /** Whether the signed-in account upvoted this collection (detail responses only). */
  isUpvoted?: boolean
  updatedAt?: string
}

export interface CollectionItem {
  /** `_id` used for item PATCH/DELETE. */
  itemId: string
  type: 'model' | 'dataset' | 'space' | 'paper' | 'collection'
  /** Repo id / paper id. */
  id: string
  /** Paper title or repo id. */
  title?: string
  /** Routable slug for type:'collection' items — the id field is the internal 24-hex id. */
  slug?: string
  note?: string
  position?: number
  /** Light display metadata when present in the API response: */
  downloads?: number
  likes?: number
  emoji?: string
}

export interface CollectionDetail extends CollectionSummary {
  items: CollectionItem[]
}

export interface MyRepoEntry {
  id: string
  /** Filter API `type` to model|dataset|space; drop bucket/kernel. */
  kind: RepoKind
  visibility: 'public' | 'private' | 'protected'
  updatedAt: string
  storage: number
  storagePercent: number
}

export interface AccessRequestUser {
  name: string
  fullname?: string
  avatarUrl?: string
}

export interface AccessRequest {
  user: AccessRequestUser
  timestamp?: string
  /** Extra gate-form fields if present. */
  fields?: Record<string, string>
}

export interface SpaceSecret {
  key: string
  description?: string
  updatedAt?: string
}

export interface SpaceVariable {
  key: string
  value?: string
  description?: string
  updatedAt?: string
}

/**
 * Lifecycle stage reported by `GET /api/spaces/{repoId}/runtime`. The listed
 * values are the official Space stages; the open-string fallback keeps parsing
 * forward-compatible when the Hub adds new stages.
 */
export type SpaceStage =
  | 'NO_APP_FILE'
  | 'BUILDING'
  | 'BUILD_ERROR'
  | 'APP_STARTING'
  | 'RUNNING'
  | 'RUNNING_APP_STARTING'
  | 'RUNNING_BUILDING'
  | 'PAUSED'
  | 'SLEEPING'
  | 'RUNTIME_ERROR'
  | 'DELETING'
  | 'STOPPED'
  | (string & {})

/** Hardware flavors accepted by the official Space hardware endpoints. */
export const SPACE_HARDWARE_FLAVORS = [
  'cpu-basic',
  'cpu-upgrade',
  'cpu-performance',
  'cpu-xl',
  'sprx8',
  'zero-a10g',
  't4-small',
  't4-medium',
  'l4x1',
  'l4x4',
  'l40sx1',
  'l40sx4',
  'l40sx8',
  'a10g-small',
  'a10g-large',
  'a10g-largex2',
  'a10g-largex4',
  'a100-large',
  'a100x4',
  'a100x8',
  'h200',
  'h200x2',
  'h200x4',
  'h200x8',
  'rtx-pro-6000',
  'rtx-pro-6000x2',
  'rtx-pro-6000x4',
  'rtx-pro-6000x8',
  'inf2x6'
] as const
export type SpaceHardwareFlavor = (typeof SPACE_HARDWARE_FLAVORS)[number]

/** The free hardware tier: the Hub manages its sleep window automatically. */
export const SPACE_FREE_FLAVOR = 'cpu-basic'

/**
 * Live runtime state of a Space (`GET /api/spaces/{repoId}/runtime`). `stage`
 * is the only semantic field the Hub must send; every other field is optional
 * and unknown additive fields are ignored by the mapper. Parsed-but-unrendered
 * storage/dev-mode fields exist for forward compatibility only — the app never
 * manages volumes or dev mode.
 */
export interface SpaceRuntime {
  stage: SpaceStage
  /** Currently assigned hardware flavor, when the Hub reports one. */
  hardware?: string | null
  /** Pending hardware flavor while a hardware switch is in flight. */
  requestedHardware?: string | null
  /** Inactivity seconds before the Space sleeps; -1 means never sleep. */
  gcTimeout?: number | null
  /** Configured sleep window in seconds, when the Hub reports one. */
  sleepTime?: number | null
  /** Persistent storage tier, when configured (displayed nowhere). */
  storage?: string | null
  /** Dev-mode flag, when present (displayed nowhere; no dev-mode controls). */
  devMode?: boolean | null
}

/**
 * One entry of the public hardware catalog (`GET /api/spaces/hardware`). The
 * Hub response also carries per-unit cost fields; the mapper strips them, so
 * no price can reach the UI.
 */
export interface SpaceHardwareCatalogEntry {
  name: string
  prettyName?: string
  cpu?: string
  ram?: string
  /** Human-readable accelerator summary ("A10G 24GB x1"), when present. */
  accelerator?: string | null
}

export interface BillingUsage {
  periodStart?: string
  periodEnd?: string
  /** Tolerant of shape drift: generic labeled rows for display. */
  rows: { label: string; detail?: string; amountCents?: number }[]
}

/**
 * Diagnostics readiness model (plan Todo 23). Every probe emits one typed
 * `DiagnosticCheck` whose status is always exactly one of the four closed
 * values — `unknown` is a real outcome, never a disguised `pass` — plus a
 * normalized machine-readable reason code and a sanitized user action.
 */
export type DiagnosticStatus = 'pass' | 'warning' | 'failure' | 'unknown'

export type DiagnosticCategory =
  | 'app'
  | 'system'
  | 'disk'
  | 'cache'
  | 'destination'
  | 'symlink'
  | 'notifications'
  | 'network'
  | 'git'
  | 'credentials'
  | 'database'

/** Closed set of normalized machine-readable reason codes emitted by probes. */
export const DIAGNOSTIC_REASON_CODES = [
  'ok',
  'missing',
  'timeout',
  'canceled',
  'probe-error',
  'unavailable',
  'unwritable',
  'low-space',
  'critical-space',
  'low-memory',
  'critical-memory',
  'degraded',
  'unconfigured',
  'plaintext-helper',
  'no-credential-helper',
  'unreachable',
  'unhealthy',
  'disabled',
  'unsupported',
  'bounded',
  'nonzero',
  'denied',
  'outdated'
] as const
export type DiagnosticReasonCode = (typeof DIAGNOSTIC_REASON_CODES)[number]

export interface DiagnosticCheck {
  /** Stable probe id, e.g. `git.version`. */
  id: string
  category: DiagnosticCategory
  status: DiagnosticStatus
  reasonCode: DiagnosticReasonCode
  /** Human-readable summary. Never contains raw paths, env, or secrets. */
  message: string
  /** Optional structured detail; already redacted and path-sanitized. */
  detail?: string
  /** Optional sanitized, user-actionable guidance (never auto-run). */
  action?: string
  /** Wall time of the probe in milliseconds (bounded by the configured deadline). */
  durationMs: number
  /** ISO timestamp the probe completed. */
  checkedAt: string
}

export interface DiagnosticReport {
  /** Deterministic probe order (sorted by id). */
  checks: DiagnosticCheck[]
  /** Local/static Hub capability status inventory, when the desktop provides it. */
  capabilities?: HubCapabilityStatus[]
  completedAt: string
}

/**
 * Progress/cancel surface for the diagnostics run and support-bundle export
 * (plan Todo 24). Every string field is already redacted and path-sanitized in
 * the main process before it crosses IPC.
 */
export interface DiagnosticsProgress {
  /** Which in-flight operation the progress belongs to. */
  phase: 'run' | 'export'
  /** 0..1 overall progress within the phase. */
  percent: number
  /** Redacted human-readable status text. */
  status: string
  /** When phase=run: probes completed so far. */
  completedChecks?: number
  /** When phase=run: total probes to run. */
  totalChecks?: number
  /** When phase=export: the member being serialized. */
  member?: string
}

/**
 * Typed outcome of one support-bundle export. The ZIP path is returned ONLY
 * after the archive was fully written, sentinel-scanned, and atomically
 * renamed into place — the renderer never learns a temp path.
 */
export type DiagnosticsExportResult =
  { canceled: true } | { canceled: false; path: string; memberCount: number; bytesWritten: number }
