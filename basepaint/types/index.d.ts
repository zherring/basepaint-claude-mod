export type BasepaintFeedRow = {
  id: string
  kind: 'stroke' | 'withdrawal'
  address: string
  timestamp: number
  /** stroke: pixels painted */
  pixels?: number
  /** withdrawal: amount in wei, as the API's decimal string */
  wei?: string
}

export type BasepaintStats = {
  artists: number
  pixels: number
  mints: number
  /** total earned in wei, as the API's decimal string */
  earnedWei: string
}

export type BasepaintPainter = {
  address: string
  pixels: number
}

export type BasepaintImage = {
  /** absolute path of the last good PNG, or null before the first download */
  path: string | null
  /** bumped on every successful download so the terminal re-reads the file */
  generation: number
  /** true while the latest download attempt failed */
  isOffline: boolean
}

declare module 'claude-code' {
  interface PluginState {
    basepaint: {
      day: number
      /** epoch seconds at which `day` ends */
      dayEndsAt: number
      theme: string | null
      proposer: string | null
      palette: string[]
      image: BasepaintImage
      /** 0 while showing today's live canvas, else the past day on display */
      viewDay: number
      /** stats of `viewDay`, or null while loading / when showing today */
      stats: BasepaintStats | null
      /** the session's `/basepaint` mode override; null defers to the config */
      modeOverride: string | null
      feed: BasepaintFeedRow[]
      /** top painters of `viewDay` (most pixels first); empty in today mode */
      topPainters: BasepaintPainter[]
      /** true when the latest leaderboard fetch failed */
      topFailed: boolean
      /** lowercased address -> display name (or shortened address) */
      names: Record<string, string>
      ethUsd: number | null
      online: number | null
      isPinned: boolean
      isOpen: boolean
      lastError: string | null
    }
  }
}
