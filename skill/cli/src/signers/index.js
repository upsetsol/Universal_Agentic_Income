'use strict'

// Picks the wallet that signs. Only the OKX Agentic Wallet (CLI `onchainos`) is supported.
//   UAI_SIGNER=okx   -> the OKX wallet
//   UAI_SIGNER=auto (default) -> the OKX wallet when its CLI is installed (signed in or not, so that `preflight` can say how to sign in);
//   if it is not installed, `none` (explains what to install).
const { CONFIG } = require('../config')
const { CliError } = require('../util')

let chosen

function detect() {
  try {
    require('./okx').quickState()
    return 'okx'
  } catch {
    return 'none'
  }
}

function getSigner() {
  if (chosen) return chosen
  const want = CONFIG.signer
  if (!['auto', 'okx'].includes(want)) throw new CliError('BAD_SIGNER', `UAI_SIGNER must be "auto" or "okx" (got "${want}"). Only the OKX Agentic Wallet is supported.`)
  const name = want === 'auto' ? detect() : want
  // literal requires, so that a bundler finds both modules
  const impl = name === 'okx' ? require('./okx') : require('./none')
  chosen = { ...impl, chosenBy: want === 'auto' ? 'auto-detected' : 'UAI_SIGNER' }
  return chosen
}

module.exports = { getSigner }
