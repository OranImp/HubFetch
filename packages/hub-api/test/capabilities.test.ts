import { describe, expect, it } from 'vitest'
import {
  HUB_CAPABILITIES,
  HUB_SHARED_CAPABILITY_KEYS_ARE_EXHAUSTIVE,
  HUB_CAPABILITY_CLASSES,
  HUB_CAPABILITY_DEGRADATIONS,
  type HubCapabilityClass,
  type HubCapabilityDegradation,
  type HubCapabilityDomain
} from '../src/capabilities'
import {
  HUB_CAPABILITY_KEYS,
  HUB_CAPABILITY_ERROR_CODES,
  hubCapabilityErrorCodeSchema,
  hubCapabilityStatusSchema,
  hubCapabilityStatusesSchema,
  type HubCapabilityStatus
} from '@hubfetch/shared'

describe('HubClient capability registry', () => {
  it('contains only declared capability metadata values', () => {
    const classes: readonly HubCapabilityClass[] = HUB_CAPABILITY_CLASSES
    const degradations: readonly HubCapabilityDegradation[] = HUB_CAPABILITY_DEGRADATIONS

    for (const entry of Object.values(HUB_CAPABILITIES)) {
      expect(classes).toContain(entry.class)
      expect(typeof entry.domain).toBe('string')
      expect(degradations).toContain(entry.degradation)
    }
    expect(Object.keys(HUB_CAPABILITIES)).toHaveLength(100)
    expect(new Set(Object.keys(HUB_CAPABILITIES))).toEqual(new Set(HUB_CAPABILITY_KEYS))
    expect(HUB_SHARED_CAPABILITY_KEYS_ARE_EXHAUSTIVE).toBe(true)
    expect(new Set(Object.values(HUB_CAPABILITIES).map((entry) => entry.class))).toEqual(
      new Set(classes)
    )
  })

  it('has a stable domain inventory for drift reports', () => {
    const domains = new Set<HubCapabilityDomain>(
      Object.values(HUB_CAPABILITIES).map((entry) => entry.domain)
    )
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
  })

  it('accepts only secret-free public capability status records', () => {
    const status: HubCapabilityStatus = {
      key: 'searchRepos',
      sourceClass: 'official-public',
      domain: 'models',
      status: 'available',
      lastCheckedAt: '2026-09-05T00:00:00.000Z'
    }
    expect(hubCapabilityStatusSchema.safeParse(status).success).toBe(true)
    expect(
      hubCapabilityStatusesSchema.safeParse(
        HUB_CAPABILITY_KEYS.map((key) => ({
          key,
          sourceClass: HUB_CAPABILITIES[key].class,
          domain: HUB_CAPABILITIES[key].domain,
          status: 'available',
          lastCheckedAt: '2026-09-05T00:00:00.000Z'
        }))
      ).success
    ).toBe(true)
    expect(
      hubCapabilityStatusSchema.safeParse({
        ...status,
        token: 'secret',
        lastCheckedAt: '2026-09-05T00:00:00.000Z'
      }).success
    ).toBe(false)
    for (const code of HUB_CAPABILITY_ERROR_CODES) {
      expect(hubCapabilityErrorCodeSchema.safeParse(code).success).toBe(true)
    }
    expect(hubCapabilityErrorCodeSchema.safeParse('available').success).toBe(false)
  })
})
