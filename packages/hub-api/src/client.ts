import type { AccessRequest, ActivityFeed, BillingUsage, CanPostResult, CollectionDetail, CollectionSearchResult, CollectionSummary, DatasetRows, DatasetSplit, DiscussionDetail, DiscussionStatusFilter, DiscussionSummary, DiscussionType, FileTextResult, FileTreeEntry, FollowedAccount, HubProfileSettings, HubProfileUpdate, MyRepoEntry, NotificationsPage, OrgSearchResult, Page, PaperSearchResult, PaperSummary, PostComment, PostSummary, RepoAccessGate, RepoDetail, RepoKind, RepoSummary, SafetensorsHeader, SearchQuery, SpaceHardwareCatalogEntry, SpaceHardwareFlavor, SpaceRuntime, SpaceSecret, SpaceVariable, UserOverview, UserProfile, UserSearchResult, WatchedEntry } from '@hubfetch/shared'
import { HubTransport } from './core/transport'
import { DEFAULT_ENDPOINT } from './constants'
import * as auth from './domains/auth'
import * as collections from './domains/collections'
import * as community from './domains/community'
import * as datasets from './domains/datasets'
import * as discussions from './domains/discussions'
import * as profiles from './domains/profiles'
import * as reposRead from './domains/repos-read'
import * as reposWrite from './domains/repos-write'
import * as spaces from './domains/spaces'

export { formatSessionCookie } from './core/endpoint-auth'
export { API_PATH, DATASETS_SERVER, DEFAULT_ENDPOINT, RESOLVE_PREFIX } from './constants'
import type { WhoAmIDetailed } from './mappers'

export interface HubClientOptions {
  endpoint?: string
  userAgent?: string
  fetchImpl?: typeof fetch
  cacheTtlMs?: number
  maxConcurrent?: number
  minRequestGapMs?: number
  maxRetries?: number
  getAccessToken?: () => string | undefined
  getSessionCookie?: () => string | undefined
}

type GatedRepoKind = Extract<RepoKind, 'model' | 'dataset'>

interface WatchTarget {
  id: string
  type: 'user' | 'org'
}

export class HubClient {
  private readonly endpoint: string
  private readonly transport: HubTransport

  constructor(options: HubClientOptions = {}) {
    this.transport = new HubTransport({
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      userAgent: options.userAgent ?? 'HubFetch (unofficial desktop client)',
      fetchImpl: options.fetchImpl ?? fetch,
      cacheTtlMs: options.cacheTtlMs ?? 30_000,
      maxConcurrent: Math.max(1, options.maxConcurrent ?? 4),
      minRequestGapMs: Math.max(0, options.minRequestGapMs ?? 120),
      maxRetries: Math.max(0, options.maxRetries ?? 2),
      getAccessToken: options.getAccessToken ?? (() => undefined),
      getSessionCookie: options.getSessionCookie ?? (() => undefined)
    })
    this.endpoint = this.transport.endpoint
  }

  get baseUrl(): string { return this.endpoint }

  invalidateCache(): void { this.transport.invalidateCache() }

  buildSearchUrl(query: SearchQuery): string { return reposRead.buildSearchUrl(this.transport, query) }

  async searchRepos(query: SearchQuery): Promise<Page<RepoSummary>> { return reposRead.searchRepos(this.transport, query) }

  async getRepoDetail(kind: RepoKind, repoId: string, revision?: string): Promise<RepoDetail> { return reposRead.getRepoDetail(this.transport, kind, repoId, revision) }

  resolveUrl(kind: RepoKind, repoId: string, revision: string, path: string): string { return reposRead.resolveUrl(this.transport, kind, repoId, revision, path) }

  async getReadme(kind: RepoKind, repoId: string, revision = 'main'): Promise<string> { return reposRead.getReadme(this.transport, kind, repoId, revision) }

  async getFileTree(kind: RepoKind, repoId: string, revision = 'main', path = '', opts: { recursive?: boolean } = {}): Promise<FileTreeEntry[]> { return reposRead.getFileTree(this.transport, kind, repoId, revision, path, opts) }

  async getDailyPapers(cursor?: string): Promise<Page<PaperSummary>> { return community.getDailyPapers(this.transport, cursor) }

  async getPaper(paperId: string): Promise<PaperSummary> { return community.getPaper(this.transport, paperId) }

  async getPaperComments(paperId: string): Promise<PostComment[]> { return community.getPaperComments(this.transport, paperId) }

  async listDiscussions(kind: RepoKind, repoId: string, opts: { type?: DiscussionType; status?: DiscussionStatusFilter; cursor?: string } = {}): Promise<Page<DiscussionSummary>> { return discussions.listDiscussions(this.transport, kind, repoId, opts) }

  async getDiscussionDiff(kind: RepoKind, repoId: string, num: number): Promise<string> { return discussions.getDiscussionDiff(this.transport, kind, repoId, num) }

  async getPosts(cursor?: string): Promise<Page<PostSummary>> { return community.getPosts(this.transport, cursor) }

  async getRecentActivity(cursor?: string): Promise<ActivityFeed> { return community.getRecentActivity(this.transport, cursor) }

  async getDiscussion(kind: RepoKind, repoId: string, num: number): Promise<DiscussionDetail> { return discussions.getDiscussion(this.transport, kind, repoId, num) }

  async commentOnDiscussion(kind: RepoKind, repoId: string, num: number, comment: string): Promise<void> { return discussions.commentOnDiscussion(this.transport, kind, repoId, num, comment) }

  async createDiscussion(kind: RepoKind, repoId: string, title: string, description: string, pullRequest = false): Promise<{ num: number }> { return discussions.createDiscussion(this.transport, kind, repoId, title, description, pullRequest) }

  async whoAmI(): Promise<UserProfile> { return auth.whoAmI(this.transport) }

  async whoAmIWithToken(token: string, opts: { timeoutMs?: number } = {}): Promise<WhoAmIDetailed> { return auth.whoAmIWithToken(this.transport, token, opts) }

  async whoAmIWithCookie(cookie: string, opts: { timeoutMs?: number } = {}): Promise<WhoAmIDetailed> { return auth.whoAmIWithCookie(this.transport, cookie, opts) }

  async getNotifications(page = 0): Promise<NotificationsPage> { return community.getNotifications(this.transport, page) }

  async markNotificationsRead(discussionIds: string[], read: boolean): Promise<void> { return community.markNotificationsRead(this.transport, discussionIds, read) }

  async clearNotifications(): Promise<void> { return community.clearNotifications(this.transport) }

  async listByAuthor(kind: RepoKind, author: string, limit = 20): Promise<RepoSummary[]> { return reposRead.listByAuthor(this.transport, kind, author, limit) }

  async getFileText(kind: RepoKind, repoId: string, path: string, revision = 'main', maxBytes = 512 * 1024): Promise<FileTextResult> { return reposRead.getFileText(this.transport, kind, repoId, path, revision, maxBytes) }

  async fetchFileResponse(kind: RepoKind, repoId: string, path: string, revision = 'main'): Promise<Response> { return reposRead.fetchFileResponse(this.transport, kind, repoId, path, revision) }

  async fetchFileRange(kind: RepoKind, repoId: string, path: string, start: number, end: number, revision = 'main'): Promise<Uint8Array> { return datasets.fetchFileRange(this.transport, kind, repoId, path, start, end, revision) }

  async getSafetensorsHeader(kind: RepoKind, repoId: string, path: string, revision = 'main'): Promise<SafetensorsHeader> { return reposRead.getSafetensorsHeader(this.transport, kind, repoId, path, revision) }

  async getRepoAccessGate(kind: RepoKind, repoId: string): Promise<RepoAccessGate> { return reposWrite.getRepoAccessGate(this.transport, kind, repoId) }

  async askRepoAccess(kind: RepoKind, repoId: string, fields: Record<string, string>): Promise<void> { return reposWrite.askRepoAccess(this.transport, kind, repoId, fields) }

  async getDatasetSampleRows(repoId: string): Promise<DatasetRows | undefined> { return datasets.getDatasetSampleRows(this.transport, repoId) }

  async getDatasetSplits(repoId: string): Promise<DatasetSplit[]> { return datasets.getDatasetSplits(this.transport, repoId) }

  async getDatasetRows(repoId: string, config: string, split: string, offset = 0, length = 20): Promise<DatasetRows> { return datasets.getDatasetRows(this.transport, repoId, config, split, offset, length) }

  async getPostDetail(author: string, slug: string): Promise<PostSummary> { return community.getPostDetail(this.transport, author, slug) }

  async getUserOverview(username: string): Promise<UserOverview> { return profiles.getUserOverview(this.transport, username) }

  async getOrgMembers(org: string, limit = 40): Promise<FollowedAccount[]> { return profiles.getOrgMembers(this.transport, org, limit) }

  async getUserFollowing(username: string): Promise<FollowedAccount[]> { return profiles.getUserFollowing(this.transport, username) }

  async searchUsers(query: string): Promise<UserSearchResult[]> { return profiles.searchUsers(this.transport, query) }

  async searchOrgs(query: string): Promise<OrgSearchResult[]> { return profiles.searchOrgs(this.transport, query) }

  async searchPapers(query: string): Promise<PaperSearchResult[]> { return community.searchPapers(this.transport, query) }

  async searchCollections(query: string): Promise<CollectionSearchResult[]> { return collections.searchCollections(this.transport, query) }

  async isInferenceAvailable(repoId: string): Promise<boolean> { return reposRead.isInferenceAvailable(this.transport, repoId) }

  async listCollections(owner: string): Promise<CollectionSummary[]> { return collections.listCollections(this.transport, owner) }

  async getCollection(slug: string): Promise<CollectionDetail> { return collections.getCollection(this.transport, slug) }

  async createCollection(input: { namespace: string; title: string; description?: string; private: boolean }): Promise<CollectionDetail> { return collections.createCollection(this.transport, input) }

  async updateCollection(slug: string, patch: { title?: string; description?: string; private?: boolean; position?: number; theme?: string }): Promise<void> { return collections.updateCollection(this.transport, slug, patch) }

  async deleteCollection(slug: string): Promise<void> { return collections.deleteCollection(this.transport, slug) }

  async addCollectionItem(slug: string, item: { type: 'model' | 'dataset' | 'space' | 'paper'; id: string }, note?: string): Promise<void> { return collections.addCollectionItem(this.transport, slug, item, note) }

  async updateCollectionItem(slug: string, itemId: string, patch: { note?: string; position?: number }): Promise<void> { return collections.updateCollectionItem(this.transport, slug, itemId, patch) }

  async removeCollectionItem(slug: string, itemId: string): Promise<void> { return collections.removeCollectionItem(this.transport, slug, itemId) }

  async updateWatch(changes: { add?: WatchTarget[]; delete?: WatchTarget[] }): Promise<WatchedEntry[]> { return community.updateWatch(this.transport, changes) }

  async listWatched(): Promise<WatchedEntry[]> { return community.listWatched(this.transport) }

  async setWatch(target: WatchTarget, watching: boolean): Promise<{ applied: boolean; watched: WatchedEntry[] }> { return community.setWatch(this.transport, target, watching) }

  async listMyRepos(): Promise<MyRepoEntry[]> { return reposWrite.listMyRepos(this.transport) }

  async updateRepoSettings(kind: RepoKind, repoId: string, patch: { private?: boolean; gated?: false | 'auto' | 'manual'; discussionsDisabled?: boolean }): Promise<void> { return reposWrite.updateRepoSettings(this.transport, kind, repoId, patch) }

  async moveRepo(kind: RepoKind, fromRepo: string, toRepo: string): Promise<void> { return reposWrite.moveRepo(this.transport, kind, fromRepo, toRepo) }

  async deleteRepo(kind: RepoKind, repoId: string): Promise<void> { return reposWrite.deleteRepo(this.transport, kind, repoId) }

  async duplicateSpace(repoId: string, toRepo: string, options: { private?: boolean } = {}): Promise<{ url?: string }> { return reposWrite.duplicateSpace(this.transport, repoId, toRepo, options) }

  async createBranch(kind: RepoKind, repoId: string, branch: string, startingPoint?: string): Promise<void> { return reposWrite.createBranch(this.transport, kind, repoId, branch, startingPoint) }

  async deleteBranch(kind: RepoKind, repoId: string, branch: string): Promise<void> { return reposWrite.deleteBranch(this.transport, kind, repoId, branch) }

  async createTag(kind: RepoKind, repoId: string, tag: string, revision = 'main', message?: string): Promise<void> { return reposWrite.createTag(this.transport, kind, repoId, tag, revision, message) }

  async deleteTag(kind: RepoKind, repoId: string, tag: string): Promise<void> { return reposWrite.deleteTag(this.transport, kind, repoId, tag) }

  async listAccessRequests(kind: GatedRepoKind, repoId: string, status: 'pending' | 'accepted' | 'rejected'): Promise<AccessRequest[]> { return reposWrite.listAccessRequests(this.transport, kind, repoId, status) }

  async handleAccessRequest(kind: GatedRepoKind, repoId: string, user: string, status: 'accepted' | 'rejected' | 'pending', rejectionReason?: string): Promise<void> { return reposWrite.handleAccessRequest(this.transport, kind, repoId, user, status, rejectionReason) }

  async grantAccess(kind: GatedRepoKind, repoId: string, user: string): Promise<void> { return reposWrite.grantAccess(this.transport, kind, repoId, user) }

  async listSpaceSecrets(repoId: string): Promise<SpaceSecret[]> { return spaces.listSpaceSecrets(this.transport, repoId) }

  async setSpaceSecret(repoId: string, key: string, value: string, description?: string): Promise<void> { return spaces.setSpaceSecret(this.transport, repoId, key, value, description) }

  async deleteSpaceSecret(repoId: string, key: string): Promise<void> { return spaces.deleteSpaceSecret(this.transport, repoId, key) }

  async listSpaceVariables(repoId: string): Promise<SpaceVariable[]> { return spaces.listSpaceVariables(this.transport, repoId) }

  async setSpaceVariable(repoId: string, key: string, value: string, description?: string): Promise<void> { return spaces.setSpaceVariable(this.transport, repoId, key, value, description) }

  async deleteSpaceVariable(repoId: string, key: string): Promise<void> { return spaces.deleteSpaceVariable(this.transport, repoId, key) }

  async getSpaceLogsSnapshot(repoId: string, logType: 'build' | 'run'): Promise<{ text: string }> { return spaces.getSpaceLogsSnapshot(this.transport, repoId, logType) }

  async restartSpace(repoId: string, factory = false): Promise<void> { return spaces.restartSpace(this.transport, repoId, factory) }

  async getSpaceRuntime(repoId: string): Promise<SpaceRuntime> { return spaces.getSpaceRuntime(this.transport, repoId) }

  async listSpaceHardware(): Promise<SpaceHardwareCatalogEntry[]> { return spaces.listSpaceHardware(this.transport) }

  async pauseSpace(repoId: string): Promise<void> { return spaces.pauseSpace(this.transport, repoId) }

  async requestSpaceHardware(repoId: string, flavor: SpaceHardwareFlavor, sleepTimeSeconds?: number): Promise<void> { return spaces.requestSpaceHardware(this.transport, repoId, flavor, sleepTimeSeconds) }

  async setSpaceSleepTime(repoId: string, seconds: number): Promise<void> { return spaces.setSpaceSleepTime(this.transport, repoId, seconds) }

  async setLike(kind: RepoKind, repoId: string, liked: boolean): Promise<void> { return community.setLike(this.transport, kind, repoId, liked) }

  async setFollow(username: string, following: boolean, isOrg = false): Promise<void> { return community.setFollow(this.transport, username, following, isOrg) }

  async getUserLikes(username: string): Promise<RepoSummary[]> { return community.getUserLikes(this.transport, username) }

  async commentOnPost(author: string, slug: string, comment: string, replyToCommentId?: string): Promise<void> { return community.commentOnPost(this.transport, author, slug, comment, replyToCommentId) }

  async setPostReaction(author: string, slug: string, reaction: string, active: boolean): Promise<void> { return community.setPostReaction(this.transport, author, slug, reaction, active) }

  async setPostCommentReaction(author: string, slug: string, commentId: string, reaction: string, active: boolean): Promise<void> { return community.setPostCommentReaction(this.transport, author, slug, commentId, reaction, active) }

  async hidePostComment(author: string, slug: string, commentId: string, reason?: string): Promise<void> { return community.hidePostComment(this.transport, author, slug, commentId, reason) }

  async uploadCommentAsset(data: Uint8Array, contentType: string): Promise<string> { return community.uploadCommentAsset(this.transport, data, contentType) }

  async getProfileSettings(): Promise<HubProfileSettings> { return profiles.getProfileSettings(this.transport) }

  async updateProfileSettings(update: HubProfileUpdate): Promise<void> { return profiles.updateProfileSettings(this.transport, update) }

  async getPostComments(author: string, slug: string): Promise<PostComment[]> { return community.getPostComments(this.transport, author, slug) }

  async canCreatePost(): Promise<CanPostResult> { return community.canCreatePost(this.transport) }

  async createPost(content: string): Promise<{ slug?: string }> { return community.createPost(this.transport, content) }

  async setPaperUpvote(paperId: string, upvoted: boolean): Promise<void> { return community.setPaperUpvote(this.transport, paperId, upvoted) }

  async setCollectionUpvote(slug: string, upvoted: boolean): Promise<void> { return community.setCollectionUpvote(this.transport, slug, upvoted) }

  async setDiscussionCommentReaction(kind: RepoKind, repoId: string, num: number, commentId: string, reaction: string, active: boolean): Promise<void> { return discussions.setDiscussionCommentReaction(this.transport, kind, repoId, num, commentId, reaction, active) }

  async commentOnPaper(paperId: string, comment: string, replyToCommentId?: string): Promise<void> { return community.commentOnPaper(this.transport, paperId, comment, replyToCommentId) }

  async setPaperCommentReaction(paperId: string, commentId: string, reaction: string, active: boolean): Promise<void> { return community.setPaperCommentReaction(this.transport, paperId, commentId, reaction, active) }

  async mergePullRequest(kind: RepoKind, repoId: string, num: number, comment?: string): Promise<void> { return discussions.mergePullRequest(this.transport, kind, repoId, num, comment) }

  async setDiscussionStatus(kind: RepoKind, repoId: string, num: number, status: 'open' | 'closed', comment?: string): Promise<void> { return discussions.setDiscussionStatus(this.transport, kind, repoId, num, status, comment) }

  async setDiscussionTitle(kind: RepoKind, repoId: string, num: number, title: string): Promise<void> { return discussions.setDiscussionTitle(this.transport, kind, repoId, num, title) }

  async getBillingUsage(): Promise<BillingUsage> { return auth.getBillingUsage(this.transport) }
}
