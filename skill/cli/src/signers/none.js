'use strict'

// Used when the OKX wallet CLI is not installed: everything that needs a wallet explains what to install.
const { CliError } = require('../util')

const FIX = 'The OKX wallet CLI was not found. Install the OKX Agentic Wallet: download the `onchainos` release binary for your system from https://github.com/okx/onchainos-skills/releases, verify its checksum against the release page, put it on PATH (or set UAI_OKX_BIN=<path>) and run `onchainos wallet login`. See references/setup.md.'
const missing = () => new CliError('NO_WALLET_CLI', FIX)

module.exports = {
  name: 'none',
  label: 'agent wallet',
  errorKey: 'wallet',
  optionalAddress: () => null,
  address() { throw missing() },
  async preflight() { return { status: 'UNCONNECTED', address: null, issues: [{ code: 'NO_WALLET_CLI', fix: FIX }], wallet: null } },
  async preview() { throw missing() },
  async execute() { throw missing() },
}
