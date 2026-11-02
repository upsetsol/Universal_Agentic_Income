# Preflight

`uai preflight` checks everything the other commands depend on, in one call:

- the OKX wallet CLI is installed and signed in (`status: CONNECTED`);
- the wallet has a Solana address;
- the wallet's policy (per-transaction / daily limits) is shown under `wallet.policy`; it is set by the user in the OKX web portal;
- the wallet holds enough SOL: for an unregistered wallet the registration fee + one-off account deposits + network fees (about
  0.0125 SOL), for a registered one only network fees (and the wSOL account deposit if that account is missing);
- the vault exists for the configured coin and network, and whether this wallet is `registered`.

Output: `success` is true when `issues` is empty. `notes` are information, not problems (for example "this wallet is not registered
yet"). Pass every `issues[].fix` to the user as written. Run it first in a session and again after any policy / risk / blocked error.

Settings you cannot change from here: the OKX policy limits. Ask the user to do it on the OKX website and run preflight again.
