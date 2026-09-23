#!/bin/bash
# Setup script for AirPlay 2 Sender on Raspberry Pi / Debian-based systems
set -e

echo "=== AirPlay 2 Sender - Dependency Setup ==="
echo ""

# Detect architecture
ARCH=$(uname -m)
echo "Detected architecture: $ARCH"

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

echo ""
echo "=== Installing system packages ==="
$SUDO apt-get update
$SUDO apt-get install -y \
    build-essential \
    pkg-config \
    git \
    curl \
    libssl-dev \
    libfdk-aac-dev \
    libasound2-dev \
    libavahi-compat-libdnssd-dev \
    libdbus-1-dev \
    cmake

echo ""
echo "=== Installing Rust ==="
if command -v rustc &> /dev/null; then
    echo "Rust is already installed: $(rustc --version)"
    echo "Updating Rust..."
    rustup update stable
else
    echo "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# Ensure cargo is in PATH for this script
export PATH="$HOME/.cargo/bin:$PATH"

echo ""
echo "=== Rust version ==="
rustc --version
cargo --version

# Pi Zero specific notes
if [ "$ARCH" = "armv6l" ]; then
    echo ""
    echo "=== Raspberry Pi Zero Detected ==="
    echo "NOTE: Pi Zero has limited CPU/RAM. Building may be slow."
    echo "Consider using cross-compilation from a faster machine:"
    echo ""
    echo "  # On your dev machine:"
    echo "  rustup target add arm-unknown-linux-gnueabihf"
    echo "  cargo build --target arm-unknown-linux-gnueabihf --release"
    echo ""
    echo "You may also want to increase swap space:"
    echo "  sudo dphys-swapfile swapoff"
    echo "  sudo nano /etc/dphys-swapfile  # Set CONF_SWAPSIZE=1024"
    echo "  sudo dphys-swapfile setup"
    echo "  sudo dphys-swapfile swapon"
    echo ""
fi

echo ""
echo "=== Verifying dependencies ==="

check_pkg() {
    if pkg-config --exists "$1" 2>/dev/null; then
        echo "  [OK] $1"
        return 0
    else
        echo "  [MISSING] $1"
        return 1
    fi
}

MISSING=0
check_pkg "libfdk-aac" || MISSING=1
check_pkg "alsa" || MISSING=1
check_pkg "avahi-compat-libdns_sd" || MISSING=1
check_pkg "dbus-1" || MISSING=1
check_pkg "openssl" || MISSING=1

if [ $MISSING -eq 1 ]; then
    echo ""
    echo "WARNING: Some packages may not be properly installed."
    echo "The build might still work - try 'cargo build' to check."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Source your shell config: source ~/.bashrc  (or restart terminal)"
echo "  2. Build the project: cargo build --release"
echo "  3. Run tests: cargo test --workspace"
echo ""
