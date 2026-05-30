#!/usr/bin/env bash
#
# mind-cli installer — fetches the CLI from GitHub, installs its deps, and drops
# a `mind` launcher on your PATH. Re-run it any time to update.
#
#   curl -fsSL https://raw.githubusercontent.com/MIND-Studio/mind-cli/main/install.sh | bash
#
# Env overrides:
#   MIND_CLI_REF   tag/branch to install (default: latest release tag, else main)
#   MIND_CLI_HOME  where the source lives (default: ~/.local/share/mind-cli)
#   MIND_CLI_BIN   where the `mind` shim goes (default: ~/.local/bin)
#
set -euo pipefail

REPO="MIND-Studio/mind-cli"
REF="${MIND_CLI_REF:-}"
DEST="${MIND_CLI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/mind-cli}"
BIN_DIR="${MIND_CLI_BIN:-$HOME/.local/bin}"

c_info='\033[36m'; c_ok='\033[32m'; c_err='\033[31m'; c_dim='\033[2m'; c_off='\033[0m'
info() { printf "${c_info}▸${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}✓${c_off} %s\n" "$*"; }
die()  { printf "${c_err}✗${c_off} %s\n" "$*" >&2; exit 1; }

# --- prerequisites --------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js >=20 is required but not found. Install it from https://nodejs.org and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js >=20 required (found $(node -v)). Please upgrade."
command -v npm  >/dev/null 2>&1 || die "npm is required but not found."
command -v curl >/dev/null 2>&1 || die "curl is required but not found."
command -v tar  >/dev/null 2>&1 || die "tar is required but not found."

# --- resolve the ref to install -------------------------------------------
if [ -z "$REF" ]; then
  info "Resolving latest release…"
  REF="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tag_name||"")}catch{process.stdout.write("")}})' \
        || true)"
  [ -n "$REF" ] || REF="main"
fi
info "Installing mind-cli (${REF}) → ${DEST}"

# --- download + extract ----------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="https://github.com/${REPO}/archive/${REF}.tar.gz"
curl -fsSL "$TARBALL" -o "$TMP/src.tgz" \
  || die "Could not download ${TARBALL} — check that ref '${REF}' exists."

rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/src.tgz" -C "$DEST" --strip-components=1

# --- install runtime deps --------------------------------------------------
info "Installing dependencies (npm)…"
( cd "$DEST" && npm install --omit=dev --no-audit --no-fund --loglevel=error )

# --- drop the launcher -----------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/mind" <<EOF
#!/usr/bin/env bash
exec node "$DEST/bin/mind.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/mind"

VERSION="$(node -p "require('$DEST/package.json').version" 2>/dev/null || echo '?')"
ok "Installed mind v${VERSION} → ${BIN_DIR}/mind"

# --- PATH hint -------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) printf "${c_dim}Run \`mind --help\` to get started.${c_off}\n" ;;
  *)
    printf "\n${c_info}One more step:${c_off} %s is not on your PATH.\n" "$BIN_DIR"
    printf "Add this to your shell profile (~/.zshrc or ~/.bashrc):\n\n"
    printf "    export PATH=\"%s:\$PATH\"\n\n" "$BIN_DIR"
    printf "${c_dim}Then open a new terminal and run \`mind --help\`.${c_off}\n"
    ;;
esac
