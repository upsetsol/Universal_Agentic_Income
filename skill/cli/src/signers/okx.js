'use strict'

// Signer: OKX Agentic Wallet (CLI `onchainos`). The wallet's key lives in OKX's secure enclave (TEE); this CLI never sees it.
//
// OKX has NO "preview" call: `wallet contract-call` signs AND broadcasts at once. So the "show it to the human first" step is OURS:
//   preview : build + our own dry run + OKX's read-only risk scan (`security tx-scan`) -> the transaction is stored under a request id
//   execute : (only after the human said yes) put in a FRESH blockhash, dry-run again, then `wallet contract-call`
// OKX may answer "confirming" (exit code 2) when it wants an extra confirmation: the agent shows the message to the human and, only if
// the human agrees, `uai execute --request-id <id> --force` repeats the call with --force.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const bs58 = require('bs58')
const web3 = require('@solana/web3.js')
const { CONFIG } = require('../config')
const { CliError } = require('../util')
const { simulate } = require('../build')
const chain = require('../chain')

const PREVIEW_TTL_MS = 10 * 60 * 1000
const previewDir = () => path.join(CONFIG.home, 'previews')
const idOk = (id) => /^[0-9a-fA-F-]{8,64}$/.test(id)

const parseJson = (s) => {
  try { return JSON.parse(s) } catch { return null }
}

/** Run `onchainos ...`; returns { code, json, stderr }. Exit codes (OKX): 0 ok, 1 error, 2 "confirming", 3 setup required. */
function run(args) {
  try {
    const out = execFileSync(CONFIG.okxBin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20, timeout: 180000 })
    return { code: 0, json: parseJson(out), stderr: '' }
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError('OKX_NOT_INSTALLED', `The OKX CLI \`${CONFIG.okxBin}\` was not found. Download the release binary for your system from https://github.com/okx/onchainos-skills/releases and verify its checksum, then put it on PATH or set UAI_OKX_BIN=<path>.`)
    return { code: typeof e.status === 'number' ? e.status : 1, json: parseJson(e.stdout), stderr: String(e.stderr || '').slice(0, 400) }
  }
}

const walletStatus = () => {
  const r = run(['wallet', 'status'])
  return r.json && r.json.ok ? r.json.data : null
}
const solanaAddress = () => {
  const r = run(['wallet', 'addresses', '--chain', 'solana'])
  const d = r.json && r.json.ok && r.json.data
  const a = d && Array.isArray(d.solana) && d.solana[0] && d.solana[0].address
  return a || null
}

/** The program the transaction mainly talks to (the last instruction's program): OKX wants a `--to`. */
function mainProgram(vtx) {
  const keys = vtx.message.staticAccountKeys
  const ixs = vtx.message.compiledInstructions
  return keys[ixs[ixs.length - 1].programIdIndex].toBase58()
}

/**
 * The stored preview is the only thing between "what the human approved" and "what gets signed". So before anything is signed,
 * every instruction in it must go to a program this CLI itself uses (our program, the associated-token program, the token program);
 * a stored transaction that does anything else is never signed.
 */
function strayProgram(vtx) {
  const keys = vtx.message.staticAccountKeys
  const allowed = [chain.PROGRAM_ID, chain.ATA_PROGRAM, chain.TOKEN_PROGRAM]
  for (const ix of vtx.message.compiledInstructions) {
    const id = keys[ix.programIdIndex]
    if (!allowed.some((a) => a.equals(id))) return id.toBase58()
  }
  return null
}

module.exports = {
  name: 'okx',
  label: 'OKX Agentic Wallet',
  errorKey: 'okx',

  /** For auto-detection: throws OKX_NOT_INSTALLED when the CLI is missing; otherwise 'installed' (not signed in) or 'ready'. */
  quickState() {
    run(['--version'])
    const st = walletStatus()
    return st && st.loggedIn ? 'ready' : 'installed'
  },

  optionalAddress() {
    try {
      const st = walletStatus()
      return st && st.loggedIn ? solanaAddress() : null
    } catch {
      return null
    }
  },

  address() {
    const st = walletStatus()
    if (!st || !st.loggedIn) throw new CliError('NOT_SIGNED_IN', 'The OKX wallet is not signed in. Run `onchainos wallet login`, finish the login in the browser, then run the `completeLogin` command it prints (`wallet login --phase poll --session-id ...`).')
    const a = solanaAddress()
    if (!a) throw new CliError('NO_SOLANA_ADDRESS', 'The OKX wallet has no Solana address.')
    return a
  },

  async preflight() {
    const issues = []
    let status = 'UNCONNECTED'
    let address = null
    let wallet = null
    try {
      const st = walletStatus()
      if (!st || !st.loggedIn) {
        issues.push({ code: 'NOT_SIGNED_IN', fix: 'Run `onchainos wallet login`, finish the login in the browser (Google / Apple / email), then run the `completeLogin` command it prints.' })
      } else {
        status = 'CONNECTED'
        address = solanaAddress()
        if (!address) issues.push({ code: 'NO_SOLANA_ADDRESS', fix: 'The OKX wallet shows no Solana address. Run `onchainos wallet addresses --chain solana`.' })
        wallet = { loginType: st.loginType || null, policy: st.policy || null }
      }
    } catch (e) {
      if (e instanceof CliError) issues.push({ code: e.code, fix: e.message })
      else throw e
    }
    return { status, address, issues, wallet }
  },

  /** OKX cannot preview: scan it (read-only), keep it, and let the human decide. */
  async preview({ from, built }) {
    const risks = []
    let action = ''
    const scan = run(['security', 'tx-scan', '--chain', 'solana', '--from', from, '--encoding', 'base64', '--transactions', built.unsignedTx])
    if (scan.json && scan.json.ok) {
      const d = scan.json.data || {}
      action = d.action || ''
      for (const item of d.riskItemDetail || []) {
        risks.push({ code: item.name, title: item.name, description: JSON.stringify(item.description || item.reason || ''), riskType: item.action === 'block' ? 'RISK' : 'CAUTION' })
      }
      const rr = d.simulator && d.simulator.revertReason
      if (rr) risks.push({ code: 'OKX_SIMULATION', title: "OKX's own simulation reports a problem", description: String(rr).slice(0, 300), riskType: 'CAUTION' })
      for (const w of Array.isArray(d.warnings) ? d.warnings : []) risks.push({ code: 'OKX_WARNING', title: String(w).slice(0, 80), description: String(w).slice(0, 300), riskType: 'CAUTION' })
    } else {
      risks.push({ code: 'OKX_SCAN_UNAVAILABLE', title: "OKX's risk scan gave no answer", description: 'Only our own dry run was done.', riskType: 'CAUTION' })
    }
    if (action === 'block') return { success: false, error: { code: 'BLOCKED_BY_OKX_SCAN', message: "OKX's risk scan BLOCKS this transaction.", data: { risks } } }

    const requestId = crypto.randomUUID()
    fs.mkdirSync(previewDir(), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(previewDir(), requestId + '.json'), JSON.stringify({ unsignedTx: built.unsignedTx, from, createdAt: Date.now() }), { mode: 0o600 })
    return {
      success: true,
      data: {
        requestId,
        expiresAt: Date.now() + PREVIEW_TTL_MS,
        requireConfirmation: true,
        risks: { riskDetails: risks },
        simulationResult: { balanceChanges: [], authorityChanges: [] },
      },
    }
  },

  /** Fresh blockhash -> dry run -> `wallet contract-call` (TEE signs and broadcasts). */
  async execute(requestId, { force, connection }) {
    const err = (code, message, data) => ({ success: false, error: { code, message, ...(data ? { data } : {}) } })
    if (!idOk(requestId)) return err('PREVIEW_NOT_FOUND', 'unknown request id')
    const file = path.join(previewDir(), requestId + '.json')
    const rec = parseJson((() => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } })())
    if (!rec) return err('PREVIEW_NOT_FOUND', 'unknown or already used request id (the preview was not found)')
    if (Date.now() - rec.createdAt > PREVIEW_TTL_MS) return err('PREVIEW_EXPIRED', 'the preview expired (older than 10 minutes)')

    const vtx = web3.VersionedTransaction.deserialize(Buffer.from(rec.unsignedTx, 'base64'))
    const stray = strayProgram(vtx)
    if (stray) return err('UNEXPECTED_TRANSACTION', `the stored transaction calls a program this CLI never uses (${stray}); it will not be signed`)
    if (vtx.message.staticAccountKeys[0].toBase58() !== rec.from) return err('UNEXPECTED_TRANSACTION', 'the stored transaction has a different fee payer than the previewed one; it will not be signed')
    vtx.message.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    const sim = await simulate(connection, vtx)
    if (!sim.ok) {
      const d = sim.decoded || {}
      return err('SIMULATION_FAILED', d.name ? `the program would refuse this now: ${d.name} - ${d.message}` : 'the dry run failed just before sending', { programError: d.name || null, logs: sim.logs.slice(-6) })
    }

    const r = run(['wallet', 'contract-call', '--chain', 'solana', '--to', mainProgram(vtx), '--unsigned-tx', bs58.encode(Buffer.from(vtx.serialize())), '--from', rec.from, ...(force ? ['--force'] : [])])
    if (r.code === 2 && r.json && r.json.confirming) {
      return { success: true, data: { status: 'NEEDS_CONFIRMATION', message: r.json.message || '', okxNext: r.json.next || '', txHash: null } }
    }
    if (r.code === 0 && r.json && r.json.ok) {
      try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
      const d = r.json.data || {}
      return { success: true, data: { status: 'BROADCASTED', txHash: d.txHash || null, orderId: d.orderId } }
    }
    return err(r.json && r.json.errorCode ? String(r.json.errorCode) : 'OKX_ERROR', (r.json && (r.json.error || r.json.reason)) || r.stderr || 'wallet contract-call failed')
  },
}
