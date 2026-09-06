/**
 * The complete IPC surface, defined as a typed contract.
 * No string channels are used anywhere else: main registers handlers from this map,
 * preload exposes `invoke`/`on` typed against it, and the renderer consumes it.
 */
import type {
  AccessRequest,
  AccountRemoveResult,
  AccountSummary,
  AccountSwitchResult,
  ActivityFeed,
  AppInfo,
  AppSettings,
  AuthState,
  BillingUsage,
  TokenSignInResult,
  SignOutResult,
  CacheActionPlan,
  CacheActionPlanRequest,
  CacheActionResult,
  CacheReport,
  CacheVerificationProgress,
  CacheVerificationReport,
  CollectionDetail,
  CollectionSummary,
  DatasetExportFormat,
  DatasetExportPageResult,
  DatasetRows,
  DatasetSplit,
  DiagnosticReport,
  DiagnosticsExportResult,
  DiagnosticsProgress,
  DiscussionDetail,
  DiscussionStatusFilter,
  DiscussionSummary,
  DiscussionType,
  CanPostResult,
  DownloadPlan,
  DownloadPlanRequest,
  DownloadPlanStartRequest,
  DownloadProxyOverride,
  DownloadRequest,
  DownloadTask,
  ExportStartRequest,
  HubProfileSettings,
  HubProfileUpdate,
  HubSessionConnectResult,
  PostComment,
  ExportTarget,
  FavoriteItem,
  FileTextResult,
  FileTreeEntry,
  FollowedAccount,
  Follow,
  FollowTargetType,
  HistoryItem,
  IntegrationTask,
  InboxItem,
  InferenceRequest,
  InferenceResult,
  InferenceStreamEvent,
  LlmProvider,
  LlmStatus,
  LlmTestConnectionRequest,
  LlmTestConnectionResult,
  LlmTranslateRequest,
  LlmTranslateResult,
  MyRepoEntry,
  NotificationsPage,
  Page,
  PaperSummary,
  PostSummary,
  RepoAccessGate,
  RepoDetail,
  RepoKind,
  RepoSummary,
  SafetensorsHeader,
  SearchQuery,
  SpaceHardwareCatalogEntry,
  SpaceHardwareFlavor,
  SpaceRuntime,
  SpaceSecret,
  SpaceVariable,
  UploadSelection,
  UploadStartRequest,
  UploadRetryRequest,
  UploadTaskRecord,
  WatchedEntry,
  SettingsPatch,
  UserOverview,
  UserSearchResult,
  OrgSearchResult,
  PaperSearchResult,
  CollectionSearchResult,
  HubCapabilityKey,
  HubCapabilityStatus
} from './types'
import type { CloneRecord } from './clone-record'
import type { CloneRequest } from './clone'

/** Request/response map for `ipcRenderer.invoke`-style calls. */
export interface IpcInvokeContract {
  'system:getAppInfo': { req: void; res: AppInfo }
  'system:openExternal': { req: { url: string }; res: void }

  'settings:get': { req: void; res: AppSettings }
  'settings:set': { req: { patch: SettingsPatch }; res: AppSettings }
  'settings:selectCacheDir': { req: void; res: AppSettings | null }
  'settings:resetCacheDir': { req: void; res: AppSettings }

  /** Wipe selected app SQLite library tables; optional Hub sign-out. Never deletes HF cache files. */
  'privacy:clearLocalData': {
    req: {
      favorites?: boolean
      history?: boolean
      downloads?: boolean
      follows?: boolean
      inbox?: boolean
      otherKv?: boolean
      signOut?: boolean
    }
    res: { cleared: true; signedOut: boolean }
  }

  /** Save current AppSettings to a JSON file via native save dialog. */
  'settings:export': {
    req: void
    res: { canceled: true } | { canceled: false; path: string }
  }

  /** Load AppSettings from a JSON file; preserves local hfCacheDir. */
  'settings:import': {
    req: void
    res: { canceled: true } | { canceled: false; settings: AppSettings }
  }

  /**
   * Lightweight Hub reachability check. Draft endpoint/proxy (mode-aware
   * override; omitted = applied settings) are probed on a temporary client so
   * the user can test before Apply. The probe never changes the saved value.
   * `latencyMs` is a sanitized round-trip measure of the probe request.
   */
  'network:testConnection': {
    req: { endpoint?: string | null; proxy?: DownloadProxyOverride }
    res: { ok: true; latencyMs: number } | { ok: false; error: string }
  }
  /** Read local/static Hub capability knowledge; never performs network I/O. */
  'compatibility:read': { req: void; res: HubCapabilityStatus[] }
  /** Explicitly probe one capability through the active main-process client. */
  'compatibility:probe': { req: { key: HubCapabilityKey }; res: HubCapabilityStatus }

  'hub:search': { req: { query: SearchQuery }; res: Page<RepoSummary> }
  'hub:papers': { req: { cursor?: string }; res: Page<PaperSummary> }
  /** Single paper lookup for deep links outside the daily feed. */
  'hub:paper': { req: { paperId: string }; res: PaperSummary }
  'hub:repoDetail': { req: { kind: RepoKind; repoId: string }; res: RepoDetail }
  'hub:readme': { req: { kind: RepoKind; repoId: string; revision?: string }; res: string }
  'hub:fileTree': {
    req: { kind: RepoKind; repoId: string; revision?: string; path?: string }
    res: FileTreeEntry[]
  }
  'hub:discussions': {
    req: {
      kind: RepoKind
      repoId: string
      type?: DiscussionType
      status?: DiscussionStatusFilter
      /** Opaque next-page cursor from the previous response's nextCursor. */
      cursor?: string
    }
    res: Page<DiscussionSummary>
  }
  /** Raw unified diff of a pull request ('' when unavailable). */
  'hub:discussionDiff': {
    req: { kind: RepoKind; repoId: string; num: number }
    res: string
  }
  'hub:posts': { req: { cursor?: string }; res: Page<PostSummary> }
  'hub:recentActivity': { req: { cursor?: string }; res: ActivityFeed }
  'hub:postDetail': { req: { author: string; slug: string }; res: PostSummary }
  'hub:userOverview': { req: { username: string }; res: UserOverview }
  /** Accounts the given user follows on the Hub (drained pagination, capped). */
  'hub:userFollowing': { req: { username: string }; res: FollowedAccount[] }
  /** Organization members (capped avatar strip for the profile page). */
  'hub:orgMembers': { req: { org: string; limit?: number }; res: FollowedAccount[] }
  'hub:discussionDetail': {
    req: { kind: RepoKind; repoId: string; num: number }
    res: DiscussionDetail
  }
  'hub:discussionComment': {
    req: { kind: RepoKind; repoId: string; num: number; comment: string }
    res: void
  }
  /** Open a new discussion (or draft PR when pullRequest is true); returns the thread number. */
  'hub:discussionCreate': {
    req: {
      kind: RepoKind
      repoId: string
      title: string
      description: string
      pullRequest?: boolean
    }
    res: { num: number }
  }
  'hub:notifications': { req: { page?: number }; res: NotificationsPage }
  /** Empty discussionIds = mark everything as read/unread. */
  'hub:notificationsMarkRead': { req: { discussionIds: string[]; read: boolean }; res: void }
  'hub:notificationsClear': { req: void; res: void }
  /**
   * Watch/unwatch users and orgs by their account HANDLE (username/org name).
   * Returns the resulting watch list so callers can VERIFY an add took effect
   * — the Hub silently ignores mutations that lack a web session (and any that
   * pass the internal id instead of the handle).
   */
  'hub:watchUpdate': {
    req: {
      add?: { id: string; type: 'user' | 'org' }[]
      delete?: { id: string; type: 'user' | 'org' }[]
    }
    res: WatchedEntry[]
  }
  /** Current Hub watch list (read via a no-op watch PATCH). */
  'hub:watchList': { req: void; res: WatchedEntry[] }
  /**
   * Attempt watch/unwatch (by account handle) and report whether the Hub
   * applied it. Sessions without a web cookie get applied=false — UI should
   * open the website Watch control as a fallback.
   */
  'hub:watchSet': {
    req: { id: string; type: 'user' | 'org'; watching: boolean }
    res: { applied: boolean; watched: WatchedEntry[] }
  }
  'hub:fileText': {
    req: { kind: RepoKind; repoId: string; path: string; revision?: string; maxBytes?: number }
    res: FileTextResult
  }
  'hub:fileRange': {
    /** `start`..`end` inclusive byte offsets, HTTP Range semantics. */
    req: {
      kind: RepoKind
      repoId: string
      path: string
      revision?: string
      start: number
      end: number
    }
    res: Uint8Array
  }
  'hub:safetensorsHeader': {
    req: { kind: RepoKind; repoId: string; path: string; revision?: string }
    res: SafetensorsHeader
  }
  'hub:datasetSplits': { req: { repoId: string }; res: DatasetSplit[] }
  'hub:searchUsers': { req: { query: string }; res: UserSearchResult[] }
  'hub:searchOrgs': { req: { query: string }; res: OrgSearchResult[] }
  'hub:searchPapers': { req: { query: string }; res: PaperSearchResult[] }
  'hub:searchCollections': { req: { query: string }; res: CollectionSearchResult[] }
  /** Whether at least one inference provider serves this model. */
  'hub:inferenceAvailable': { req: { repoId: string }; res: boolean }
  'hub:datasetRows': {
    req: { repoId: string; config: string; split: string; offset?: number; length?: number }
    res: DatasetRows
  }
  /**
   * SSR sample rows from the dataset page — the Hub's own fallback when the
   * full viewer is unavailable. null when the page carries no sample either.
   */
  'hub:datasetSampleRows': { req: { repoId: string }; res: DatasetRows | null }
  /**
   * Re-fetch one datasets-server page and write it as CSV or JSONL via a
   * main-owned save dialog. Renderer row payloads are rejected; the result
   * never includes a filesystem path.
   */
  'dataset:exportPage': {
    req: {
      repoId: string
      config: string
      split: string
      offset: number
      length: number
      format: DatasetExportFormat
    }
    res: DatasetExportPageResult
  }
  /** The signed-in account's standing with a gated repo (granted/ask/pending + form fields). */
  'hub:repoAccessGate': { req: { kind: RepoKind; repoId: string }; res: RepoAccessGate }
  /** Submit the gated-repo access form (needs a Hub web session). */
  'hub:repoAccessAsk': {
    req: { kind: RepoKind; repoId: string; fields: Record<string, string> }
    res: void
  }

  'hub:collections': { req: { owner: string }; res: CollectionSummary[] }
  'hub:collection': { req: { slug: string }; res: CollectionDetail }
  'hub:collectionCreate': {
    req: { namespace: string; title: string; description?: string; private: boolean }
    res: CollectionDetail
  }
  'hub:collectionUpdate': {
    req: {
      slug: string
      patch: {
        title?: string
        description?: string
        private?: boolean
        position?: number
        theme?: string
      }
    }
    res: void
  }
  /** Destructive: confirmSlug must equal slug (enforced by the zod schema). */
  'hub:collectionDelete': { req: { slug: string; confirmSlug: string }; res: void }
  'hub:collectionAddItem': {
    req: {
      slug: string
      item: { type: 'model' | 'dataset' | 'space' | 'paper'; id: string }
      note?: string
    }
    res: void
  }
  'hub:collectionUpdateItem': {
    req: { slug: string; itemId: string; note?: string; position?: number }
    res: void
  }
  'hub:collectionRemoveItem': { req: { slug: string; itemId: string }; res: void }

  'hub:myRepos': { req: void; res: MyRepoEntry[] }
  'hub:repoSettingsUpdate': {
    req: {
      kind: RepoKind
      repoId: string
      patch: { private?: boolean; gated?: false | 'auto' | 'manual'; discussionsDisabled?: boolean }
    }
    res: void
  }
  'hub:repoMove': { req: { kind: RepoKind; fromRepo: string; toRepo: string }; res: void }
  /** Destructive: confirmName must equal repoId (enforced by the zod schema). */
  'hub:repoDelete': { req: { kind: RepoKind; repoId: string; confirmName: string }; res: void }
  /** Spaces only: the Hub /duplicate endpoint exists solely for repoType=spaces. */
  'hub:repoDuplicate': {
    req: { repoId: string; toRepo: string; private?: boolean }
    res: { url?: string }
  }
  'hub:branchCreate': {
    req: { kind: RepoKind; repoId: string; branch: string; startingPoint?: string }
    res: void
  }
  'hub:branchDelete': { req: { kind: RepoKind; repoId: string; branch: string }; res: void }
  'hub:tagCreate': {
    req: { kind: RepoKind; repoId: string; tag: string; revision?: string; message?: string }
    res: void
  }
  'hub:tagDelete': { req: { kind: RepoKind; repoId: string; tag: string }; res: void }

  /** Gated-repo access requests (models and datasets only). */
  'hub:accessRequests': {
    req: {
      kind: 'model' | 'dataset'
      repoId: string
      status: 'pending' | 'accepted' | 'rejected'
    }
    res: AccessRequest[]
  }
  'hub:accessRequestHandle': {
    req: {
      kind: 'model' | 'dataset'
      repoId: string
      user: string
      status: 'accepted' | 'rejected' | 'pending'
      rejectionReason?: string
    }
    res: void
  }
  'hub:accessRequestGrant': {
    req: { kind: 'model' | 'dataset'; repoId: string; user: string }
    res: void
  }

  'hub:spaceSecrets': { req: { repoId: string }; res: SpaceSecret[] }
  'hub:spaceSecretSet': {
    req: { repoId: string; key: string; value: string; description?: string }
    res: void
  }
  'hub:spaceSecretDelete': { req: { repoId: string; key: string }; res: void }
  'hub:spaceVariables': { req: { repoId: string }; res: SpaceVariable[] }
  'hub:spaceVariableSet': {
    req: { repoId: string; key: string; value: string; description?: string }
    res: void
  }
  'hub:spaceVariableDelete': { req: { repoId: string; key: string }; res: void }
  /** Bounded snapshot of the Space's SSE log stream (never hangs). */
  'hub:spaceLogs': { req: { repoId: string; logType: 'build' | 'run' }; res: { text: string } }
  'hub:spaceRestart': { req: { repoId: string; factory?: boolean }; res: void }
  /** Owner-scoped runtime state: stage, current/requested hardware, sleep info. */
  'hub:spaceRuntime': { req: { repoId: string }; res: SpaceRuntime }
  /** Public hardware catalog (pricing fields are stripped by the client). */
  'hub:spaceHardwareList': { req: void; res: SpaceHardwareCatalogEntry[] }
  /** Pauses the Space (free; reversible through a normal restart). */
  'hub:spacePause': { req: { repoId: string }; res: void }
  /**
   * Requests a hardware switch; `sleepTimeSeconds` follows the official API
   * (positive seconds, or -1 for never-sleep where accepted).
   */
  'hub:spaceHardwareSet': {
    req: { repoId: string; flavor: SpaceHardwareFlavor; sleepTimeSeconds?: number }
    res: void
  }
  /** Sets the sleep window: positive seconds, or -1 where the API accepts never. */
  'hub:spaceSleepTimeSet': { req: { repoId: string; seconds: number }; res: void }

  'hub:likeSet': { req: { kind: RepoKind; repoId: string; liked: boolean }; res: void }
  /** Social follow/unfollow on the Hub (same as the website Follow button). */
  'hub:followSet': {
    req: { username: string; following: boolean; isOrg?: boolean }
    res: void
  }
  'hub:userLikes': { req: { username: string }; res: RepoSummary[] }
  'hub:postComment': {
    req: { author: string; slug: string; comment: string; replyToCommentId?: string }
    res: void
  }
  /** Toggle an emoji reaction on a community post (needs a Hub web session). */
  'hub:postReactionSet': {
    req: { author: string; slug: string; reaction: string; active: boolean }
    res: void
  }
  /** Comments on a community post (parsed from the Hub post page; public read). */
  'hub:postComments': { req: { author: string; slug: string }; res: PostComment[] }
  /**
   * Hide a comment on a post — irreversible. `reason` is a verbatim label from
   * HUB_HIDE_REASONS (optional). Needs a Hub web session and moderation rights.
   */
  'hub:postCommentHide': {
    req: { author: string; slug: string; commentId: string; reason?: string }
    res: void
  }
  /**
   * Upload a comment attachment (image/audio/video) to the Hub CDN; returns its
   * URL to embed in the comment markdown. Needs a Hub web session.
   */
  'hub:commentAssetUpload': {
    req: { filename: string; contentType: string; data: Uint8Array }
    res: { url: string }
  }
  /** Toggle an emoji reaction on a post comment (needs a Hub web session). */
  'hub:postCommentReactionSet': {
    req: { author: string; slug: string; commentId: string; reaction: string; active: boolean }
    res: void
  }
  /** Whether the connected web session may create posts (Hub beta gate). */
  'hub:postCanCreate': { req: void; res: CanPostResult }
  /** Current editable profile fields from Settings → Profile (needs a Hub web session). */
  'hub:profileGet': { req: void; res: HubProfileSettings }
  /** Save the public profile on the Hub (needs a Hub web session). */
  'hub:profileUpdate': { req: HubProfileUpdate; res: void }
  /** Create a community post (needs a Hub web session with posting access). */
  'hub:postCreate': { req: { content: string }; res: { slug?: string } }
  /** Toggle a Daily Papers upvote (needs a Hub web session). */
  'hub:paperUpvoteSet': { req: { paperId: string; upvoted: boolean }; res: void }
  /** Toggle a collection upvote (needs a Hub web session). */
  'hub:collectionUpvoteSet': { req: { slug: string; upvoted: boolean }; res: void }
  /** Toggle an emoji reaction on a discussion comment (needs a Hub web session). */
  'hub:discussionReactionSet': {
    req: {
      kind: RepoKind
      repoId: string
      num: number
      commentId: string
      reaction: string
      active: boolean
    }
    res: void
  }
  'hub:paperComment': {
    req: { paperId: string; comment: string; replyToCommentId?: string }
    res: void
  }
  /** Existing comment thread on a Daily Papers entry (public read, no auth needed). */
  'hub:paperComments': { req: { paperId: string }; res: PostComment[] }
  /** Toggle an emoji reaction on a paper comment (needs a Hub web session). */
  'hub:paperCommentReactionSet': {
    req: { paperId: string; commentId: string; reaction: string; active: boolean }
    res: void
  }
  'hub:prMerge': {
    req: { kind: RepoKind; repoId: string; num: number; comment?: string }
    res: void
  }
  'hub:discussionStatusSet': {
    req: {
      kind: RepoKind
      repoId: string
      num: number
      status: 'open' | 'closed'
      comment?: string
    }
    res: void
  }
  'hub:discussionTitleSet': {
    req: { kind: RepoKind; repoId: string; num: number; title: string }
    res: void
  }
  'hub:billingUsage': { req: void; res: BillingUsage }

  'auth:getState': { req: void; res: AuthState }
  'auth:listAccounts': { req: void; res: AccountSummary[] }
  /** Validate + install a pasted User Access Token. */
  'auth:signInWithToken': { req: { token: string }; res: TokenSignInResult }
  'auth:signOut': { req: void; res: SignOutResult }
  'auth:switchAccount': { req: { accountId: string }; res: AccountSwitchResult }
  'auth:removeAccount': { req: { accountId: string }; res: AccountRemoveResult }
  /** Open the Hub login window and capture a web-session cookie (supplemental credential). */
  'auth:connectHubSession': { req: void; res: HubSessionConnectResult }
  /** Drop the web-session cookie; the token session stays signed in. */
  'auth:disconnectHubSession': { req: void; res: AuthState }
  /** Re-fetch whoami so avatar/fullname changes land without an app restart. */
  'auth:refreshUser': { req: void; res: AuthState }

  'favorites:list': { req: void; res: FavoriteItem[] }
  'favorites:add': { req: { summary: RepoSummary }; res: FavoriteItem[] }
  'favorites:remove': { req: { kind: RepoKind; repoId: string }; res: FavoriteItem[] }

  'history:list': { req: void; res: HistoryItem[] }
  'history:record': { req: { summary: RepoSummary }; res: void }
  'history:clear': { req: void; res: void }

  'downloads:list': { req: void; res: DownloadTask[] }
  'downloads:start': { req: { request: DownloadRequest }; res: DownloadTask[] }
  'downloads:plan': { req: { request: DownloadPlanRequest }; res: DownloadPlan }
  'downloads:startPlanned': { req: { request: DownloadPlanStartRequest }; res: DownloadTask[] }
  'downloads:pause': { req: { id: string }; res: DownloadTask[] }
  'downloads:resume': { req: { id: string }; res: DownloadTask[] }
  'downloads:cancel': { req: { id: string }; res: DownloadTask[] }
  'downloads:remove': { req: { id: string }; res: DownloadTask[] }
  'downloads:pauseAll': { req: void; res: DownloadTask[] }
  'downloads:resumeAll': { req: void; res: DownloadTask[] }
  'downloads:clearCompleted': { req: void; res: DownloadTask[] }
  'downloads:reveal': { req: { id: string }; res: void }

  /**
   * Clone attempt operations (plan Todo 33). Every input is schema-validated
   * (strict bounds, UUID attempt ids) BEFORE the manager is called; `create`
   * and `retry` accept only validated repo fields (kind/id/revision), the
   * transport, a destination, an auth mode, and a closed proxy override —
   * NEVER a raw URL or a token (URLs are derived, `app-token` rides the
   * Todo 30 AskPass broker). Status transitions belong to CloneManager/
   * CloneStore alone; the renderer can never set a status.
   */
  'clones:list': { req: void; res: CloneRecord[] }
  'clones:get': { req: { id: string }; res: CloneRecord | null }
  'clones:create': { req: { request: CloneRequest }; res: CloneRecord }
  'clones:cancel': { req: { id: string }; res: CloneRecord[] }
  'clones:retry': { req: { parentId: string; request: CloneRequest }; res: CloneRecord }
  /** Open the recorded clone destination folder in the OS file manager. */
  'clones:openDestination': { req: { id: string }; res: void }
  /** Remove one terminal queue record; returns the updated list. */
  'clones:remove': { req: { id: string }; res: CloneRecord[] }
  /** Owner-bound directory picker; null when the user cancels. */
  'clones:selectDestination': { req: void; res: string | null }

  'cache:scan': { req: void; res: CacheReport }
  'cache:deleteRevisions': {
    req: { kind: RepoKind; repoId: string; commitHashes: string[] }
    res: CacheReport
  }
  'cache:cleanPartials': { req: { kind: RepoKind; repoId: string }; res: CacheReport }
  'cache:revealRepo': { req: { kind: RepoKind; repoId: string }; res: void }
  /**
   * Build an expiring main-owned prune/repair plan (plan Todo 15). Accepts ONLY
   * logical repo identity plus issue ids ("<issue>:<relativePath>") from the
   * verification report and optional 40-hex retained revisions — never a path
   * or a hash target. The response is sanitized: relative display paths only.
   * Absolute paths and expected hashes stay in a main-memory registry.
   */
  'cache:planAction': { req: { request: CacheActionPlanRequest }; res: CacheActionPlan }
  /**
   * Apply one plan by its unguessable ID (one-shot). Main revalidates expiry,
   * digest, the protected sets, and the filesystem BEFORE the first mutation;
   * every failure returns a typed result with zero changes.
   */
  'cache:applyAction': { req: { request: { planId: string } }; res: CacheActionResult }
  /**
   * Offline integrity verification (plan Todo 14/16). Progress streams on
   * `evt:cacheVerification`. Cancel is cooperative; an aborted run rejects
   * with message `aborted` and never implies Hub freshness was checked.
   */
  'cache:verify': { req: void; res: CacheVerificationReport }
  /** Abort the in-flight cache verification worker. */
  'cache:verifyCancel': { req: void; res: void }

  'follows:list': { req: void; res: Follow[] }
  'follows:add': { req: { type: FollowTargetType; target: string }; res: Follow[] }
  'follows:remove': { req: { id: string }; res: Follow[] }

  'inbox:list': { req: void; res: InboxItem[] }
  'inbox:markRead': { req: { ids: string[] }; res: InboxItem[] }
  'inbox:clear': { req: void; res: InboxItem[] }
  'inbox:pollNow': { req: void; res: { added: number } }

  'export:targets': { req: void; res: ExportTarget[] }
  'export:start': { req: { request: ExportStartRequest }; res: { id: string } }
  'export:cancel': { req: { id: string }; res: { canceled: boolean } }

  'upload:selectFolder': { req: void; res: UploadSelection | null }
  'upload:start': { req: { request: UploadStartRequest }; res: { id: string } }
  'upload:cancel': { req: { id: string }; res: { canceled: boolean } }
  'upload:retry': { req: { request: UploadRetryRequest }; res: { id: string } }
  'upload:remove': { req: { id: string }; res: { removed: boolean } }
  'upload:listPersisted': { req: void; res: UploadTaskRecord[] }
  'integrationTasks:list': { req: void; res: IntegrationTask[] }
  'integrationTasks:revealOutput': { req: { id: string }; res: void }

  'inference:run': { req: { request: InferenceRequest }; res: InferenceResult }
  /** Streams deltas through the `evt:inference` channel, correlated by id. */
  'inference:stream': { req: { id: string; request: InferenceRequest }; res: void }
  'inference:cancel': { req: { id: string }; res: void }

  'llm:get-status': { req: void; res: LlmStatus }
  'llm:set-credential': { req: { provider: LlmProvider; apiKey: string }; res: LlmStatus }
  'llm:delete-credential': { req: { provider: LlmProvider }; res: LlmStatus }
  'llm:test-connection': { req: LlmTestConnectionRequest; res: LlmTestConnectionResult }
  'llm:translate': { req: LlmTranslateRequest; res: LlmTranslateResult }
  'llm:cancel': { req: { requestId: string }; res: void }

  /**
   * Run every readiness probe once and return the bounded, redacted report.
   * Progress is pushed through `evt:diagnosticsProgress` (phase `run`); a
   * `diagnostics:cancel` aborts the in-flight run (remaining probes resolve
   * as canceled/unknown in the report).
   */
  'diagnostics:run': { req: void; res: DiagnosticReport }
  /** Abort the in-flight diagnostics run. */
  'diagnostics:cancel': { req: void; res: void }
  /**
   * Build and finalize a sanitized support-bundle ZIP via the native save
   * dialog. `res.path` is present only after successful finalization —
   * temp/partial archive paths never reach the renderer. Progress is pushed
   * through `evt:diagnosticsProgress` (phase `export`).
   */
  'diagnostics:export': { req: void; res: DiagnosticsExportResult }
  /** Abort an in-flight support-bundle export (cleans temp, no archive kept). */
  'diagnostics:exportCancel': { req: void; res: void }
}

export type IpcInvokeChannel = keyof IpcInvokeContract
export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeContract[C]['req']
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeContract[C]['res']

/** Push events, main → renderer. */
export interface IpcEventContract {
  'evt:downloads': DownloadTask[]
  'evt:clones': CloneRecord[]
  'evt:auth': AuthState
  'evt:inbox': { accountId: string | null; items: InboxItem[] }
  /** Ask the renderer to navigate to an in-app route (menu items, notification clicks). */
  'evt:navigate': string
  'evt:integrationTasks': IntegrationTask[]
  'evt:inference': InferenceStreamEvent
  /** Progress/cancel events for the diagnostics run and support-bundle export. */
  'evt:diagnosticsProgress': DiagnosticsProgress
  /** Offline cache verification progress (relative repo ids and counts only). */
  'evt:cacheVerification': CacheVerificationProgress
}

export type IpcEventChannel = keyof IpcEventContract
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C]

export const IPC_INVOKE_CHANNELS = [
  'system:getAppInfo',
  'system:openExternal',
  'settings:get',
  'settings:set',
  'settings:selectCacheDir',
  'settings:resetCacheDir',
  'settings:export',
  'settings:import',
  'privacy:clearLocalData',
  'network:testConnection',
  'compatibility:read',
  'compatibility:probe',
  'hub:search',
  'hub:papers',
  'hub:paper',
  'hub:repoDetail',
  'hub:readme',
  'hub:fileTree',
  'hub:discussions',
  'hub:discussionDiff',
  'hub:posts',
  'hub:recentActivity',
  'hub:postDetail',
  'hub:userOverview',
  'hub:userFollowing',
  'hub:orgMembers',
  'hub:discussionDetail',
  'hub:discussionComment',
  'hub:discussionCreate',
  'hub:notifications',
  'hub:notificationsMarkRead',
  'hub:notificationsClear',
  'hub:watchUpdate',
  'hub:watchList',
  'hub:watchSet',
  'hub:fileText',
  'hub:fileRange',
  'hub:safetensorsHeader',
  'hub:datasetSplits',
  'hub:datasetRows',
  'hub:datasetSampleRows',
  'dataset:exportPage',
  'hub:repoAccessGate',
  'hub:repoAccessAsk',
  'hub:searchUsers',
  'hub:searchOrgs',
  'hub:searchPapers',
  'hub:searchCollections',
  'hub:inferenceAvailable',
  'hub:collections',
  'hub:collection',
  'hub:collectionCreate',
  'hub:collectionUpdate',
  'hub:collectionDelete',
  'hub:collectionAddItem',
  'hub:collectionUpdateItem',
  'hub:collectionRemoveItem',
  'hub:myRepos',
  'hub:repoSettingsUpdate',
  'hub:repoMove',
  'hub:repoDelete',
  'hub:repoDuplicate',
  'hub:branchCreate',
  'hub:branchDelete',
  'hub:tagCreate',
  'hub:tagDelete',
  'hub:accessRequests',
  'hub:accessRequestHandle',
  'hub:accessRequestGrant',
  'hub:spaceSecrets',
  'hub:spaceSecretSet',
  'hub:spaceSecretDelete',
  'hub:spaceVariables',
  'hub:spaceVariableSet',
  'hub:spaceVariableDelete',
  'hub:spaceLogs',
  'hub:spaceRestart',
  'hub:spaceRuntime',
  'hub:spaceHardwareList',
  'hub:spacePause',
  'hub:spaceHardwareSet',
  'hub:spaceSleepTimeSet',
  'hub:likeSet',
  'hub:followSet',
  'hub:userLikes',
  'hub:postComment',
  'hub:postComments',
  'hub:postCommentHide',
  'hub:commentAssetUpload',
  'hub:postCommentReactionSet',
  'hub:postCanCreate',
  'hub:postCreate',
  'hub:profileGet',
  'hub:profileUpdate',
  'hub:postReactionSet',
  'hub:paperUpvoteSet',
  'hub:collectionUpvoteSet',
  'hub:discussionReactionSet',
  'hub:paperComment',
  'hub:paperComments',
  'hub:paperCommentReactionSet',
  'hub:prMerge',
  'hub:discussionStatusSet',
  'hub:discussionTitleSet',
  'hub:billingUsage',
  'auth:getState',
  'auth:listAccounts',
  'auth:signInWithToken',
  'auth:signOut',
  'auth:switchAccount',
  'auth:removeAccount',
  'auth:connectHubSession',
  'auth:disconnectHubSession',
  'auth:refreshUser',
  'favorites:list',
  'favorites:add',
  'favorites:remove',
  'history:list',
  'history:record',
  'history:clear',
  'downloads:list',
  'downloads:start',
  'downloads:plan',
  'downloads:startPlanned',
  'downloads:pause',
  'downloads:resume',
  'downloads:cancel',
  'downloads:remove',
  'downloads:pauseAll',
  'downloads:resumeAll',
  'downloads:clearCompleted',
  'downloads:reveal',
  'clones:list',
  'clones:get',
  'clones:create',
  'clones:cancel',
  'clones:retry',
  'clones:openDestination',
  'clones:remove',
  'clones:selectDestination',
  'cache:scan',
  'cache:deleteRevisions',
  'cache:cleanPartials',
  'cache:revealRepo',
  'cache:planAction',
  'cache:applyAction',
  'cache:verify',
  'cache:verifyCancel',
  'follows:list',
  'follows:add',
  'follows:remove',
  'inbox:list',
  'inbox:markRead',
  'inbox:clear',
  'inbox:pollNow',
  'export:targets',
  'export:start',
  'export:cancel',
  'upload:selectFolder',
  'upload:start',
  'upload:cancel',
  'upload:retry',
  'upload:remove',
  'upload:listPersisted',
  'integrationTasks:list',
  'integrationTasks:revealOutput',
  'inference:run',
  'inference:stream',
  'inference:cancel',
  'llm:get-status',
  'llm:set-credential',
  'llm:delete-credential',
  'llm:test-connection',
  'llm:translate',
  'llm:cancel',
  'diagnostics:run',
  'diagnostics:cancel',
  'diagnostics:export',
  'diagnostics:exportCancel'
] as const satisfies readonly IpcInvokeChannel[]

// Compile-time drift guard: every channel in the IpcInvokeChannels type map must
// be listed in IPC_INVOKE_CHANNELS, or the preload allowlist rejects it at runtime
// with "Unknown IPC channel". This errors if the array and the type ever diverge —
// the assignment fails to compile, naming the missing channel(s).
type MissingInvokeChannels = Exclude<IpcInvokeChannel, (typeof IPC_INVOKE_CHANNELS)[number]>
const _invokeChannelsExhaustive: [MissingInvokeChannels] extends [never]
  ? true
  : MissingInvokeChannels = true
void _invokeChannelsExhaustive

export const IPC_EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'evt:downloads',
  'evt:clones',
  'evt:auth',
  'evt:inbox',
  'evt:navigate',
  'evt:integrationTasks',
  'evt:inference',
  'evt:diagnosticsProgress',
  'evt:cacheVerification'
] as const

/** Shape of the API exposed on `window.hubfetch` by the preload script. */
export interface RendererApi {
  invoke<C extends IpcInvokeChannel>(channel: C, req: IpcRequest<C>): Promise<IpcResponse<C>>
  /** Subscribe to a push event; returns an unsubscribe function. */
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void
  ): () => void
  /**
   * Typed diagnostics surface exposed as `window.hubfetch.diagnostics.*`.
   * Every method delegates to the central validated invoke path — it is a
   * convenience namespace, never a bypass of sender validation.
   */
  diagnostics: DiagnosticsBridge
  /** Typed local-read and explicit-probe compatibility surface. */
  compatibility: CompatibilityBridge
  /**
   * Typed clone surface exposed as `window.hubfetch.clones.*`. Every method
   * delegates to the central validated invoke path (Zod + sender trust) — a
   * convenience namespace, never a bypass. Events stream through
   * `evt:clones`; `onClonesChanged` returns an unsubscribe function.
   */
  clones: CloneBridge
}

/**
 * Typed diagnostics bridge on the preload. All operations are cancellable and
 * stream progress through `evt:diagnosticsProgress`; the export result only
 * ever carries the final, fully finalized archive path.
 */
export interface DiagnosticsBridge {
  run(): Promise<DiagnosticReport>
  cancel(): Promise<void>
  /** Open the save dialog, export, and return the finalized path on success. */
  exportBundle(): Promise<DiagnosticsExportResult>
  cancelExport(): Promise<void>
  /** Subscribe to run/export progress; returns an unsubscribe function. */
  onProgress(listener: (progress: DiagnosticsProgress) => void): () => void
}

export interface CompatibilityBridge {
  read(): Promise<HubCapabilityStatus[]>
  probe(key: HubCapabilityKey): Promise<HubCapabilityStatus>
}

/**
 * Typed clone bridge on the preload. All methods are named and narrow; the
 * raw `ipcRenderer`, CloneManager, database, and native handles never reach
 * the renderer. `create`/`retry` accept ONLY validated repo fields plus a
 * closed proxy override — no raw URL, no token, and no status. Clone state
 * changes stream through `onClonesChanged` (subscribes to `evt:clones`).
 */
export interface CloneBridge {
  /** Every clone attempt in deterministic FIFO order (schema-valid records). */
  list(): Promise<CloneRecord[]>
  /** One attempt by id; null when it does not exist. */
  get(id: string): Promise<CloneRecord | null>
  /** Enqueue one new attempt; returns the queued record. */
  create(request: CloneRequest): Promise<CloneRecord>
  /** Cancel one attempt; returns the resulting list. */
  cancel(id: string): Promise<CloneRecord[]>
  /** Retry a terminal attempt with a fresh destination; returns the queued record. */
  retry(parentId: string, request: CloneRequest): Promise<CloneRecord>
  /** Open the recorded destination folder of one attempt (owner-bound). */
  openDestination(id: string): Promise<void>
  /** Remove one terminal queue record; returns the updated list. */
  remove(id: string): Promise<CloneRecord[]>
  /** Owner-bound directory picker; null when the user cancels. */
  selectDestination(): Promise<string | null>
  /** Subscribe to `evt:clones`; returns an unsubscribe function. */
  onClonesChanged(listener: (records: CloneRecord[]) => void): () => void
}
