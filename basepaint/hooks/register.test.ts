import { describe, expect, mock, test } from 'claude-code/testing'

import {
  currentDay,
  formatEarned,
  formatTimeLeft,
  formatStatsLine,
  mergeFeed,
  parseName,
  relativeTime,
  rowText,
  shortAddress,
} from './lib'

const RUN = {
  command: 'basepaint',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

describe('formatting', () => {
  test('day math matches the BasePaint epoch', () => {
    expect(currentDay(1691599315)).toBe(1)
    expect(currentDay(1691599315 + 86400 * 1150 + 5)).toBe(1151)
    expect(formatTimeLeft(5 * 3600 + 12 * 60 + 9)).toBe('5h 12m left')
    expect(formatTimeLeft(59 * 60)).toBe('59m left')
  })

  test('relative time', () => {
    expect(relativeTime(1000, 998)).toBe('just now')
    expect(relativeTime(1000, 970)).toBe('30 seconds ago')
    expect(relativeTime(1000, 1000 - 240)).toBe('4 minutes ago')
    expect(relativeTime(1000, 1000 - 60)).toBe('1 minute ago')
    expect(relativeTime(100000, 100000 - 7300)).toBe('2 hours ago')
  })

  test('addresses and amounts', () => {
    expect(shortAddress('0x01E2FE12Ee3c5ce5056763e7a2380144491Be772')).toBe('0x01E2…e772')
    expect(formatEarned('2411478220213512', 2691.12)).toBe('$6.49')
    expect(formatEarned('2411478220213512', null)).toBe('0.0024 ETH')
  })

  test('feed merges both lists, newest first, capped at 6', () => {
    const rows = mergeFeed({
      withdrawals: {
        items: [
          { accountId: '0xaaa', amount: '1000000000000000', timestamp: 100 },
          { accountId: '0xbbb', amount: '2000000000000000', timestamp: 300 },
          { accountId: '0xccc', amount: '3000000000000000', timestamp: 50 },
        ],
      },
      strokes: {
        items: [
          { accountId: '0xddd', pixels: 973, timestamp: 200 },
          { accountId: '0xeee', pixels: 5, timestamp: 400 },
          { accountId: '0xfff', pixels: 6, timestamp: 10 },
          { accountId: '0x111', pixels: 7, timestamp: 20 },
        ],
      },
    })
    expect(rows.map(r => r.timestamp)).toEqual([400, 300, 200, 100, 50, 20])
    expect(rowText(rows[2]!, 2000)).toBe('painted 973 pixels')
    expect(rowText(rows[1]!, 2000)).toBe('earned $4.00')
    expect(mergeFeed(undefined)).toEqual([])
  })

  test('name resolution response', () => {
    expect(parseName('{"result":{"data":{"json":"bombadilus.eth"}}}')).toBe('bombadilus.eth')
    expect(parseName('{"result":{}}')).toBeNull()
  })
})

describe('command.run', () => {
  test('/basepaint toggles the pane and pins it', async ($, on) => {
    const clock = mock.clock(on, { now: 1790964000_000 })
    mock.store(on)
    mock.env(on, { TMPDIR: '/tmp/' })
    const opened: string[] = []
    const closed: string[] = []
    on('ui.open', (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('ui.close', (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
    on('process.run', () => ({
      value: { exitCode: 1, stdout: '', stderr: 'offline', isStdoutTruncated: false, isStderrTruncated: false },
    }))

    const first = await $.command.run(RUN)
    expect(first.text).toBe('BasePaint pane opened.')
    expect(opened).toEqual(['basepaint'])

    const second = await $.command.run(RUN)
    expect(second.text).toBe('BasePaint pane closed.')
    expect(closed).toEqual(['basepaint'])
    await clock.settle()
  })

  test('turns auto-open the pane and close it unless pinned', async ($, on) => {
    const clock = mock.clock(on, { now: 1790964000_000 })
    mock.store(on)
    mock.env(on, { TMPDIR: '/tmp/' })
    const log: string[] = []
    on('ui.open', (_$, e) => {
      log.push(`open:${e.id}`)
      return { value: { isPlaced: true } }
    })
    on('ui.close', (_$, e) => {
      log.push(`close:${e.id}`)
      return { value: undefined }
    })
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
    on('process.run', () => ({
      value: { exitCode: 1, stdout: '', stderr: 'offline', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('turn.start', () => ({ turnId: 't1' }))
    on('turn.complete', () => ({ text: 'done' }))

    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(log).toEqual(['open:basepaint'])
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(log).toEqual(['open:basepaint', 'close:basepaint'])

    // Opened by hand: pinned, so a finished turn leaves it up.
    await $.command.run(RUN)
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(log).toEqual(['open:basepaint', 'close:basepaint', 'open:basepaint'])
    await clock.settle()
  })
})

describe('ui.render', () => {
  test('the pane draws the canvas image, palette and feed', async ($, on) => {
    const clock = mock.clock(on, { now: 1790964000_000 })
    mock.store(on)
    mock.env(on, { TMPDIR: '/tmp/' })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))
    on('http.fetch', (_$, e) => {
      const url = e.url
      const body = url.includes('/api/theme/')
        ? '{"theme":"what\'s in my bag","proposer":"bl00m.eth","size":256,"palette":["#e2e4df","#123456"]}'
        : url.includes('graphql')
          ? '{"data":{"withdrawals":{"items":[{"accountId":"0x01E2FE12Ee3c5ce5056763e7a2380144491Be772","amount":"2411478220213512","timestamp":1790963623}]},"strokes":{"items":[{"accountId":"0x01E2FE12Ee3c5ce5056763e7a2380144491Be772","pixels":973,"timestamp":1790964000}]}}}'
          : url.includes('cursors')
            ? '{"users":21}'
            : url.includes('coinbase')
              ? '{"data":{"rates":{"USD":"2691.12"}}}'
              : '{"result":{"data":{"json":"bombadilus.eth"}}}'
      return { value: { status: 200, ok: true, headers: {}, text: body } }
    })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    await $.command.run(RUN)
    await clock.settle()

    const ui = await $.ui.mount({
      plugin: 'basepaint',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'basepaint',
      viewport: { columns: 160, rows: 50, isFullscreen: true },
      props: {
        title: 'BasePaint',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /USERS ONLINE/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /painted 973 pixels/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /earned \$6\.49/ })).toBeDefined()
    await ui.unmount()
    await $.command.run(RUN)
    await clock.settle()
  })
})


const NOW = 1790964000_000 // day 1151
const today = currentDay(NOW / 1000)

const setupPast = ($: any, on: any) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { TMPDIR: '/tmp/' })
  const opened: string[] = []
  const urls: string[] = []
  on('ui.open', (_$: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('http.fetch', (_$: any, e: any) => {
    urls.push(e.url)
    const body = e.url.includes('/api/theme/')
      ? '{"theme":"Pickleball","proposer":null,"size":256,"palette":["#ffffff"]}'
      : e.url.includes('graphql') && String(e.init?.body ?? '').includes('contributions(')
        ? '{"data":{"contributions":{"items":[{"accountId":"0x9F5a000000000000000000000000000000000001","pixelsCount":7000},{"accountId":"0x9F5a000000000000000000000000000000000002","pixelsCount":3000}]}}}'
      : e.url.includes('trpc')
        ? '{"result":{"data":{"json":"bombadilus.eth"}}}'
      : e.url.includes('graphql') && String(e.init?.body ?? '').includes('canvas(')
        ? '{"data":{"canvas":{"totalArtists":41,"pixelsCount":65536,"totalMints":120,"totalEarned":"1234000000000000000"}}}'
        : e.url.includes('graphql')
          ? '{"data":{}}'
          : '{"users":1}'
    return { value: { status: 200, ok: true, headers: {}, text: body } }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  return { clock, opened, urls }
}

describe('random day mode', () => {
  test('/basepaint random picks a past day and opens the pane', async ($, on) => {
    const { clock, opened } = setupPast($, on)
    const res = await $.command.run({ ...RUN, args: 'random' })
    const m = /showing day (\d+) ·/.exec(res.text ?? '')
    expect(m).not.toBeNull()
    const picked = Number(m![1])
    expect(picked >= 1 && picked <= today - 1).toBe(true)
    expect(opened).toEqual(['basepaint'])
    await clock.settle()
  })

  test('/basepaint 812 sets that day', async ($, on) => {
    const { clock, opened } = setupPast($, on)
    const res = await $.command.run({ ...RUN, args: '812' })
    expect(res.text).toBe('BasePaint: showing day 812 · "Pickleball"')
    expect(opened).toEqual(['basepaint'])
    await clock.settle()
  })

  test('/basepaint 99999 is refused', async ($, on) => {
    const { clock, opened } = setupPast($, on)
    const res = await $.command.run({ ...RUN, args: '99999' })
    expect(res.text).toContain('day must be between 1 and')
    expect(opened).toEqual([])
    await clock.settle()
  })

  test('a past-day header renders artists, pixels, mints and ETH', async ($, on) => {
    const { clock, urls } = setupPast($, on)
    await $.command.run({ ...RUN, args: '812' })
    await clock.settle()
    expect(urls.some(u => u.includes('/api/theme/812'))).toBe(true)
    const ui = await $.ui.mount({
      plugin: 'basepaint',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'basepaint',
      viewport: { columns: 160, rows: 50, isFullscreen: true },
      props: {
        title: 'BasePaint',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(
      await ui.find({ type: 'Text', text: /day 812 · 41 artists · 65,536 pixels · 120 mints · 1\.234 ETH/ }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Theme: / })).toBeDefined()
    await ui.unmount()
    await $.command.run(RUN)
    await clock.settle()
  })

  test('stats line formatting', () => {
    expect(
      formatStatsLine(812, { artists: 41, pixels: 65536, mints: 120, earnedWei: '1234000000000000000' }),
    ).toBe('day 812 · 41 artists · 65,536 pixels · 120 mints · 1.234 ETH')
  })

  const mountPane = ($: any) =>
    $.ui.mount({
      plugin: 'basepaint',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'basepaint',
      viewport: { columns: 160, rows: 50, isFullscreen: true },
      props: {
        title: 'BasePaint',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })

  test('a past-day footer is that day\'s leaderboard', async ($, on) => {
    const { clock } = setupPast($, on)
    await $.command.run({ ...RUN, args: '812' })
    await clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /TOP PAINTERS · 41 ARTISTS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /painted 7,000 pixels/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /10\.7%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /bombadilus\.eth/ })).toBeDefined()
    await ui.unmount()
    await $.command.run(RUN)
    await clock.settle()
  })

  test('today mode still shows USERS ONLINE', async ($, on) => {
    const { clock } = setupPast($, on)
    await $.command.run({ ...RUN, args: 'today' })
    await clock.settle()
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /USERS ONLINE/ })).toBeDefined()
    await ui.unmount()
    await $.command.run(RUN)
    await clock.settle()
  })
})
