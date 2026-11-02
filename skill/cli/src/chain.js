'use strict'

// Everything that READS the chain. Nothing here needs a key.

const anchor = require('@coral-xyz/anchor')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const { CONFIG, IDL } = require('./config')
const { sleep, fail } = require('./util')

const { PublicKey, Connection } = web3

const PROGRAM_ID = new PublicKey(CONFIG.program)
/** The payout asset (wSOL) is a classic SPL token. */
const TOKEN_PROGRAM = spl.TOKEN_PROGRAM_ID
/** The UAI coin itself is a Token-2022 token. */
const COIN_TOKEN_PROGRAM = spl.TOKEN_2022_PROGRAM_ID
const ATA_PROGRAM = spl.ASSOCIATED_TOKEN_PROGRAM_ID
const WSOL = spl.NATIVE_MINT
/** Sizes of the accounts the program creates for an agent (8-byte discriminator included): the Agent record and a token account. */
const AGENT_RECORD_BYTES = 73
const TOKEN_ACCOUNT_BYTES = 165

/** The coin the vault belongs to; fails with a clear message when nothing is configured. */
let _coin
function coinMint() {
  if (_coin) return _coin
  if (!CONFIG.mint) fail('NOT_CONFIGURED', 'The UAI coin address is not set. Set UAI_MINT=<coin address> (the published copy of this skill has it built in).')
  try {
    _coin = new PublicKey(CONFIG.mint)
  } catch {
    fail('NOT_CONFIGURED', `UAI_MINT is not a valid Solana address: ${CONFIG.mint}`)
  }
  return _coin
}

// ---------------- flaky public RPCs: repeat a request when the connection is cut ----------------
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|UND_ERR|other side closed|terminated/i
async function retryFetch(input, init) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(input, init)
      if ((res.status >= 500 || res.status === 429) && i < 5) {
        try { await res.arrayBuffer() } catch { /* drain */ }
        await sleep(800 * (i + 1))
        continue
      }
      return res
    } catch (e) {
      const msg = [e && e.message, e && e.cause && e.cause.message, e && e.cause && e.cause.code, e && e.code].filter(Boolean).join(' ')
      if (i >= 5 || !TRANSIENT.test(msg)) throw e
      await sleep(800 * (i + 1))
    }
  }
}

function makeConnection(url = CONFIG.rpc) {
  return new Connection(url, { commitment: 'confirmed', fetch: retryFetch })
}

/** A read-only Anchor program: the wallet is a dummy because this CLI never signs. */
function loadProgram(connection) {
  const dummy = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }
  const provider = new anchor.AnchorProvider(connection, dummy, { commitment: 'confirmed' })
  return new anchor.Program({ ...IDL, address: PROGRAM_ID.toBase58() }, provider)
}

// ---------------- addresses ----------------
const vaultPda = () => PublicKey.findProgramAddressSync([Buffer.from('vault'), coinMint().toBuffer()], PROGRAM_ID)[0]
const agentPda = (wallet) => PublicKey.findProgramAddressSync([Buffer.from('agent'), vaultPda().toBuffer(), wallet.toBuffer()], PROGRAM_ID)[0]
/** A wallet's account for the payout asset (wSOL): payouts arrive here. */
const wsolAtaOf = (owner) => spl.getAssociatedTokenAddressSync(WSOL, owner, true, TOKEN_PROGRAM, ATA_PROGRAM)

// ---------------- reads ----------------
async function readVault(program) {
  const v = await program.account.vault.fetchNullable(vaultPda())
  if (!v) fail('VAULT_NOT_FOUND', `No payout vault found for coin ${coinMint().toBase58()} under program ${PROGRAM_ID.toBase58()} (check UAI_MINT / UAI_RPC_URL).`)
  return v
}

async function readAgent(program, wallet) {
  return program.account.agent.fetchNullable(agentPda(wallet))
}

/** The vault's wSOL balance in lamports (0 when the account cannot be read). */
async function vaultBalance(connection, vault) {
  try {
    return BigInt((await connection.getTokenAccountBalance(vault.vaultToken, 'confirmed')).value.amount)
  } catch {
    return 0n
  }
}

/** The chain's own clock (what the program sees), not the computer's. */
async function chainNow(connection) {
  const info = await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'confirmed')
  return info ? Number(info.data.readBigInt64LE(32)) : Math.floor(Date.now() / 1000)
}

async function coinMeta(connection) {
  let name = null
  let symbol = null
  try {
    const md = await spl.getTokenMetadata(connection, coinMint(), 'confirmed', COIN_TOKEN_PROGRAM)
    if (md) { name = md.name; symbol = md.symbol }
  } catch { /* metadata is optional */ }
  return { name, symbol }
}

// ---------------- program errors ----------------
const ERR_BY_CODE = new Map((IDL.errors || []).map((e) => [e.code, e]))
/** simulateTransaction / getTransaction error -> { code, name, message } when it is one of ours. */
function decodeProgramError(err) {
  if (err && err.InstructionError) {
    const [index, e] = err.InstructionError
    if (e && typeof e === 'object' && 'Custom' in e) {
      const info = ERR_BY_CODE.get(e.Custom)
      return { instruction: index, code: e.Custom, name: info ? info.name : undefined, message: info ? info.msg : undefined }
    }
    return { instruction: index, raw: e }
  }
  return { raw: err }
}

module.exports = {
  PROGRAM_ID, WSOL, TOKEN_PROGRAM, COIN_TOKEN_PROGRAM, ATA_PROGRAM, AGENT_RECORD_BYTES, TOKEN_ACCOUNT_BYTES,
  coinMint, makeConnection, loadProgram, vaultPda, agentPda, wsolAtaOf,
  readVault, readAgent, vaultBalance, chainNow, coinMeta, decodeProgramError,
}
