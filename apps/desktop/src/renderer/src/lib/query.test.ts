import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { AuthState } from '@hubfetch/shared'
import {
  applyAuthStateChange,
  dropAccountPartition,
  isAccountBackedQuery,
  isHubRemoteQuery,
  refetchAccountPartition
} from './query'

const SIGNED_A: AuthState = {
  status: 'signedIn',
  accountId: 'acct-a',
  user: { name: 'alice', orgs: [] },
  method: 'token'
}

const SIGNED_B: AuthState = {
  status: 'signedIn',
  accountId: 'acct-b',
  user: { name: 'bob', orgs: [] },
  method: 'token'
}

function seedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  client.setQueryData(['repo', 'model', 'org/name', 'https://huggingface.co'], { id: 'from-a' })
  client.setQueryData(['hub-notifications', 0], { items: [] })
  client.setQueryData(['inbox', 'acct-a'], [{ id: 'in-a' }])
  client.setQueryData(['follows', 'acct-a'], [{ id: 'fol-a' }])
  client.setQueryData(['accounts-list'], [{ id: 'acct-a', active: true }])
  client.setQueryData(['favorites'], [{ repoId: 'kept' }])
  client.setQueryData(['history'], [{ repoId: 'kept-hist' }])
  client.setQueryData(['downloads'], [{ id: 'dl-1' }])
  return client
}

describe('isHubRemoteQuery', () => {
  it('identifies Hub-backed query families', () => {
    expect(isHubRemoteQuery(['repo', 'model', 'org/name'])).toBe(true)
    expect(isHubRemoteQuery(['hub-notifications', 0])).toBe(true)
    expect(isHubRemoteQuery(['fileText', 'model', 'org/name', 'README.md'])).toBe(true)
  })

  it('preserves local and application query families', () => {
    expect(isHubRemoteQuery(['downloads'])).toBe(false)
    expect(isHubRemoteQuery(['cache'])).toBe(false)
    expect(isHubRemoteQuery(['favorites'])).toBe(false)
    expect(isHubRemoteQuery(['history'])).toBe(false)
    expect(isHubRemoteQuery(['app-update'])).toBe(false)
  })
})

describe('isAccountBackedQuery', () => {
  it('includes Hub remote families and account-scoped library rows', () => {
    expect(isAccountBackedQuery(['user-overview', 'alice'])).toBe(true)
    expect(isAccountBackedQuery(['accounts-list'])).toBe(true)
    expect(isAccountBackedQuery(['inbox', 'acct-a'])).toBe(true)
    expect(isAccountBackedQuery(['follows', 'acct-a'])).toBe(true)
  })

  it('excludes device-global favorites, history, and appearance-adjacent families', () => {
    expect(isAccountBackedQuery(['favorites'])).toBe(false)
    expect(isAccountBackedQuery(['history'])).toBe(false)
    expect(isAccountBackedQuery(['downloads'])).toBe(false)
    expect(isAccountBackedQuery(['clones'])).toBe(false)
    expect(isAccountBackedQuery(['cache'])).toBe(false)
  })
})

describe('dropAccountPartition', () => {
  it('removes Hub and account-backed queries and remote mutations, keeping favorites and history', async () => {
    const client = seedClient()
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async () => undefined
    })
    await mutation.execute(undefined)

    dropAccountPartition(client)

    expect(client.getQueryData(['repo', 'model', 'org/name', 'https://huggingface.co'])).toBe(
      undefined
    )
    expect(client.getQueryData(['hub-notifications', 0])).toBe(undefined)
    expect(client.getQueryData(['inbox', 'acct-a'])).toBe(undefined)
    expect(client.getQueryData(['follows', 'acct-a'])).toBe(undefined)
    expect(client.getQueryData(['accounts-list'])).toBe(undefined)
    expect(client.getQueryData(['favorites'])).toEqual([{ repoId: 'kept' }])
    expect(client.getQueryData(['history'])).toEqual([{ repoId: 'kept-hist' }])
    expect(client.getQueryData(['downloads'])).toEqual([{ id: 'dl-1' }])
    expect(client.getMutationCache().getAll()).toEqual([])
  })
})

describe('applyAuthStateChange', () => {
  it('drops the partition only when accountId changes', () => {
    const client = seedClient()
    expect(applyAuthStateChange(client, SIGNED_A, SIGNED_A)).toBe(false)
    expect(client.getQueryData(['favorites'])).toEqual([{ repoId: 'kept' }])
    expect(client.getQueryData(['repo', 'model', 'org/name', 'https://huggingface.co'])).toEqual({
      id: 'from-a'
    })

    expect(applyAuthStateChange(client, SIGNED_A, SIGNED_B)).toBe(true)
    expect(client.getQueryData(['repo', 'model', 'org/name', 'https://huggingface.co'])).toBe(
      undefined
    )
    expect(client.getQueryData(['favorites'])).toEqual([{ repoId: 'kept' }])
    expect(client.getQueryData(['history'])).toEqual([{ repoId: 'kept-hist' }])
  })

  it('treats sign-out as an accountId change', () => {
    const client = seedClient()
    expect(applyAuthStateChange(client, SIGNED_A, { status: 'signedOut' })).toBe(true)
    expect(client.getQueryData(['inbox', 'acct-a'])).toBe(undefined)
    expect(client.getQueryData(['favorites'])).toEqual([{ repoId: 'kept' }])
  })
})

describe('refetchAccountPartition', () => {
  it('does not refetch Hub data during drop; favorites stay cached', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const hubFn = vi.fn(async () => ({ id: 'b' }))
    const favFn = vi.fn(async () => [{ repoId: 'kept' }])
    await client.fetchQuery({ queryKey: ['repo', 'x'], queryFn: hubFn })
    await client.fetchQuery({ queryKey: ['favorites'], queryFn: favFn })
    hubFn.mockClear()
    favFn.mockClear()

    dropAccountPartition(client)
    expect(hubFn).not.toHaveBeenCalled()
    expect(favFn).not.toHaveBeenCalled()
    expect(client.getQueryData(['repo', 'x'])).toBe(undefined)
    expect(client.getQueryData(['favorites'])).toEqual([{ repoId: 'kept' }])

    refetchAccountPartition(client)
    expect(favFn).not.toHaveBeenCalled()
  })
})
