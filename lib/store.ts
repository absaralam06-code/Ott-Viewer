import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MediaKind } from './types'

interface AppState {
  /* Active playlist id persisted across sessions */
  activePlaylistId: string | null
  setActivePlaylistId: (id: string | null) => void

  /* Live browser filters */
  selectedKind: MediaKind
  setSelectedKind: (kind: MediaKind) => void

  selectedGroup: string | null
  setSelectedGroup: (group: string | null) => void

  favoritesOnly: boolean
  setFavoritesOnly: (v: boolean) => void

  search: string
  setSearch: (s: string) => void

  /* Player prefs */
  volume: number
  setVolume: (v: number) => void

  muted: boolean
  setMuted: (v: boolean) => void

  /* Sidebar open on mobile */
  sidebarOpen: boolean
  setSidebarOpen: (v: boolean) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      activePlaylistId: null,
      setActivePlaylistId: (id) => set({ activePlaylistId: id }),

      selectedKind: 'live',
      setSelectedKind: (kind) => set({ selectedKind: kind, selectedGroup: null, search: '' }),

      selectedGroup: null,
      setSelectedGroup: (group) => set({ selectedGroup: group }),

      favoritesOnly: false,
      setFavoritesOnly: (v) => set({ favoritesOnly: v }),

      search: '',
      setSearch: (s) => set({ search: s }),

      volume: 1,
      setVolume: (v) => set({ volume: v }),

      muted: false,
      setMuted: (v) => set({ muted: v }),

      sidebarOpen: false,
      setSidebarOpen: (v) => set({ sidebarOpen: v }),
    }),
    {
      name: 'ott-app-store',
      partialize: (s) => ({
        activePlaylistId: s.activePlaylistId,
        volume: s.volume,
        muted: s.muted,
      }),
    },
  ),
)
