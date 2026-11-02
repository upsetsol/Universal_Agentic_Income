'use strict'

// Small helpers: argument parsing, JSON output, exact decimal maths (no floating point for money).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** `uai <command> --name value --flag` -> { cmd, opts, flags } */
function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined
  const rest = cmd ? argv.slice(1) : argv
  const opts = {}
  const flags = new Set()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) continue
    const name = a.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      opts[name] = next
      i++
    } else {
      flags.add(name)
    }
  }
  return { cmd, opts, flags }
}

const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v)
/** Every command prints exactly one JSON document on stdout. */
const out = (o) => console.log(JSON.stringify(o, replacer, 2))

class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}
/** Throw a user-facing error: printed as { success:false, code, error, ...extra } and exit code 1. */
const fail = (code, message, extra = {}) => {
  throw new CliError(code, message, extra)
}

/** bigint units -> decimal string without trailing zeros (1500000000n, 9 -> "1.5"). */
function fmtUnits(raw, decimals) {
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '')
}

const big = (x) => (x === undefined || x === null ? 0n : BigInt(x.toString()))
const iso = (secs) => (secs ? new Date(Number(secs) * 1000).toISOString() : null)
/** A duration in plain words: 21600 -> "6 h", 5400 -> "1 h 30 min". */
function fmtDuration(secs) {
  const s = Math.max(0, Math.round(Number(secs)))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h && m) return `${h} h ${m} min`
  if (h) return `${h} h`
  if (m) return `${m} min`
  return `${s} s`
}

module.exports = { sleep, parseArgs, out, fail, CliError, fmtUnits, big, iso, fmtDuration }
