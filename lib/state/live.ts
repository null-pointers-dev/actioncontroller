import { create } from 'zustand';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export const useLiveStatus = create<{ status: LiveStatus; set: (s: LiveStatus) => void }>((set) => ({
  status: 'connecting',
  set: (status) => set({ status }),
}));
