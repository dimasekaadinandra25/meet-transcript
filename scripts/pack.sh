#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE=chrome
case "${1:-}" in
  '') ;;
  --release) MODE=release ;;
  --firefox) MODE=firefox ;;
  *) echo "pack: argumen tak dikenal: $1" >&2; exit 1 ;;
esac

ITEMS=(manifest.json README.md README.en.md LICENSE background panel popup content offscreen lib icons)

for it in "${ITEMS[@]}" manifest.firefox.json; do
  [ -e "$it" ] || { echo "pack: '$it' tidak ada — perbaiki ITEMS di pack.sh" >&2; exit 1; }
done

VER="$(node -p "require('./manifest.json').version")"
NAME="transcripables"

FVER="$(node -p "require('./manifest.firefox.json').version")"
[ "$VER" = "$FVER" ] || { echo "pack: versi tidak sinkron — manifest.json $VER, manifest.firefox.json $FVER" >&2; exit 1; }

mkdir -p "$ROOT/dist"

stage() {
  local flavor="$1"
  STAGE_DIR="$(mktemp -d)/$NAME"
  mkdir -p "$STAGE_DIR"
  for it in "${ITEMS[@]}"; do cp -R "$it" "$STAGE_DIR/"; done
  if [ "$flavor" = firefox ]; then
    rm -rf "$STAGE_DIR/offscreen"
    cp manifest.firefox.json "$STAGE_DIR/manifest.json"
  fi
  find "$STAGE_DIR" -name '.DS_Store' -delete
}

zip_stage() {
  local dir="$1" out="$2" tmp="${2%.zip}.tmp.zip"
  rm -f "$tmp"
  if command -v zip >/dev/null; then
    ( cd "$dir" && zip -rq "$tmp" . )
  else
    ( cd "$dir" && "${SYSTEMROOT:?zip is not installed}/System32/tar.exe" -a -cf "$tmp" -- * )
  fi
  mv -f "$tmp" "$out"
  rm -rf "$(dirname "$dir")"
  echo "pack: $out"
}

build_chrome() { stage chrome; zip_stage "$STAGE_DIR" "$ROOT/dist/${NAME}-v${VER}.zip"; }

build_firefox() {
  stage firefox
  npx --yes web-ext lint --source-dir "$STAGE_DIR" \
    || { rm -rf "$(dirname "$STAGE_DIR")"; echo "pack: web-ext lint gagal" >&2; exit 1; }
  zip_stage "$STAGE_DIR" "$ROOT/dist/${NAME}-firefox-v${VER}.zip"
}

case "$MODE" in
  chrome)  build_chrome ;;
  firefox) build_firefox ;;
  release)
    build_chrome
    gh release create "v$VER" \
      "$ROOT/dist/${NAME}-v${VER}.zip" \
      --title "v$VER" \
      --notes "Ekstensi Transcripables untuk tim.

**Chrome / Edge / Brave / Opera (Load unpacked):**
1. Download \`${NAME}-v${VER}.zip\` di bawah (Assets).
2. Extract ke folder tetap.
3. \`chrome://extensions\` (Edge: \`edge://extensions\`, dst) → Developer mode → Load unpacked → pilih folder itu.

**Firefox:**
Pasang dari halaman resmi (caption-only — tanpa rekam audio/STT):
https://addons.mozilla.org/en-US/firefox/addon/meet-transcript/

Isi ZIP hanya file ekstensi (tanpa docs/test). Detail di README."
    echo "pack: rilis v$VER dibuat"
    ;;
esac

if [ "$MODE" != release ]; then
  echo "pack: siap. Untuk publish: ./scripts/pack.sh --release"
fi
