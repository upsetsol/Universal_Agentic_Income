#!/usr/bin/env bash
# Builds the RELEASE ZIP of the skill: a zip with ONE folder, `uai/`, that is put into
# <home>/.claude/skills/. It holds the skill (SKILL.md, references/) and the whole `uai` command as a single file, cli/uai.js, with
# the coin's address built in, so the only thing the person needs besides Claude Code and the OKX wallet CLI is Node.js.
#
#   bash scripts/build_release.sh
#
# The coin's address comes from UAI_MINT.
# Settings: UAI_KIT_OUT  where to build (default dist)     UAI_KIT_TOOLS  where the pinned bundler is kept (default dist/.tools)
# Network: only once, to fetch the pinned bundler (esbuild) from the npm registry into UAI_KIT_TOOLS. Nothing is published anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD_VERSION=0.28.2   # published 2026-08-08; pinned so that the same sources give the same bundle
OUT=${UAI_KIT_OUT:-dist}
TOOLS=${UAI_KIT_TOOLS:-dist/.tools}
KIT=$OUT/uai
VERSION=$(node -p "require('./skill/cli/package.json').version")
ZIP=$OUT/uai-skill.zip

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

MINT=${UAI_MINT:-}
[ -n "$MINT" ] || die "set UAI_MINT=<the coin's address>"
printf '%s' "$MINT" | grep -Eq '^[1-9A-HJ-NP-Za-km-z]{32,44}$' || die "the coin address looks wrong: $MINT"

cmp -s idl/uai.json skill/cli/idl/uai.json || die "idl/uai.json and skill/cli/idl/uai.json differ"
for f in skill/SKILL.md skill/references/setup.md skill/references/claim.md skill/references/preflight.md skill/cli/bin/uai.js; do [ -f "$f" ] || die "missing $f"; done

if [ ! -x "$TOOLS/node_modules/.bin/esbuild" ]; then
  echo "fetching the pinned bundler esbuild@$ESBUILD_VERSION into $TOOLS (once)..."
  mkdir -p "$TOOLS"
  [ -f "$TOOLS/package.json" ] || printf '{"name":"uai-kit-tools","private":true}\n' > "$TOOLS/package.json"
  npm install --prefix "$TOOLS" "esbuild@$ESBUILD_VERSION" --save-exact --no-audit --no-fund --ignore-scripts --loglevel=error
fi
[ "$("$TOOLS/node_modules/.bin/esbuild" --version)" = "$ESBUILD_VERSION" ] || die "the bundler in $TOOLS is not esbuild@$ESBUILD_VERSION"

# two harmless warnings of the libraries would be printed on every call and only confuse the agent that reads the output
BANNER="process.noDeprecation = true; { const w = console.warn; console.warn = (...a) => { if (!String(a[0]).startsWith('bigint: Failed to load bindings')) w.apply(console, a); }; }"

# the command's own libraries (exact versions from skill/cli/package-lock.json) when no parent folder provides them
if ! node -e "require.resolve('@solana/web3.js', { paths: ['skill/cli'] })" 2> /dev/null; then
  echo "installing the command's libraries from skill/cli/package-lock.json..."
  npm ci --prefix skill/cli --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
fi

rm -rf "$KIT"; mkdir -p "$KIT/cli" "$KIT/references"
"$TOOLS/node_modules/.bin/esbuild" skill/cli/bin/uai.js --bundle --platform=node --target=node18 --format=cjs \
  --outfile="$KIT/cli/uai.js" --define:__UAI_MINT__="\"$MINT\"" --define:__UAI_VERSION__="\"$VERSION\"" --banner:js="$BANNER" --legal-comments=none --log-level=warning
cp skill/references/claim.md skill/references/preflight.md "$KIT/references/"

# the kit's copies of SKILL.md and setup.md: the command is a file inside the skill folder, not an installed program
KIT_DIR=$KIT python3 - <<'PYEOF'
import os, re
kit = os.environ["KIT_DIR"]

def edit(src, dst, pairs):
    s = open(src, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (src, old[:60])
        s = s.replace(old, new)
    open(dst, "w", encoding="utf-8").write(s)

RUN = """## Running the `uai` command

In this copy of the skill the `uai` command is a single file inside the skill folder. Wherever this skill says `uai <command>`,
run exactly this (Node.js 18 or newer must be installed):

    node "${CLAUDE_SKILL_DIR}/cli/uai.js" <command>

"""
edit("skill/SKILL.md", kit + "/SKILL.md", [
    ("  requires:\n    bins: [uai]\n", ""),
    ("## The usual flow (\"claim my payout\")\n", RUN + "## The usual flow (\"claim my payout\")\n"),
    ("1. **`uai` itself is missing** (`command not found`). Tell the user that the helper tool is not installed. The only install command\n   you may suggest is the one in [setup.md](references/setup.md); never guess a package name and never run a script from the internet.\n   After the user has installed it, run `uai preflight` (it also reports what else is missing).",
     "1. **Node.js is missing** (`node` is not found). Tell the user to install Node.js (LTS) from https://nodejs.org, then open a new terminal.\n   Never guess another install source and never run a script from the internet. After that, run `uai preflight` (it also reports what else is missing)."),
])
edit("skill/references/setup.md", kit + "/references/setup.md", [
    ("The `uai` command comes with the skill: the release zip puts it into `cli/uai.js` next to `SKILL.md`. If it is missing, tell the\nuser to install the skill again from the project's release page. Do not guess a package name and do not install anything on your own.",
     "In this copy of the skill the `uai` command is the file `cli/uai.js` next to `SKILL.md`; nothing has to be installed except Node.js 18 or\nnewer (https://nodejs.org). Do not install anything else on your own."),
])
print("kit texts written")
PYEOF

# nothing that points to the maker of the kit may be in it: no local paths
PATTERN='/Us[e]rs/|/home/[a-z]'
if grep -r -n -i -E "$PATTERN" "$KIT" > /dev/null; then
  grep -r -n -i -E "$PATTERN" "$KIT" | cut -c1-200 | head -5
  die "the kit contains something that must not be published (see above); it was NOT zipped"
fi

( cd "$OUT" && rm -f "$(basename "$ZIP")" && zip -q -r -X "$(basename "$ZIP")" uai )
echo "kit:      $ZIP ($(wc -c < "$ZIP" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$ZIP" | cut -c1-16)...)"
echo "coin:     $MINT"
echo "cli:      $KIT/cli/uai.js ($(wc -c < "$KIT/cli/uai.js" | tr -d ' ') bytes)"
