# Setting up

Read this when `uai` is missing or `uai preflight` reports that something is missing.

The `uai` command comes with the skill: the release zip puts it into `cli/uai.js` next to `SKILL.md`. If it is missing, tell the
user to install the skill again from the project's release page. Do not guess a package name and do not install anything on your own.

## The OKX Agentic Wallet (what signs)

The wallet's key lives in OKX's secure enclave; neither this CLI nor you ever see it. The user does these steps, you only guide:

1. Download the `onchainos` release binary for the user's system from https://github.com/okx/onchainos-skills/releases (for Apple
   Silicon: `onchainos-aarch64-apple-darwin`) and verify it against the release's `checksums.txt` (`shasum -a 256 <file>`). Then
   `chmod +x` it and put it on PATH (or set `UAI_OKX_BIN=<path>`).
   On Windows (64-bit Intel/AMD) the file is `onchainos-x86_64-pc-windows-msvc.exe`: check it in PowerShell with
   `(Get-FileHash .\<file> -Algorithm SHA256).Hash`, compare with its line in `checksums.txt`, and save it as `onchainos.exe` in a
   folder that is on PATH (or set `UAI_OKX_BIN` to its full path). The command must resolve to an `.exe`: a `.cmd` or `.ps1` wrapper is
   not found by this CLI. OKX also offers its own installer (`npx -y @okxweb3/onchainos-installer install`); this skill has only
   been tried with the release binary.
2. `onchainos wallet login` (Google / Apple / email in the browser), then the `completeLogin` command it prints
   (`wallet login --phase poll --session-id ...`). Afterwards `onchainos wallet addresses --chain solana` shows the Solana address.
3. In the OKX web portal (https://web3.okx.com/portfolio/agentic-wallet-policy) the user sets small limits: per transaction, per day,
   transfer whitelist. A new wallet starts with a per-transaction limit of about $5; whether these limits also apply to program
   calls is not documented by OKX, so `uai preflight` shows the policy (`wallet.policy`) and the user decides.
4. About 0.02 SOL on that Solana address covers registration (0.01 SOL fee + about 0.0025 SOL one-off account deposits + network
   fees). Claiming later needs only network fees.

macOS note: `npm install -g` without admin rights fails with `EACCES`; the workaround is `npm config set prefix ~/.npm-global` and
adding `~/.npm-global/bin` to PATH.
