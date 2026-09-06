import { describe, expect, it } from 'vitest'
import accountWhoami from './fixtures/account-whoami.json'
import collectionsList from './fixtures/collections-list.json'
import communityPosts from './fixtures/community-posts.json'
import datasets from './fixtures/datasets.json'
import datasetsServer from './fixtures/datasets-server.json'
import discussionsList from './fixtures/discussions-list.json'
import gatedAccess from './fixtures/gated-access.json'
import modelsList from './fixtures/models-list.json'
import notifications from './fixtures/notifications.json'
import papersList from './fixtures/papers-list.json'
import profilesOverview from './fixtures/profiles-overview.json'
import repositoryAdmin from './fixtures/repository-admin.json'
import spacesAdmin from './fixtures/spaces-admin.json'
import transportRedirect from './fixtures/transport-redirect.json'

describe('HubClient golden wire fixture inventory', () => {
  it('keeps one focused capture for every Hub domain', () => {
    const fixtures = [
      accountWhoami,
      collectionsList,
      communityPosts,
      datasets,
      datasetsServer,
      discussionsList,
      gatedAccess,
      modelsList,
      notifications,
      papersList,
      profilesOverview,
      repositoryAdmin,
      spacesAdmin,
      transportRedirect
    ]
    const domains = new Set(fixtures.map((fixture) => fixture.domain))
    expect(domains).toEqual(
      new Set([
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
      ])
    )
    for (const golden of fixtures) {
      expect(golden.response.status).toBeGreaterThanOrEqual(200)
      expect(golden.response.body).toBeDefined()
    }
  })
})
