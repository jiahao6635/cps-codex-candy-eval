#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TOOLCHAIN="${RUST_TOOLCHAIN:-1.99.1}"
TARGET="${1:-aarch64-apple-darwin}"
mkdir -p .build dist
(cd engine && go test -race ./... && go vet ./... && go build -trimpath -o ../.build/candy-engine .)
export CANDY_ENGINE_BINARY="$ROOT/.build/candy-engine"
cargo "+$TOOLCHAIN" fmt --manifest-path backend/Cargo.toml -- --check
cargo "+$TOOLCHAIN" clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
cargo "+$TOOLCHAIN" test --locked --manifest-path backend/Cargo.toml
case "$TARGET" in
  aarch64-apple-darwin)
    BUILD_TARGET="$TARGET"
    ;;
  x86_64-unknown-linux-gnu)
    BUILD_TARGET=x86_64-unknown-linux-musl
    (cd engine && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ../.build/candy-engine-linux .)
    export CANDY_ENGINE_BINARY="$ROOT/.build/candy-engine-linux"
    # The CPS package contract names the Linux OS/CPU; both executables are static Linux ELF.
    if [[ "$(uname -s)" == Darwin ]]; then
      RUST_SYSROOT="$(rustc "+$TOOLCHAIN" --print sysroot)"
      RUST_HOST="$(rustc "+$TOOLCHAIN" -vV | sed -n 's/^host: //p')"
      export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$RUST_SYSROOT/lib/rustlib/$RUST_HOST/bin/rust-lld"
    fi
    ;;
  *) echo "Unsupported target: $TARGET" >&2; exit 2 ;;
esac
cargo "+$TOOLCHAIN" build --release --locked --manifest-path backend/Cargo.toml --target "$BUILD_TARGET"
"${CPR_PLUGIN_BIN:-cpr-plugin}" package --manifest "$ROOT/plugin.json" \
  --binary "$ROOT/backend/target/$BUILD_TARGET/release/cps-codex-candy-eval" \
  --target "$TARGET" --output-dir "$ROOT/dist"
VERSION="$(python3 -c 'import json; print(json.load(open("plugin.json"))["version"])')"
python3 scripts/package-check.py --protocol-version 5 dist/local.codex-candy-eval-"$VERSION"-*.tar.gz
