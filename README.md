# basepaint-claude-mod

A live [BasePaint](https://basepaint.xyz) pane in the Claude Code terminal, so you can watch the daily collaborative pixel-art canvas on Base while Claude works.

## What it shows

- Live canvas image (refreshed while the pane is open)
- Today's theme and color palette
- Activity feed of recent mints/contributions
- Leaderboard
- Online count
- ETH price

## Install

```
claude plugin marketplace add zherring/basepaint-claude-mod
claude plugin install basepaint@basepaint-claude-mod
```

## Commands

| Command | Effect |
| --- | --- |
| `/basepaint` | Toggle the pane |
| `/basepaint today` | Show the live canvas |
| `/basepaint random` | Show a random past day |
| `/basepaint <day>` | Show a specific day, e.g. `/basepaint 100` |

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `autoOpen` | boolean | `true` | Open the pane automatically when Claude starts working |
| `mode` | string | `today` | `today` for the live canvas, `random` for a random past day |

Set these from the `/plugin` menu: select the basepaint plugin and edit its configuration.

## Network

While the pane is open, the mod polls public endpoints roughly every 20-30 seconds: the basepaint.xyz API and GraphQL, cursors.basepaint.xyz, and api.coinbase.com (ETH price). It uses no authentication and sends no data about you or your session. Canvas images are cached in `$TMPDIR/claude-basepaint` (or `/tmp/claude-basepaint`).

## Development

```
claude --plugin-dir ./basepaint
claude plugin validate --strict ./basepaint
claude plugin test ./basepaint
```

## License

MIT
