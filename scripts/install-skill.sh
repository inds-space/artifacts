#!/usr/bin/env sh
set -eu
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../skills/artifacts" && pwd)"
if [ "$#" -eq 0 ]; then
  set -- "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.claude/skills" "$HOME/.gemini/antigravity/skills"
fi
for target do
  mkdir -p "$target/artifacts"
  cp -R "$source_dir/." "$target/artifacts/"
  echo "Installed artifacts skill at $target/artifacts"
done
