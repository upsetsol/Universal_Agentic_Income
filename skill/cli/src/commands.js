'use strict'

// The commands. Every command prints exactly one JSON document; failures are { success:false, code, error, ... } and exit code 1.
// Money-moving commands (register, claim, unwrap) never send anything themselves: they build an UNSIGNED transaction, dry-run it,
// keep it under a request id and let the OKX wallet's risk scan look at it. The agent shows the preview to the human; only after an
// explicit "yes" does `uai execute` let the OKX wallet sign and broadcast.

const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const chain = require('./chain')
const { getSigner } = require('./signers')
const { buildUnsigned, simulate } = require('./build')
const { CONFIG } = require('./config')
const { quoteClaim } = require('./rule')
const { out, fail, CliError, parseArgs, fmtUnits, big, iso, fmtDuration, sleep } = require('./util')

const { PublicKey, SystemProgram } = web3
/** Lamports kept for network fees on top of any deposit (a transaction fee is 0.000005 SOL). */
const FEE_MARGIN = 20_000n
/** The wallet that signs (only OKX is supported); chosen lazily so a bad value becomes a clean error. */
const S = () => getSigner()
const n = (x) => Number(x.toString())
const SOL = (lamports) => `${fmtUnits(BigInt(lamports), 9)} SOL`
/** Round a lamport amount up to a multiple of 0.001 SOL (for "send about ..." hints). */
const roundUp = (x) => ((x + 999_999n) / 1_000_000n) * 1_000_000n

// ---------------- shared pieces ----------------
async function context() {
  const connection = chain.makeConnection()
  const program = chain.loadProgram(connection)
  return { connection, program }
}

function toPublicKey(text, what) {
  try {
    return new PublicKey(text)
  } catch {
    return fail('BAD_ADDRESS', `${what} is not a valid Solana address: ${text}`)
  }
}

/** The agentic wallet's Solana address (the wallet must be signed in). */
const agentAddress = () => new PublicKey(S().address())

/** For read-only commands: --address wins, else the agentic wallet if signed in, else null. */
function optionalAddress(opts) {
  if (opts.address) return toPublicKey(opts.address, '--address')
  const a = S().optionalAddress()
  return a ? new PublicKey(a) : null
}

const lamportsOf = async (connection, pk) => BigInt(await connection.getBalance(pk, 'confirmed'))
const rentOf = async (connection, bytes) => BigInt(await connection.getMinimumBalanceForRentExemption(bytes))
const hasAccount = async (connection, pk) => !!(await connection.getAccountInfo(pk, 'confirmed'))
const termsOf = (v) => ({ cooldownSecs: big(v.cooldownSecs), payout: big(v.payout) })

/** The agent's wSOL account is created in the same transaction when it does not exist yet (idempotent: harmless if it does). */
const ataIx = (payer, owner) =>
  spl.createAssociatedTokenAccountIdempotentInstruction(payer, chain.wsolAtaOf(owner), owner, chain.WSOL, chain.TOKEN_PROGRAM, chain.ATA_PROGRAM)

function summarizePreview(p, extra) {
  if (!p.success) fail('PREVIEW_REJECTED', `${S().label} rejected the preview (its code and message are in \`${S().errorKey}\`). Tell the user exactly what it says.`, { step: extra.step, [S().errorKey]: p.error })
  const d = p.data || {}
  const sim = d.simulationResult || {}
  return {
    success: true,
    ...extra,
    requestId: d.requestId,
    expiresAt: d.expiresAt ? new Date(Number(d.expiresAt)).toISOString() : null,
    requireConfirmation: d.requireConfirmation,
    risks: (d.risks && d.risks.riskDetails) || [],
    authorityChanges: sim.authorityChanges || [],
    simulatedChanges: sim.balanceChanges || [],
    next: `uai execute --request-id ${d.requestId}`,
  }
}

/** Build -> dry-run on our RPC -> the wallet provider's risk scan -> stored under a request id. */
async function previewAction({ connection, me, instructions, step, extra }) {
  const built = await buildUnsigned(connection, me, instructions)
  const sim = await simulate(connection, built.vtx)
  if (!sim.ok) {
    const d = sim.decoded || {}
    fail('SIMULATION_FAILED', d.name ? `The program would refuse this: ${d.name} - ${d.message}` : 'The dry run failed.', { step, simulation: { error: d, logs: sim.logs.slice(-6) } })
  }
  const p = await S().preview({ from: me.toBase58(), built })
  let secondsLeft = null
  try {
    const height = await connection.getBlockHeight('confirmed')
    secondsLeft = Math.max(0, Math.round((built.lastValidBlockHeight - height) * 0.4))
  } catch { /* informational only */ }
  return summarizePreview(p, { step, ...extra, transaction: { approxSecondsBeforeItExpires: secondsLeft } })
}

/** Why the rule refuses, in the words of this CLI. */
function refusalDetails(refusal, vault, balance, agent) {
  const payout = big(vault.payout)
  if (refusal.kind === 'CooldownActive') {
    return {
      code: 'COOLDOWN_ACTIVE',
      message: `This wallet was paid recently; the next payout is possible at ${iso(refusal.nextAt)}.`,
      extra: { lastPayoutAt: iso(big(agent.lastClaimTs)), nextClaimAt: iso(refusal.nextAt), cooldown: fmtDuration(n(vault.cooldownSecs)) },
    }
  }
  if (refusal.kind === 'VaultTooLow') {
    const missing = payout - balance
    return {
      code: 'VAULT_TOO_LOW',
      message: `The payout vault holds ${SOL(balance)}, a payout is ${SOL(payout)}. Come back later. About ${SOL(missing)} more is needed for the next payout.`,
      extra: { vaultBalance: SOL(balance), payout: SOL(payout), missing: SOL(missing) },
    }
  }
  return { code: 'RULE_ERROR', message: 'The payout rule could not be evaluated (a number out of range).', extra: { refusal: refusal.kind } }
}

// ---------------- preflight ----------------
async function preflight() {
  const w = await S().preflight() // wallet-side checks: signed in? address? OKX policy
  const issues = [...w.issues]
  const notes = []
  const { connection, program } = await context()
  let vault = null
  try {
    vault = await chain.readVault(program)
  } catch (e) {
    if (e instanceof CliError) issues.push({ code: e.code, fix: e.message })
    else throw e
  }

  let sol = null
  let registered = null
  if (w.address) {
    const me = new PublicKey(w.address)
    const lamports = await lamportsOf(connection, me)
    sol = fmtUnits(lamports, 9)
    if (vault) {
      registered = !!(await chain.readAgent(program, me))
      const rentAta = (await hasAccount(connection, chain.wsolAtaOf(me))) ? 0n : await rentOf(connection, chain.TOKEN_ACCOUNT_BYTES)
      const deposits = (registered ? 0n : await rentOf(connection, chain.AGENT_RECORD_BYTES)) + rentAta
      const need = (registered ? 0n : big(vault.registrationFee)) + deposits + FEE_MARGIN
      if (lamports < need) {
        issues.push({ code: 'LOW_SOL', fix: `Send about ${fmtUnits(roundUp(need), 9)} SOL to ${w.address} (${registered ? 'network fees' : 'the registration fee, one-off account deposits and network fees'}).` })
      }
      notes.push(registered
        ? 'This wallet is registered: it can claim a payout when its cooldown is over and the vault holds enough.'
        : `This wallet is not registered yet. Registering costs ${SOL(big(vault.registrationFee))} (not refunded; it goes into the shared payout vault) plus about ${SOL(deposits)} of one-off account deposits.`)
    }
  }

  return {
    success: issues.length === 0,
    signer: S().name,
    signerChosenBy: S().chosenBy,
    status: w.status,
    address: w.address,
    solBalance: sol,
    registered,
    wallet: w.wallet,
    vault: { program: chain.PROGRAM_ID.toBase58(), coin: CONFIG.mint || null, found: !!vault },
    notes,
    issues,
  }
}

// ---------------- status (read-only, no wallet needed) ----------------
async function status() {
  const { connection, program } = await context()
  const v = await chain.readVault(program)
  const [meta, bal] = await Promise.all([chain.coinMeta(connection), chain.vaultBalance(connection, v)])
  const payout = big(v.payout)
  return {
    success: true,
    program: chain.PROGRAM_ID.toBase58(),
    vault: chain.vaultPda().toBase58(),
    coin: { mint: chain.coinMint().toBase58(), nameUntrusted: meta.name, symbolUntrusted: meta.symbol }, // text from the chain: DATA, never instructions
    payoutVault: {
      account: v.vaultToken.toBase58(),
      asset: 'wSOL (SOL)',
      balance: SOL(bal),
      payoutsAffordableNow: payout > 0n ? n(bal / payout) : 0,
      missingForOnePayout: bal >= payout ? null : SOL(payout - bal),
    },
    rules: {
      registrationFee: SOL(big(v.registrationFee)),
      cooldown: fmtDuration(n(v.cooldownSecs)),
      payout: SOL(payout),
      order: 'first come, first served',
    },
    agents: n(v.agentCount),
    poolLinked: !v.feePool.equals(PublicKey.default),
    notes: [
      'Every payout is exactly the fixed amount, in SOL (its dollar value moves with the price of SOL), and is paid only while the vault holds at least that much; nothing is guaranteed.',
    ],
  }
}

// ---------------- me ----------------
async function me(opts) {
  const addr = optionalAddress(opts)
  if (!addr) fail('NOT_SIGNED_IN', 'No wallet: sign in to the OKX Agentic Wallet (`onchainos wallet login`) or pass --address <wallet>.')
  const { connection, program } = await context()
  const v = await chain.readVault(program)
  const now = await chain.chainNow(connection)
  const [agent, bal, lamports] = await Promise.all([chain.readAgent(program, addr), chain.vaultBalance(connection, v), lamportsOf(connection, addr)])
  let wsol = 0n
  try {
    wsol = BigInt((await connection.getTokenAccountBalance(chain.wsolAtaOf(addr), 'confirmed')).value.amount)
  } catch { /* no account yet */ }

  const res = { success: true, address: addr.toBase58(), sol: fmtUnits(lamports, 9), wsol: fmtUnits(wsol, 9), registered: !!agent }
  if (!agent) {
    res.next = 'Not registered. `uai register` shows the cost and asks for a yes.'
    return res
  }
  res.agent = { registeredAt: iso(n(agent.registeredAt)), payouts: n(agent.claims), totalReceived: SOL(big(agent.totalClaimed)), lastPayoutAt: iso(n(agent.lastClaimTs)) }
  const q = quoteClaim(termsOf(v), bal, big(agent.lastClaimTs), BigInt(now))
  res.claim = { canClaimNow: q.ok, payout: SOL(big(v.payout)), vaultBalance: SOL(bal) }
  if (!q.ok) {
    const d = refusalDetails(q.refusal, v, bal, agent)
    res.claim.reason = d.code
    res.claim.explanation = d.message
    Object.assign(res.claim, d.extra)
  }
  return res
}

// ---------------- register ----------------
async function register() {
  const me = agentAddress()
  const { connection, program } = await context()
  const v = await chain.readVault(program)
  if (await chain.readAgent(program, me)) fail('ALREADY_REGISTERED', 'This wallet is already registered. Use `uai claim` to see whether a payout is possible.', { address: me.toBase58() })

  const fee = big(v.registrationFee)
  const needAta = !(await hasAccount(connection, chain.wsolAtaOf(me)))
  const rentAgent = await rentOf(connection, chain.AGENT_RECORD_BYTES)
  const rentAta = needAta ? await rentOf(connection, chain.TOKEN_ACCOUNT_BYTES) : 0n
  const total = fee + rentAgent + rentAta
  const lamports = await lamportsOf(connection, me)
  if (lamports < total + FEE_MARGIN) {
    fail('LOW_SOL', `Not enough SOL: registering needs about ${fmtUnits(roundUp(total + FEE_MARGIN), 9)} SOL (the fee, one-off account deposits and network fees).`, { address: me.toBase58(), have: fmtUnits(lamports, 9), fix: `Send about ${fmtUnits(roundUp(total + FEE_MARGIN - lamports), 9)} SOL more to this address.` })
  }

  const ix = await program.methods
    .registerAgent()
    .accountsPartial({
      agentWallet: me,
      vault: chain.vaultPda(),
      vaultToken: v.vaultToken,
      agent: chain.agentPda(me),
      tokenProgram: chain.TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  return previewAction({
    connection, me, instructions: [ataIx(me, me), ix], step: 'register',
    extra: {
      registrationFee: SOL(fee),
      oneOffDeposits: SOL(rentAgent + rentAta),
      totalCost: SOL(total),
      note: `The registration fee (${SOL(fee)}) is NOT refunded: it goes into the shared payout vault. The one-off deposits pay for your registration record${needAta ? ' and your wSOL account' : ''}. Registering does not promise any payout: payouts are first come, first served and only while the vault holds money.`,
      thenYouCan: `claim up to ${SOL(big(v.payout))} per payout, at most once every ${fmtDuration(n(v.cooldownSecs))}, while the vault holds at least that much`,
    },
  })
}

// ---------------- claim ----------------
async function claim() {
  const me = agentAddress()
  const { connection, program } = await context()
  const v = await chain.readVault(program)
  const agent = await chain.readAgent(program, me)
  if (!agent) fail('NOT_REGISTERED', 'This wallet is not registered. `uai register` shows the cost (the fee is not refunded) and asks for a yes.', { address: me.toBase58() })

  const now = await chain.chainNow(connection)
  const bal = await chain.vaultBalance(connection, v)
  const q = quoteClaim(termsOf(v), bal, big(agent.lastClaimTs), BigInt(now))
  if (!q.ok) {
    const d = refusalDetails(q.refusal, v, bal, agent)
    fail(d.code, d.message, d.extra)
  }

  const payout = q.payout
  const needAta = !(await hasAccount(connection, chain.wsolAtaOf(me)))
  const rentAta = needAta ? await rentOf(connection, chain.TOKEN_ACCOUNT_BYTES) : 0n
  const lamports = await lamportsOf(connection, me)
  if (lamports < rentAta + FEE_MARGIN) fail('LOW_SOL', `Not enough SOL for the network fee${needAta ? ' and your wSOL account' : ''} (about ${fmtUnits(roundUp(rentAta + FEE_MARGIN), 9)} SOL).`, { address: me.toBase58(), have: fmtUnits(lamports, 9) })

  const ix = await program.methods
    .claimIncome()
    .accountsPartial({
      agentWallet: me,
      vault: chain.vaultPda(),
      agent: chain.agentPda(me),
      payoutMint: chain.WSOL,
      vaultToken: v.vaultToken,
      agentToken: chain.wsolAtaOf(me),
      tokenProgram: chain.TOKEN_PROGRAM,
    })
    .instruction()
  return previewAction({
    connection, me, instructions: [ataIx(me, me), ix], step: 'claim',
    extra: {
      payout: SOL(payout),
      vaultBalance: SOL(bal),
      vaultAfterThisPayout: SOL(bal - payout),
      nextPayoutPossibleAfter: iso(now + n(v.cooldownSecs)),
      note: `The payout arrives as wSOL (wrapped SOL, worth exactly 1 SOL each) in your wallet's token account${needAta ? ' (created now; one-off deposit about ' + SOL(rentAta) + ' from your wallet)' : ''}. \`uai unwrap\` turns it into plain SOL.`,
      warnings: [
        'Payouts are first come, first served. Another agent may take the money before this transaction lands. Then the claim is refused: usually before anything is sent, at worst you lose only the network fee (a fraction of a cent).',
        'The payout is fixed in SOL; its dollar value moves with the price of SOL.',
      ],
    },
  })
}

// ---------------- unwrap (wSOL -> SOL) ----------------
async function unwrap() {
  const me = agentAddress()
  const { connection } = await context()
  const ata = chain.wsolAtaOf(me)
  const info = await connection.getAccountInfo(ata, 'confirmed')
  if (!info) fail('NOTHING_TO_UNWRAP', 'This wallet has no wSOL token account.')
  const bal = BigInt((await connection.getTokenAccountBalance(ata, 'confirmed')).value.amount)
  const ix = spl.createCloseAccountInstruction(ata, me, me, [], chain.TOKEN_PROGRAM)
  return previewAction({
    connection, me, instructions: [ix], step: 'unwrap',
    extra: {
      wsolBalance: SOL(bal),
      solReturned: `${SOL(BigInt(info.lamports))} (the wSOL plus the account's rent)`,
      note: 'Closes the wSOL token account and returns everything in it as plain SOL. The account is created again automatically at the next claim.',
    },
  })
}

// ---------------- execute / tx ----------------
async function execute(opts, flags) {
  const id = opts['request-id']
  if (!id) fail('MISSING_ARG', 'execute needs --request-id <id> from a preview the user has already seen and confirmed.')
  const { connection } = await context()
  const r = await S().execute(id, { force: flags.has('force'), connection })
  if (!r.success) {
    const text = JSON.stringify(r.error || {})
    const hint = r.error && r.error.code === 'SIMULATION_FAILED'
      ? 'The program refuses this right now (for example another agent took the last payout first). Nothing was sent and nothing was charged. Tell the user the reason; run the original command again only if they still want to try.'
      : /expire|blockhash|not found/i.test(text) ? 'The preview (or the transaction in it) has expired. Run the original command again to get a fresh preview, show it to the user and ask for confirmation again.' : undefined
    fail('EXECUTE_FAILED', `${S().label} did not execute the request (its code and message are in \`${S().errorKey}\`).`, { [S().errorKey]: r.error, hint })
  }
  const d = r.data || {}
  if (d.status === 'NEEDS_CONFIRMATION') {
    // the wallet wants an extra confirmation from the human: show `message`, and only on a clear yes repeat with --force
    return {
      success: true,
      status: d.status,
      needsConfirmation: true,
      message: d.message,
      txHash: null,
      next: `Show \`message\` to the user. Only if they clearly confirm, run: uai execute --request-id ${id} --force`,
    }
  }
  return {
    success: true,
    status: d.status,
    txHash: d.txHash || null,
    orderId: d.orderId,
    next: d.txHash ? `uai tx --signature ${d.txHash}` : undefined,
  }
}

const TOKEN_IX_NAMES = { 1: 'InitializeAccount', 3: 'Transfer', 9: 'CloseAccount', 12: 'TransferChecked', 17: 'SyncNative', 18: 'InitializeAccount3' }

/** Plain SPL Token / associated-token instructions often leave no "Instruction:" line in the logs (unwrap is one), so name them from the message. */
function splInstructionNames(message, keys) {
  const names = []
  for (const ix of message.compiledInstructions || []) {
    const program = keys[ix.programIdIndex]
    const first = ix.data && ix.data.length ? ix.data[0] : 0
    if (program.equals(chain.TOKEN_PROGRAM) && TOKEN_IX_NAMES[first]) names.push(TOKEN_IX_NAMES[first])
    else if (program.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID)) names.push(first === 1 ? 'CreateIdempotent' : 'Create')
  }
  return names
}

async function txCommand(opts) {
  const sig = opts.signature || opts.hash
  if (!sig) fail('MISSING_ARG', 'tx needs --signature <transaction signature>.')
  const { connection } = await context()
  const deadline = Date.now() + 90000
  let st
  for (;;) {
    const r = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    st = r.value[0]
    if (st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
    if (Date.now() > deadline) fail('TX_NOT_FOUND', 'The transaction did not show up on chain within 90 seconds. It may have expired without landing; check again later or repeat the action.', { signature: sig })
    await sleep(2000)
  }
  const t = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!t) fail('TX_NOT_FOUND', 'The transaction is confirmed but its details are not available yet; try again in a few seconds.', { signature: sig })
  const keys = t.transaction.message.staticAccountKeys || t.transaction.message.accountKeys
  const payer = keys[0]
  const meta = t.meta
  const idx = new Map()
  const bump = (list, sign) => (list || []).forEach((b) => {
    if (b.owner !== payer.toBase58()) return
    const cur = idx.get(b.accountIndex) || { mint: b.mint, decimals: b.uiTokenAmount.decimals, delta: 0n }
    cur.delta += sign * BigInt(b.uiTokenAmount.amount)
    idx.set(b.accountIndex, cur)
  })
  bump(meta.postTokenBalances, 1n)
  bump(meta.preTokenBalances, -1n)
  const tokenChanges = [...idx.values()].filter((c) => c.delta !== 0n).map((c) => ({ mint: c.mint, change: fmtUnits(c.delta, c.decimals) }))
  const logged = (meta.logMessages || []).filter((l) => l.startsWith('Program log: Instruction:')).map((l) => l.replace('Program log: Instruction: ', ''))
  const instructions = logged.length ? logged : splInstructionNames(t.transaction.message, keys)
  const ok = !meta.err
  return {
    success: ok,
    signature: sig,
    confirmation: st.confirmationStatus || null,
    ...(ok ? {} : { code: 'TX_FAILED', error: 'The transaction landed but failed.', programError: chain.decodeProgramError(meta.err) }),
    feePayer: payer.toBase58(),
    feeSol: fmtUnits(BigInt(meta.fee), 9),
    solChange: fmtUnits(BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]), 9),
    tokenChanges,
    instructions,
    explorer: /localhost|127\.0\.0\.1/.test(CONFIG.rpc) ? undefined : `https://solscan.io/tx/${sig}`,
  }
}

// ---------------- dispatcher ----------------
const HELP = `uai - agent CLI for the UAI payout vault on Solana (signing is done by the user's OKX Agentic Wallet via \`onchainos\`)

  uai preflight                           is everything ready? (wallet signed in, SOL, vault found, registered or not)
  uai status                              the vault: balance, how many payouts it can afford, the three rules, agents (no wallet needed)
  uai me [--address <wallet>]             my registration, my payouts, whether I can claim now
  uai register                            preview: register this wallet (fee + one-off deposits; the fee is not refunded)
  uai claim                               preview: claim the fixed payout (cooldown and vault balance are checked first)
  uai unwrap                              preview: turn my wSOL into plain SOL
  uai execute --request-id <id> [--force] sign and send a previewed action (ONLY after the user said yes; --force only after
                                          a needsConfirmation answer that the user confirmed)
  uai tx --signature <sig>                wait for a transaction and explain what it did
  uai --version

env: UAI_RPC_URL, UAI_MINT (the coin; now: ${CONFIG.mint || 'not set'}), UAI_PROGRAM, UAI_SIGNER (auto or okx; now: ${CONFIG.signer}), UAI_OKX_BIN, UAI_HOME`

/** The version of this package: the root package.json of the published repository, or cli/package.json in the development tree. */
function packageVersion() {
  if (typeof __UAI_VERSION__ === 'string') return __UAI_VERSION__ // set by the bundler (scripts/make_test_kit.sh)
  for (const p of ['../../package.json', '../package.json']) {
    try {
      const j = require(p)
      if (j && j.name === 'uai-cli') return j.version
    } catch { /* try the next location */ }
  }
  return 'unknown'
}

async function run(argv) {
  const { cmd, opts, flags } = parseArgs(argv)
  if (cmd === 'version' || flags.has('version') || argv[0] === '-v') {
    out({ success: true, name: 'uai-cli', version: packageVersion() })
    return
  }
  try {
    let result
    switch (cmd) {
      case 'preflight': result = await preflight(); break
      case 'status': result = await status(); break
      case 'me': result = await me(opts); break
      case 'register': result = await register(); break
      case 'claim': result = await claim(); break
      case 'unwrap': result = await unwrap(); break
      case 'execute': result = await execute(opts, flags); break
      case 'tx': result = await txCommand(opts); break
      default:
        console.log(HELP)
        process.exitCode = cmd ? 1 : 0
        return
    }
    out(result)
    // a landed-but-failed transaction is a failure too; preflight reports problems in its JSON and keeps exit code 0
    if (cmd !== 'preflight' && result && result.success === false) process.exitCode = 1
  } catch (e) {
    if (e instanceof CliError) {
      out({ success: false, code: e.code, error: e.message, ...e.extra })
    } else {
      out({ success: false, code: 'UNEXPECTED', error: String((e && e.message) || e).slice(0, 600) })
    }
    process.exitCode = 1
  }
}

module.exports = { run }
