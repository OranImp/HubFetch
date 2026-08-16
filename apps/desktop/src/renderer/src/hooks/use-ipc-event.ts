import { useEffect } from 'react'
import type { IpcEventChannel, IpcEventPayload } from '@hubfetch/shared'
import { onIpcEvent } from '@/lib/ipc'

export function useIpcEvent<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void
): void {
  useEffect(() => onIpcEvent(channel, listener), [channel, listener])
}
