# Universal_Agentic_Income

Lets your AI agent register in **UAI** and claim payouts through an OKX Agentic Wallet.
- **Payout:** 0.1 SOL, once per 6 hours per wallet, only while the payout vault holds at least 0.1 SOL. First come, first served.
- **Registration:** 0.01 SOL fee


**You need:** Windows 10/11, macOS or Linux. Claude Pro or higher (or an Anthropic Console account) for Claude Code. About 0.03 SOL for the agent wallet.
Windows: use PowerShell. macOS/Linux: use Terminal. Open a new window after each install.

## 1. Node.js 18+

Windows (type `Y` if asked about agreements):

```powershell
winget install OpenJS.NodeJS.LTS
```

macOS: `brew install node`. Linux and others: https://nodejs.org

## 2. Claude Code

Windows:

```powershell
irm https://claude.ai/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Check `claude --version`. If Windows does not find `claude`, run this once and open a new window:

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$HOME\.local\bin", "User")
```

Run `claude`, sign in, type `/exit`.

## 3. OKX Agentic Wallet

**Windows** (ARM PC: `aarch64` instead of `x86_64`):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
mkdir "$HOME\onchainos"; cd "$HOME\onchainos"
Invoke-WebRequest "https://github.com/okx/onchainos-skills/releases/latest/download/onchainos-x86_64-pc-windows-msvc.exe" -OutFile onchainos.exe
Invoke-WebRequest "https://github.com/okx/onchainos-skills/releases/latest/download/checksums.txt" -OutFile checksums.txt
$mine = (Get-FileHash .\onchainos.exe -Algorithm SHA256).Hash.ToLower()
if ($mine -and ((Get-Content .\checksums.txt) -match $mine)) { "OK: checksum matches" } else { "STOP: checksum differs, do not run the file" }
```

Only after `OK`, add it to PATH and open a new window:

```powershell
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$HOME\onchainos", "User")
```

Log in (run the first line once, it starts a new session):

```powershell
$login = onchainos wallet login | ConvertFrom-Json
onchainos wallet login --phase poll --session-id $login.data.authSessionId
```

**macOS / Linux.** Your file: Apple Silicon `onchainos-aarch64-apple-darwin`, Intel Mac `onchainos-x86_64-apple-darwin`, Linux `onchainos-x86_64-unknown-linux-gnu` or `onchainos-aarch64-unknown-linux-gnu`. Put it into the first line:

```bash
F=onchainos-aarch64-apple-darwin
U=https://github.com/okx/onchainos-skills/releases/latest/download
mkdir -p ~/.local/bin ~/onchainos-download && cd ~/onchainos-download
curl -fL -o onchainos "$U/$F"
curl -fL -o checksums.txt "$U/checksums.txt"
H=$( (sha256sum onchainos 2>/dev/null || shasum -a 256 onchainos) | cut -d' ' -f1 )
[ -n "$H" ] && grep -q "$H" checksums.txt && echo "OK: checksum matches" || echo "STOP: checksum differs, do not run the file"
```

Only after `OK`, install it and log in (run the login line once, it starts a new session):

```bash
chmod +x onchainos && mv onchainos ~/.local/bin/ && cd ~
onchainos wallet login
onchainos wallet login --phase poll
```

If `onchainos` is not found: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc` (`~/.bashrc` for bash), then a new terminal.

**Both:** sign in with Google, Apple or email in the browser (open the printed link if none opens). The second command waits up to 5 minutes and ends with `"ok": true`. Then:

```
onchainos wallet addresses --chain solana
```

Send about 0.03 SOL to this address, **Solana network only**.

## 4. UAI skill

Windows:

```powershell
Invoke-WebRequest "https://github.com/upsetsol/Universal_Agentic_Income/releases/latest/download/uai-skill.zip" -OutFile "$HOME\uai-skill.zip"
Expand-Archive "$HOME\uai-skill.zip" -DestinationPath "$HOME\.claude\skills" -Force
node "$HOME\.claude\skills\uai\cli\uai.js" status
```

macOS / Linux:

```bash
mkdir -p ~/.claude/skills && curl -fL -o ~/uai-skill.zip https://github.com/upsetsol/Universal_Agentic_Income/releases/latest/download/uai-skill.zip && unzip -o ~/uai-skill.zip -d ~/.claude/skills
node ~/.claude/skills/uai/cli/uai.js status
```

`status` only reads. Its coin must be the one above.

## 5. Use

Run `claude` in any folder and allow its commands. Say:

- `Check if my wallet is ready for UAI`
- `How much is in the UAI vault?`
- `Register me for UAI` (about 0.0125 SOL in total)
- `Claim my UAI payout` (0.1 SOL)
- `Turn my wSOL into SOL` (payouts arrive as wSOL)
