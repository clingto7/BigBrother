#!/bin/sh
set -eu

for command in git node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Big Brother requires $command" >&2
    exit 1
  fi
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 8) ? 0 : 1)' ; then
  echo 'Big Brother requires Node.js >=22.8.0' >&2
  exit 1
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$project_root/runtime/dist/bundle/cli.js" ]; then
  echo 'Bundled Prime runtime is missing' >&2
  exit 1
fi

version=$(cat "$project_root/VERSION")
runtime_deps="$HOME/.local/share/big-brother/runtime-deps/$version"
mkdir -p "$runtime_deps" "$project_root/runtime/node_modules/@silvia-odwyer" "$HOME/.local/bin"
npm install --prefix "$runtime_deps" --no-save --no-package-lock --omit=dev \
  'undici@7.29.0' '@silvia-odwyer/photon-node@0.3.4'

link_if_absent() {
  target=$1
  link=$2
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    return
  fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "Refusing to replace existing path: $link" >&2
    exit 1
  fi
  ln -s "$target" "$link"
}

link_if_absent "$runtime_deps/node_modules/undici" "$project_root/runtime/node_modules/undici"
link_if_absent "$runtime_deps/node_modules/@silvia-odwyer/photon-node" \
  "$project_root/runtime/node_modules/@silvia-odwyer/photon-node"

cli_link="$HOME/.local/bin/big-brother"
cli_target="$project_root/bin/big-brother"
if [ -L "$cli_link" ] && [ "$(readlink "$cli_link")" != "$cli_target" ]; then
  previous_target=$(readlink "$cli_link")
  case "$previous_target" in
    /*/bin/big-brother)
      previous_root=$(CDPATH= cd -- "$(dirname -- "$previous_target")/.." && pwd)
      if [ ! -f "$previous_root/VERSION" ] || [ ! -f "$previous_target" ]; then
        echo "Refusing to replace unrecognized CLI link: $cli_link" >&2
        exit 1
      fi
      replacement="$cli_link.tmp.$$"
      ln -s "$cli_target" "$replacement"
      mv -f "$replacement" "$cli_link"
      ;;
    *) echo "Refusing to replace unrecognized CLI link: $cli_link" >&2; exit 1 ;;
  esac
else
  link_if_absent "$cli_target" "$cli_link"
fi

node "$project_root/runtime/dist/bundle/cli.js" --version >/dev/null 2>&1
"$project_root/bin/big-brother" --version
echo "Installed Big Brother at $project_root"
echo "Add $HOME/.local/bin to PATH, then follow $project_root/README.md to configure GitHub and Prime."
