'use strict'

// The claim rule, a copy of `quote_claim` in programs/uai/src/lib.rs. First come, first served: an agent is paid exactly
// `payout` when its cooldown is over AND the vault holds at least that much; the amount depends on nothing else.
// The test `skill/test/rule.test.js` checks this copy against the same generated cases the program is checked against.

const I64_MAX = (1n << 63n) - 1n

/**
 * @param {{cooldownSecs: bigint, payout: bigint}} terms
 * @param {bigint} vaultBalance  lamports in the vault's wSOL account right now
 * @param {bigint} lastClaimTs   unix time of the agent's last payout (0 = never paid)
 * @param {bigint} now           unix time (the chain's clock)
 * @returns {{ok: true, payout: bigint} | {ok: false, refusal: {kind: string}}}
 */
function quoteClaim(terms, vaultBalance, lastClaimTs, now) {
  if (lastClaimTs !== 0n) {
    const nextAt = lastClaimTs + terms.cooldownSecs
    if (nextAt > I64_MAX) return { ok: false, refusal: { kind: 'MathOverflow' } }
    if (now < nextAt) return { ok: false, refusal: { kind: 'CooldownActive', nextAt } }
  }
  if (vaultBalance < terms.payout) return { ok: false, refusal: { kind: 'VaultTooLow', balance: vaultBalance, payout: terms.payout } }
  return { ok: true, payout: terms.payout }
}

module.exports = { quoteClaim }
