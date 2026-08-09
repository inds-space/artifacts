#!/usr/bin/env sh
set -eu

repo="inds-space/artifacts"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
  linux) platform="linux" ;;
  darwin) platform="darwin" ;;
  *) echo "Unsupported operating system: $os" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64|amd64) machine="x64" ;;
  arm64|aarch64) machine="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="artifacts-${platform}-${machine}"
install_dir="${ARTIFACTS_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
curl -fsSL "https://github.com/${repo}/releases/latest/download/${asset}" -o "$install_dir/artifacts"
chmod +x "$install_dir/artifacts"
echo "Installed artifacts to $install_dir/artifacts"
