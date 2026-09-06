import type { HubCapabilityKey, HubCapabilityStatus } from '@hubfetch/shared'

/** Local-only capability inventory read. */
export function readHubCapabilities(): Promise<HubCapabilityStatus[]> {
  return window.hubfetch.compatibility.read()
}

/** Explicit user-triggered capability probe through the active proxy. */
export function probeHubCapability(key: HubCapabilityKey): Promise<HubCapabilityStatus> {
  return window.hubfetch.compatibility.probe(key)
}
