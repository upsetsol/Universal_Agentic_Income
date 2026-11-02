'use strict'

// Configuration comes from environment variables.
//
//   UAI_RPC_URL     Solana RPC (default: the public mainnet endpoint; use your own provider for heavy use)
//   UAI_MINT        the UAI coin; the payout vault is found from it. The published copy of this skill has the real coin built in.
//   UAI_PROGRAM     program id (default: the address inside the bundled IDL)
//   UAI_SIGNER      which wallet signs: "auto" (default) or "okx". Only the OKX Agentic Wallet (CLI `onchainos`) is supported.
//   UAI_OKX_BIN     path of the OKX CLI `onchainos` (default: `onchainos` from PATH)
//   UAI_HOME        folder for the stored previews (default: ~/.uai)

const IDL = require('../idl/uai.json')

/** Filled in by the bundler (scripts/make_test_kit.sh replaces __UAI_MINT__) once the coin exists. Until then UAI_MINT must be set. */
const DEFAULT_MINT = typeof __UAI_MINT__ === 'string' ? __UAI_MINT__ : ''

const CONFIG = {
  rpc: process.env.UAI_RPC_URL || 'https://api.mainnet-beta.solana.com',
  mint: process.env.UAI_MINT || DEFAULT_MINT,
  program: process.env.UAI_PROGRAM || IDL.address,
  signer: (process.env.UAI_SIGNER || 'auto').toLowerCase(),
  okxBin: process.env.UAI_OKX_BIN || 'onchainos',
  home: process.env.UAI_HOME || require('node:path').join(require('node:os').homedir(), '.uai'),
}

module.exports = { CONFIG, IDL }
