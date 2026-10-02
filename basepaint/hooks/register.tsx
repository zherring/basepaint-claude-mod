import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BasepaintFeedRow } from '../types'
import {
  FEED_LIMIT,
  FEED_QUERY,
  NAME_TTL_MS,
  currentDay,
  dayEndsAt,
  formatPainted,
  formatShare,
  formatStatsLine,
  formatTimeLeft,
  pickRandomDay,
  parseModeArg,
  parseStats,
  parseTop,
  TOP_QUERY,
  STATS_QUERY,
  mergeFeed,
  parseName,
  relativeTime,
  resolveNameUrl,
  rowText,
  shortAddress,
} from './lib'
import type { NameCache } from './lib'

const PANE = 'basepaint'
let cacheDirMemo: string | null = null
const cacheDir = async ($: EngineInterface): Promise<string> => {
  if (cacheDirMemo === null) {
    const tmp = String((await $.env.get('TMPDIR')) ?? '').replace(/\/+$/, '')
    cacheDirMemo = `${tmp || '/tmp'}/claude-basepaint`
  }
  return cacheDirMemo
}
const imageUrl = (viewDay: number): string =>
  `https://basepaint.xyz/api/art/image?day=${viewDay > 0 ? viewDay : 'painting'}&scale=4`
const pngPath = (dir: string, viewDay: number): string =>
  viewDay > 0 ? `${dir}/canvas-${viewDay}.png` : `${dir}/canvas.png`

const IMAGE_EVERY_MS = 30_000
const FEED_EVERY_MS = 20_000
const ETH_TTL_MS = 5 * 60_000

const day = atom({ plugin: 'basepaint', key: 'day' } as const, 0)
const dayEnd = atom({ plugin: 'basepaint', key: 'dayEndsAt' } as const, 0)
const theme = atom({ plugin: 'basepaint', key: 'theme' } as const, null)
const proposer = atom({ plugin: 'basepaint', key: 'proposer' } as const, null)
const palette = atom({ plugin: 'basepaint', key: 'palette' } as const, [])
const image = atom({ plugin: 'basepaint', key: 'image' } as const, {
  path: null,
  generation: 0,
  isOffline: false,
})
/** 0 while showing today's live canvas, else the past day on display. */
const viewDay = atom({ plugin: 'basepaint', key: 'viewDay' } as const, 0)
const stats = atom({ plugin: 'basepaint', key: 'stats' } as const, null)
/** The session's mode override (`/basepaint random|today|<n>`); null defers to the config. */
const modeOverride = atom({ plugin: 'basepaint', key: 'modeOverride' } as const, null)
const topPainters = atom({ plugin: 'basepaint', key: 'topPainters' } as const, [])
const topFailed = atom({ plugin: 'basepaint', key: 'topFailed' } as const, false)
const feed = atom({ plugin: 'basepaint', key: 'feed' } as const, [])
const names = atom({ plugin: 'basepaint', key: 'names' } as const, {})
const ethUsd = atom({ plugin: 'basepaint', key: 'ethUsd' } as const, null)
const online = atom({ plugin: 'basepaint', key: 'online' } as const, null)
const isPinned = atom({ plugin: 'basepaint', key: 'isPinned' } as const, false)
const isOpen = atom({ plugin: 'basepaint', key: 'isOpen' } as const, false)
const lastError = atom({ plugin: 'basepaint', key: 'lastError' } as const, null)

// Timer handles are module-level on purpose: a hot reload drops the timers
// with the old environment, and render re-arms them while the pane is open.
let timers: Timer[] = []
let polling = false

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const fail = async ($: EngineInterface, what: string, err: unknown) => {
  await update($, lastError, () => `${what}: ${message(err)}`)
}

/** $.http.fetch has no timeout option, so race it against a sleep. */
const withTimeout = async <T,>($: EngineInterface, ms: number, work: Promise<T>): Promise<T> => {
  const ctl = new AbortController()
  try {
    return await Promise.race([
      work,
      $.clock.sleep(ms, { signal: ctl.signal }).then(() => {
        throw new Error(`timed out after ${ms}ms`)
      }),
    ])
  } finally {
    ctl.abort()
  }
}

const getJson = async ($: EngineInterface, url: string, init?: Parameters<EngineInterface['http']['fetch']>[1]) => {
  const res = await withTimeout($, 15_000, $.http.fetch(url, init))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return JSON.parse(res.text) as unknown
}

const nowSec = async ($: EngineInterface) => Math.floor((await $.clock.now()) / 1000)

const refreshTheme = async ($: EngineInterface) => {
  try {
    const view = await read($, viewDay)
    const today = view > 0 ? view : currentDay(await nowSec($))
    const cached = (await $.store.get('theme')) as { day: number; data: ThemeData } | undefined
    let data: ThemeData
    if (cached?.day === today) {
      data = cached.data
    } else {
      data = (await getJson($, `https://basepaint.xyz/api/theme/${today}`)) as ThemeData
      await $.store.set('theme', { day: today, data })
    }
    // The pane may have moved to another day while this was in flight.
    if ((await read($, viewDay)) !== view) return
    await update($, day, () => today)
    await update($, dayEnd, () => dayEndsAt(today))
    await update($, theme, () => data.theme ?? null)
    await update($, proposer, () => data.proposer ?? null)
    if (Array.isArray(data.palette)) await update($, palette, () => data.palette as string[])
  } catch (err) {
    await fail($, 'theme', err)
  }
}
type ThemeData = { theme?: string | null; proposer?: string | null; palette?: string[] }

const refreshImage = async ($: EngineInterface) => {
  try {
    const view = await read($, viewDay)
    const dir = await cacheDir($)
    const target = pngPath(dir, view)
    await $.process.run(['mkdir', '-p', dir])
    const tmp = `${target}.part`
    const run = await $.process.run(
      ['curl', '-sS', '-f', '-L', '-o', tmp, '--max-time', '15', imageUrl(view)],
      { timeoutMs: 20_000 },
    )
    if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `curl exit ${run.exitCode}`)
    const mv = await $.process.run(['mv', '-f', tmp, target])
    if (mv.exitCode !== 0) throw new Error(mv.stderr.trim() || 'mv failed')
    if ((await read($, viewDay)) !== view) return
    await update($, image, img => ({ path: target, generation: img.generation + 1, isOffline: false }))
  } catch (err) {
    await update($, image, img => ({ ...img, isOffline: true }))
    await fail($, 'canvas', err)
  }
}

const refreshStats = async ($: EngineInterface) => {
  try {
    const view = await read($, viewDay)
    if (view <= 0) return
    const json = (await getJson($, 'https://graphql.basepaint.xyz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: STATS_QUERY, variables: { id: view } }),
    })) as { data?: unknown }
    const parsed = parseStats(json.data)
    if (!parsed) throw new Error('no stats for this day')
    if ((await read($, viewDay)) === view) await update($, stats, () => parsed)
  } catch (err) {
    await fail($, 'stats', err)
  }
}

const refreshTop = async ($: EngineInterface) => {
  try {
    const view = await read($, viewDay)
    if (view <= 0) return
    const json = (await getJson($, 'https://graphql.basepaint.xyz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: TOP_QUERY, variables: { id: view } }),
    })) as { data?: unknown }
    const rows = parseTop(json.data)
    if ((await read($, viewDay)) !== view) return
    if (rows.length === 0) throw new Error('no contributions for this day')
    await update($, topPainters, () => rows)
    await update($, topFailed, () => false)
    await resolveNames($, rows)
  } catch (err) {
    await update($, topFailed, () => true)
    await fail($, 'leaderboard', err)
  }
}

const refreshEthPrice = async ($: EngineInterface) => {
  try {
    const cached = (await $.store.get('ethUsd')) as { value: number; at: number } | undefined
    const now = await $.clock.now()
    if (cached && now - cached.at < ETH_TTL_MS) {
      await update($, ethUsd, () => cached.value)
      return
    }
    const json = (await getJson($, 'https://api.coinbase.com/v2/exchange-rates?currency=ETH')) as {
      data?: { rates?: { USD?: string } }
    }
    const value = Number(json.data?.rates?.USD)
    if (!Number.isFinite(value)) throw new Error('no USD rate')
    await $.store.set('ethUsd', { value, at: now })
    await update($, ethUsd, () => value)
  } catch (err) {
    await fail($, 'eth price', err)
  }
}

const resolveNames = async ($: EngineInterface, rows: { address: string }[]) => {
  const now = await $.clock.now()
  const cache = ((await $.store.get('names')) ?? {}) as NameCache
  const found: Record<string, string> = {}
  let todo = 0
  let dirty = false
  for (const row of rows) {
    const key = row.address.toLowerCase()
    if (key in found) continue
    const hit = cache[key]
    if (hit && now - hit.at < NAME_TTL_MS) {
      found[key] = hit.name
      continue
    }
    if (todo >= FEED_LIMIT) continue
    todo += 1
    try {
      const name = parseName(
        (await withTimeout($, 10_000, $.http.fetch(resolveNameUrl(row.address)))).text,
      )
      if (name) {
        found[key] = name
        cache[key] = { name, at: now }
        dirty = true
      }
    } catch (err) {
      await fail($, 'name', err)
    }
  }
  if (dirty) {
    const keep = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 2000)
    await $.store.set('names', Object.fromEntries(keep))
  }
  await update($, names, old => ({ ...old, ...found }))
}

const refreshFeed = async ($: EngineInterface) => {
  try {
    const json = (await getJson($, 'https://graphql.basepaint.xyz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: FEED_QUERY, variables: { limit: 8 } }),
    })) as { data?: unknown }
    const rows = mergeFeed(json.data)
    await update($, feed, () => rows)
    await resolveNames($, rows)
  } catch (err) {
    await fail($, 'feed', err)
  }
  try {
    const json = (await getJson($, 'https://cursors.basepaint.xyz/online')) as { users?: number }
    if (typeof json.users === 'number') await update($, online, () => json.users as number)
  } catch (err) {
    await fail($, 'online', err)
  }
  await refreshEthPrice($)
  const today = currentDay(await nowSec($))
  if ((await read($, viewDay)) === 0 && today !== (await read($, day))) await refreshTheme($)
}

const stopPolling = () => {
  for (const t of timers) t.cancel()
  timers = []
  polling = false
}

// Background work never rejects: each refresh records its own failure.
const bg = (work: Promise<void>) => {
  work.catch(() => undefined)
}

const startPolling = ($: EngineInterface) => {
  if (polling) return
  polling = true
  bg(refreshTheme($))
  bg(refreshImage($))
  bg(
    read($, viewDay).then(view => {
      if (view > 0) {
        // A past day is immutable: fetch its stats and leaderboard once, poll nothing.
        bg(refreshStats($))
        bg(refreshTop($))
        return
      }
      bg(refreshFeed($))
      timers = [
        $.clock.every(FEED_EVERY_MS, () => bg(refreshFeed($))),
        $.clock.every(IMAGE_EVERY_MS, () => bg(refreshImage($))),
      ]
    }),
  )
}

/** Pick what the pane shows for this open: today, a fresh random past day, or the kept fixed day. */
const chooseView = async ($: EngineInterface, mode: string) => {
  const before = await read($, viewDay)
  let next = before
  if (mode === 'random') next = pickRandomDay(currentDay(await nowSec($)))
  else if (mode === 'today') next = 0
  if (next !== before) {
    await update($, viewDay, () => next)
    await update($, stats, () => null)
    await update($, topPainters, () => [])
    await update($, topFailed, () => false)
    await update($, image, img => ({ ...img, path: null, isOffline: false }))
  }
}

const effectiveMode = async ($: EngineInterface, configured: string): Promise<string> =>
  (await read($, modeOverride)) ?? configured

const openPane = async ($: EngineInterface, configured: string) => {
  await update($, isOpen, () => true)
  await chooseView($, await effectiveMode($, configured))
  startPolling($)
  await $.ui.open({ id: PANE, title: 'BasePaint' })
}

const closePane = async ($: EngineInterface) => {
  stopPolling()
  await update($, isOpen, () => false)
  await $.ui.close({ id: PANE })
}

const describeView = async ($: EngineInterface): Promise<string> => {
  const view = await read($, viewDay)
  if (view <= 0) return "BasePaint: showing today's live canvas"
  let name: string | null = null
  try {
    const data = (await getJson($, `https://basepaint.xyz/api/theme/${view}`)) as ThemeData
    name = data.theme ?? null
  } catch {
    // the pane's own refresh reports the failure
  }
  return `BasePaint: showing day ${view} · "${name ?? 'untitled'}"`
}

const runCommand = async (
  $: EngineInterface,
  configured: string,
  arg: ReturnType<typeof parseModeArg>,
): Promise<{ text: string }> => {
  if (arg.kind === 'toggle') {
    if (await read($, isOpen)) {
      await update($, isPinned, () => false)
      await closePane($)

      return { text: 'BasePaint pane closed.' }
    }
    await update($, isPinned, () => true)
    await openPane($, configured)

    return { text: 'BasePaint pane opened.' }
  }
  if (arg.kind === 'invalid') return { text: `BasePaint: ${arg.reason}` }

  const today = currentDay(await nowSec($))
  let next: number
  if (arg.kind === 'number') {
    if (arg.day < 1 || arg.day > today) {
      return { text: `BasePaint: day must be between 1 and ${today}.` }
    }
    await update($, modeOverride, () => 'fixed')
    // Today itself is the live canvas, not an archived day.
    next = arg.day === today ? 0 : arg.day
  } else {
    await update($, modeOverride, () => arg.kind)
    next = arg.kind === 'random' ? pickRandomDay(today) : 0
  }
  await update($, isPinned, () => true)
  const wasOpen = await read($, isOpen)
  if (wasOpen) stopPolling()
  await update($, viewDay, () => next)
  await update($, stats, () => null)
  await update($, topPainters, () => [])
  await update($, topFailed, () => false)
  await update($, image, img => ({ ...img, path: null, isOffline: false }))
  await update($, isOpen, () => true)
  startPolling($)
  if (!wasOpen) await $.ui.open({ id: PANE, title: 'BasePaint' })

  return { text: await describeView($) }
}

const onTurnEnd = async ($: EngineInterface) => {
  if ((await read($, isOpen)) && !(await read($, isPinned))) await closePane($)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'basepaint',
      description: 'Toggle the live BasePaint canvas pane',
    })
    $.ui.toast('BasePaint mod loaded · /basepaint to open the pane')

    return next(e)
  })

  const configuredMode = options.mode === 'random' ? 'random' : 'today'

  on('command.run', { command: 'basepaint' }, async ($, e) =>
    runCommand($, configuredMode, parseModeArg(e.args)),
  )

  on('turn.start', async ($, e, next) => {
    if (options.autoOpen !== false && !(await read($, isOpen))) await openPane($, configuredMode)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await onTurnEnd($)

    return next(e)
  })

  on('turn.abort', async ($, e, next) => {
    await onTurnEnd($)

    return next(e)
  })

  // The person closed the pane by hand (or it unloaded): stop polling.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    await update($, isOpen, () => false)
    await update($, isPinned, () => false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Image = 'Image' in ui ? ui.Image : undefined

    // A hot reload drops the timers while the pane stays up: re-arm them.
    try {
      if (!polling) startPolling($)
    } catch {
      // polling resumes on the next open
    }

    const [view, st, dayN, endsAt, themeName, by, colors, img, rows, nameMap, usd, count, err, top, topFail] =
      await Promise.all([
        read($, viewDay),
        read($, stats),
        read($, day),
        read($, dayEnd),
        read($, theme),
        read($, proposer),
        read($, palette),
        read($, image),
        read($, feed),
        read($, names),
        read($, ethUsd),
        read($, online),
        read($, lastError),
        read($, topPainters),
        read($, topFailed),
      ])
    const now = Math.floor((await $.clock.now()) / 1000)
    const width = Math.max(20, e.props.bodyColumns)
    const roomRows = e.viewport?.rows ?? 40
    // Terminal cells are about twice as tall as wide, so a square picture of
    // N columns needs N / 2 rows. Leave ~16 rows for the text around it.
    const imgRows = Math.max(6, Math.min(Math.floor(width / 2), roomRows - 16, 127))
    const imgCols = Math.min(width, imgRows * 2)

    const label = (row: { address: string }) =>
      nameMap[row.address.toLowerCase()] ?? shortAddress(row.address)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Text dimColor wrap="truncate">
            {view > 0
              ? formatStatsLine(view, st)
              : dayN > 0
                ? `day ${dayN} · ${formatTimeLeft(endsAt - now)}`
                : 'loading…'}
          </Text>
          <Text wrap="truncate">
            {'Theme: '}
            <Text bold>{themeName ?? (view > 0 ? 'untitled' : 'TBD')}</Text>
            {view > 0 ? (by ? `, proposed by ${by}` : '') : `, proposed by ${by ?? 'unknown'}`}
          </Text>
          <Box flexWrap="wrap" gap={1} marginTop={1}>
            {colors.map(hex => (
              <Text key={hex} backgroundColor={hex}>{'  '}</Text>
            ))}
          </Box>
        </Box>
        <Box marginBottom={1}>
          {Image && img.path ? (
            <Image
              key="canvas"
              source={{ file: img.path, format: 'png', generation: img.generation }}
              columns={imgCols}
              rows={imgRows}
              alt="BasePaint canvas"
            />
          ) : (
            <Box paddingX={1}>
              <Text dimColor>{img.isOffline ? 'canvas offline' : 'loading canvas…'}</Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="column" paddingX={1}>
          {img.path && img.isOffline && <Text dimColor>canvas offline</Text>}
          {view > 0 ? (
            <Box flexDirection="column">
              <Text color="green" bold>
                {`● TOP PAINTERS${st ? ` · ${st.artists.toLocaleString('en-US')} ARTISTS` : ''}`}
              </Text>
              {top.map((p, i) => (
                <Box key={p.address}>
                  <Box width={3}>
                    <Text bold color="cyan">{String(i + 1)}</Text>
                  </Box>
                  <Box width={18}>
                    <Text bold color="cyan" wrap="truncate">
                      {label(p)}
                    </Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text wrap="truncate">{formatPainted(p.pixels)}</Text>
                  </Box>
                  <Text dimColor>{formatShare(p.pixels, st?.pixels)}</Text>
                </Box>
              ))}
              {top.length === 0 && topFail && <Text dimColor>leaderboard unavailable</Text>}
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color="green" bold>
                {`● ${count ?? '?'} USERS ONLINE`}
              </Text>
              {rows.map(row => (
                <Box key={row.id}>
                  <Box width={18}>
                    <Text bold color="cyan" wrap="truncate">
                      {label(row)}
                    </Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text wrap="truncate">{rowText(row, usd)}</Text>
                  </Box>
                  <Text dimColor>{relativeTime(now, row.timestamp)}</Text>
                </Box>
              ))}
            </Box>
          )}
          {err && <Text dimColor wrap="truncate">{`last error: ${err}`}</Text>}
        </Box>
      </Box>
    )
  })
}
