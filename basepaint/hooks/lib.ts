import type { BasepaintFeedRow, BasepaintPainter, BasepaintStats } from '../types'

export const EPOCH = 1691599315
export const DAY = 86400
export const FEED_LIMIT = 6

export const currentDay = (nowSec: number): number => Math.floor((nowSec - EPOCH) / DAY) + 1
export const dayEndsAt = (day: number): number => EPOCH + day * DAY

export const formatTimeLeft = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

export const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address

export const relativeTime = (nowSec: number, ts: number): string => {
  const d = Math.max(0, Math.floor(nowSec - ts))
  if (d < 5) return 'just now'
  if (d < 60) return `${d} seconds ago`
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (d < 3600) return plural(Math.floor(d / 60), 'minute')
  if (d < 86400) return plural(Math.floor(d / 3600), 'hour')
  return plural(Math.floor(d / 86400), 'day')
}

/** wei (decimal string) to a "$1.02" string, or "0.0024 ETH" without a price. */
export const formatEarned = (wei: string, ethUsd: number | null): string => {
  const eth = Number(wei) / 1e18
  if (!Number.isFinite(eth)) return '?'
  if (ethUsd === null || !Number.isFinite(ethUsd)) return `${eth.toFixed(4)} ETH`
  return `$${(eth * ethUsd).toFixed(2)}`
}

export const rowText = (row: BasepaintFeedRow, ethUsd: number | null): string =>
  row.kind === 'stroke'
    ? `painted ${row.pixels ?? 0} pixels`
    : `earned ${formatEarned(row.wei ?? '0', ethUsd)}`

type Item = Record<string, unknown>
const items = (v: unknown): Item[] => {
  const list = (v as { items?: unknown } | null | undefined)?.items
  return Array.isArray(list) ? (list as Item[]) : []
}

/** Merge the GraphQL withdrawals and strokes into one newest-first list. */
export const mergeFeed = (data: unknown, limit = FEED_LIMIT): BasepaintFeedRow[] => {
  const d = (data ?? {}) as { withdrawals?: unknown; strokes?: unknown }
  const rows: BasepaintFeedRow[] = []
  for (const w of items(d.withdrawals)) {
    if (typeof w.accountId !== 'string' || typeof w.timestamp !== 'number') continue
    rows.push({
      id: `withdrawal:${w.accountId}:${w.timestamp}`,
      kind: 'withdrawal',
      address: w.accountId,
      timestamp: w.timestamp,
      wei: String(w.amount ?? '0'),
    })
  }
  for (const s of items(d.strokes)) {
    if (typeof s.accountId !== 'string' || typeof s.timestamp !== 'number') continue
    rows.push({
      id: `stroke:${s.accountId}:${s.timestamp}`,
      kind: 'stroke',
      address: s.accountId,
      timestamp: s.timestamp,
      pixels: Number(s.pixels ?? 0),
    })
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
}

export const FEED_QUERY =
  'query LiveFeed($limit: Int!) { withdrawals(orderBy: "timestamp", orderDirection: "desc", limit: $limit) { items { timestamp accountId amount } } strokes(orderBy: "timestamp", orderDirection: "desc", limit: $limit) { items { timestamp accountId pixels } } }'

export const resolveNameUrl = (address: string): string =>
  `https://basepaint.xyz/api/trpc/user.resolveName?input=${encodeURIComponent(JSON.stringify({ json: { address } }))}`

export const parseName = (text: string): string | null => {
  const v = (JSON.parse(text) as { result?: { data?: { json?: unknown } } }).result?.data?.json
  return typeof v === 'string' && v.length > 0 ? v : null
}

export const NAME_TTL_MS = 7 * 86400 * 1000
export type NameCache = Record<string, { name: string; at: number }>

export const STATS_QUERY =
  'query Day($id: Int!) { canvas(id: $id) { totalArtists pixelsCount totalMints totalEarned } }'

/** Uniform random integer in [1, today - 1] (1 when there is no past day yet). */
export const pickRandomDay = (today: number, rand: () => number = Math.random): number =>
  today <= 2 ? 1 : 1 + Math.floor(rand() * (today - 1))

export type ModeArg =
  | { kind: 'toggle' }
  | { kind: 'today' }
  | { kind: 'random' }
  | { kind: 'number'; day: number }
  | { kind: 'invalid'; reason: string }

export const parseModeArg = (args: string): ModeArg => {
  const a = args.trim().toLowerCase()
  if (a === '') return { kind: 'toggle' }
  if (a === 'today' || a === 'random') return { kind: a }
  if (/^\d+$/.test(a)) return { kind: 'number', day: Number(a) }
  return { kind: 'invalid', reason: `unknown argument "${args.trim()}" (use today, random or a day number)` }
}

export const parseStats = (data: unknown): BasepaintStats | null => {
  const c = (data as { canvas?: Record<string, unknown> | null } | null | undefined)?.canvas
  if (!c) return null
  return {
    artists: Number(c.totalArtists ?? 0),
    pixels: Number(c.pixelsCount ?? 0),
    mints: Number(c.totalMints ?? 0),
    earnedWei: String(c.totalEarned ?? '0'),
  }
}

export const formatEth = (wei: string): string => {
  const eth = Number(wei) / 1e18
  return Number.isFinite(eth) ? `${eth.toFixed(3)} ETH` : '?'
}

export const formatStatsLine = (day: number, s: BasepaintStats | null): string =>
  s
    ? `day ${day} · ${s.artists.toLocaleString('en-US')} artists · ${s.pixels.toLocaleString('en-US')} pixels · ${s.mints.toLocaleString('en-US')} mints · ${formatEth(s.earnedWei)}`
    : `day ${day}`

export const TOP_QUERY =
  'query Top($id: Int!) { contributions(where: {canvasId: $id}, orderBy: "pixelsCount", orderDirection: "desc", limit: 6) { items { accountId pixelsCount } } }'

export const parseTop = (data: unknown, limit = FEED_LIMIT): BasepaintPainter[] => {
  const out: BasepaintPainter[] = []
  for (const it of items((data as { contributions?: unknown } | null | undefined)?.contributions)) {
    if (typeof it.accountId !== 'string') continue
    const pixels = Number(it.pixelsCount ?? 0)
    if (Number.isFinite(pixels)) out.push({ address: it.accountId, pixels })
  }
  return out.slice(0, limit)
}

export const formatPainted = (pixels: number): string => `painted ${pixels.toLocaleString('en-US')} pixels`

/** Share of the day's pixels as "4.9%", or "" without a usable total. */
export const formatShare = (pixels: number, total: number | undefined): string =>
  total && total > 0 ? `${((pixels / total) * 100).toFixed(1)}%` : ''
