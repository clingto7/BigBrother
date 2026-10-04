#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo 'usage: sh scripts/build-release.sh <output-directory>' >&2
  exit 2
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cat "$project_root/VERSION")
case "$version" in
  *[!A-Za-z0-9.-]*|'') echo 'invalid VERSION' >&2; exit 1 ;;
esac

output_dir=$1
mkdir -p "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd)
staging_dir=$(mktemp -d)
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM
release_root="$staging_dir/big-brother-$version"
mkdir -p "$release_root/bin" "$release_root/config" "$release_root/docs" \
  "$release_root/packages/big-brother" "$release_root/runtime" "$release_root/scripts"

# Explicit allowlist keeps local configuration, credentials, and state out of the archive.
cp "$project_root/README.md" "$project_root/VERSION" "$release_root/"
if [ -f "$project_root/LICENSE" ]; then cp "$project_root/LICENSE" "$release_root/"; fi
if [ -f "$project_root/THIRD_PARTY_NOTICES.md" ]; then cp "$project_root/THIRD_PARTY_NOTICES.md" "$release_root/"; fi
cp "$project_root/bin/big-brother" "$release_root/bin/"
cp "$project_root/config/big-brother.example.json" "$release_root/config/"
cp "$project_root/docs/user-guide.md" "$release_root/docs/"
cp "$project_root/packages/big-brother/package.json" "$project_root/packages/big-brother/README.md" "$release_root/packages/big-brother/"
cp -R "$project_root/packages/big-brother/src" "$project_root/packages/big-brother/resources" \
  "$project_root/packages/big-brother/completions" "$release_root/packages/big-brother/"
cp "$project_root/runtime/package.json" "$release_root/runtime/"
cp -R "$project_root/runtime/dist" "$release_root/runtime/"
cp "$project_root/scripts/install.sh" "$release_root/scripts/"

archive="$output_dir/big-brother-$version.tar.gz"
tar -C "$staging_dir" -czf "$archive" "big-brother-$version"
if command -v shasum >/dev/null 2>&1; then
  (cd "$output_dir" && shasum -a 256 "$(basename "$archive")") > "$archive.sha256"
else
  (cd "$output_dir" && sha256sum "$(basename "$archive")") > "$archive.sha256"
fi
printf '%s\n' "$archive"
