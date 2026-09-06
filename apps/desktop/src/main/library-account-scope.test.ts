import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepoSummary } from '@hubfetch/shared'
import { MIGRATIONS } from './db'
import { Library } from './library'

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const migration of MIGRATIONS) db.exec(migration)
  return db
}

function makeLibrary(db: DatabaseSync, accountId: string | null): Library {
  return new Library(
    db as never,
    () => 200,
    () => accountId
  )
}

const summary: RepoSummary = {
  id: 'org/model',
  kind: 'model',
  author: 'org',
  name: 'model',
  likes: 1,
  downloads: 2,
  private: false,
  gated: false,
  tags: []
}

describe('Library account scope', () => {
  let db: DatabaseSync | undefined

  afterEach(() => db?.close())

  it('isolates follows and inbox rows while retaining device-global favorites/history', () => {
    db = makeDb()
    const accountA = makeLibrary(db, ACCOUNT_A)
    const accountB = makeLibrary(db, ACCOUNT_B)

    accountA.addFollow('user', 'alice')
    accountB.addFollow('user', 'alice')
    accountA.addInboxItem({
      kind: 'paper',
      title: 'A',
      body: 'A body',
      route: '/papers/a',
      dedupeKey: 'same'
    })
    accountB.addInboxItem({
      kind: 'paper',
      title: 'B',
      body: 'B body',
      route: '/papers/b',
      dedupeKey: 'same'
    })

    expect(accountA.listFollows().map((follow) => follow.target)).toEqual(['alice'])
    expect(accountB.listFollows().map((follow) => follow.target)).toEqual(['alice'])
    expect(accountA.listInbox().map((item) => item.title)).toEqual(['A'])
    expect(accountB.listInbox().map((item) => item.title)).toEqual(['B'])

    accountA.addFavorite(summary)
    accountA.recordHistory(summary)
    expect(accountB.listFavorites()).toHaveLength(1)
    expect(accountB.listHistory()).toHaveLength(1)
  })

  it('retains unclaimed legacy-local rows until the first account claims them', () => {
    db = makeDb()
    const legacy = makeLibrary(db, null)
    legacy.addFollow('papers', '')
    legacy.addInboxItem({
      kind: 'paper',
      title: 'legacy',
      body: 'legacy body',
      route: '/papers/legacy',
      dedupeKey: 'legacy'
    })

    expect(legacy.listFollows()).toHaveLength(1)
    expect(legacy.listInbox()).toHaveLength(1)

    db.prepare(
      "UPDATE follows SET account_id = ?, legacy_origin = 'v1-migrated' WHERE legacy_origin = 'legacy-local'"
    ).run(ACCOUNT_A)
    db.prepare(
      "UPDATE inbox SET account_id = ?, legacy_origin = 'v1-migrated' WHERE legacy_origin = 'legacy-local'"
    ).run(ACCOUNT_A)

    expect(makeLibrary(db, ACCOUNT_A).listFollows()).toHaveLength(1)
    expect(makeLibrary(db, null).listFollows()).toHaveLength(0)
    expect(makeLibrary(db, ACCOUNT_A).listInbox()).toHaveLength(1)
    expect(makeLibrary(db, null).listInbox()).toHaveLength(0)
  })
})
