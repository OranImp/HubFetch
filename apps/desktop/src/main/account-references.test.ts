import { describe, expect, it, vi } from 'vitest'
import { AccountReferenceCoordinator } from './account-references'

describe('AccountReferenceCoordinator', () => {
  it('counts active references by account and cancels only that account', () => {
    const coordinator = new AccountReferenceCoordinator()
    const unavailableA = vi.fn()
    const unavailableB = vi.fn()
    const releaseA = coordinator.register('account-a', 'download', 'a', unavailableA)
    coordinator.register('account-a', 'upload', 'u', unavailableA)
    coordinator.register('account-b', 'clone', 'b', unavailableB)

    expect(coordinator.usage('account-a')).toEqual({ downloads: 1, clones: 0, uploads: 1 })
    expect(coordinator.usage('account-b')).toEqual({ downloads: 0, clones: 1, uploads: 0 })

    coordinator.markUnavailable(['account-a'])

    expect(unavailableA).toHaveBeenCalledTimes(2)
    expect(unavailableB).not.toHaveBeenCalled()
    releaseA()
    expect(coordinator.usage('account-a')).toEqual({ downloads: 0, clones: 0, uploads: 1 })
  })
})
