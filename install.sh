#!/usr/bin/env bash
# Vulcan {{VERSION}} — Linux + macOS installer
# Triggered by: etna install vulcan
#
# This script installs:
#   1. UV (if not present)
#   2. Vulcan Python backend (from source via UV into a venv)
#   3. Docker runtime (native on Linux, Colima on macOS)
#   4. Vulcan Electron app (platform-appropriate binary)
#   5. Autostart registration (systemd on Linux, launchd on macOS)
#   6. vulcan install (first-time setup: Docker image build, config)

set -e

VERSION="{{VERSION}}"
VULCAN_VERSIONS_BASE="https://raw.githubusercontent.com/dwhite-sys/vulcan-versions/main/versions/${VERSION}"

# ── ANSI ──────────────────────────────────────────────────────────────────────

reset="\033[0m"
light_green="\033[92m"
red="\033[31m"
orange="\033[38;5;208m"
grey="\033[90m"
PREFIX="${orange}[Vulcan]${reset} "

ok()   { printf "${light_green}✔${reset}  %s\n" "$1"; }
fail() { printf "${red}✘${reset}  %s\n" "$1"; exit 1; }
info() { printf "${grey}·${reset}  %s\n" "$1"; }
step() { printf "${PREFIX}%s\n" "$1"; }

# ── Detect platform ───────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" = "Linux" ]; then
    PLATFORM="linux"
    if [ -f /etc/arch-release ] || command -v pacman &>/dev/null; then
        DISTRO="arch"
    elif [ -f /etc/debian_version ] || command -v apt-get &>/dev/null; then
        DISTRO="debian"
    elif [ -f /etc/fedora-release ] || command -v dnf &>/dev/null; then
        DISTRO="fedora"
    elif [ -f /etc/redhat-release ] || command -v yum &>/dev/null; then
        DISTRO="rhel"
    else
        DISTRO="unknown"
    fi
elif [ "$OS" = "Darwin" ]; then
    PLATFORM="macos"
    DISTRO="macos"
else
    fail "Unsupported platform: $OS"
fi

step "Installing Vulcan ${VERSION} on ${OS} (${ARCH})"
echo ""

# ── Check Python 3.11+ ────────────────────────────────────────────────────────

if ! command -v python3 &>/dev/null; then
    fail "Python 3 not found. Please install Python 3.11 or later."
fi
PY_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
    if [ "$DISTRO" = "debian" ]; then
        info "Python 3.11+ required. Installing..."
        sudo apt-get install -y python3.11 python3.11-venv
    elif [ "$DISTRO" = "fedora" ]; then
        sudo dnf install -y python3.11
    elif [ "$DISTRO" = "arch" ]; then
        sudo pacman -S --noconfirm python
    else
        fail "Python 3.11+ required (found ${PY_VERSION}). Please upgrade Python and retry."
    fi
fi
ok "Python ${PY_VERSION}"

# ── Install UV ────────────────────────────────────────────────────────────────

if command -v uv &>/dev/null; then
    ok "UV found ($(uv --version))"
else
    info "Installing UV..."
    if command -v pipx &>/dev/null; then
        pipx install uv
    elif command -v pip3 &>/dev/null; then
        pip3 install uv --break-system-packages 2>/dev/null || pip3 install uv
    elif command -v pip &>/dev/null; then
        pip install uv --break-system-packages 2>/dev/null || pip install uv
    else
        fail "Could not install UV — no pip or pipx found. Install from https://github.com/astral-sh/uv"
    fi
    ok "UV installed"
fi

# ── Install Vulcan Python backend from source ──────────────────────────────────

VENV_DIR="${HOME}/.vulcan/.venv"
info "Creating Vulcan venv at ${VENV_DIR}..."
uv venv "${VENV_DIR}" --python python3
ok "Venv created"

info "Installing Vulcan backend from source..."
uv pip install \
    --python "${VENV_DIR}/bin/python" \
    "git+https://github.com/dwhite-sys/vulcan@v${VERSION}#subdirectory=vulcan"
ok "Vulcan backend installed"

VULCAN_BIN="${VENV_DIR}/bin/vulcan"

# ── Install Docker ────────────────────────────────────────────────────────────

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    ok "Docker already running"
else
    if [ "$PLATFORM" = "linux" ]; then
        info "Installing Docker Engine..."
        curl -fsSL https://get.docker.com | sh
        sudo usermod -aG docker "$USER"
        ok "Docker installed — you may need to log out and back in for group changes"

    elif [ "$PLATFORM" = "macos" ]; then
        if ! command -v brew &>/dev/null; then
            printf "\n${PREFIX}${orange}Homebrew is required to install Docker on macOS and wasn't found.${reset}\n"
            printf "  Install it now? [${light_green}y${reset}/${red}n${reset}]: "
            read -r answer
            if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
                info "Installing Homebrew..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
                if [ "$ARCH" = "arm64" ]; then
                    eval "$(/opt/homebrew/bin/brew shellenv)"
                fi
                ok "Homebrew installed"
            else
                fail "Homebrew is required to continue. Install from https://brew.sh and retry."
            fi
        else
            ok "Homebrew found"
        fi

        info "Installing Colima and Docker CLI..."
        brew install colima docker
        ok "Colima and Docker CLI installed"

        info "Starting Colima..."
        colima start
        ok "Colima running"

        COLIMA_PLIST="${HOME}/Library/LaunchAgents/com.dwhite.colima.plist"
        mkdir -p "${HOME}/Library/LaunchAgents"
        cat > "${COLIMA_PLIST}" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dwhite.colima</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v colima)</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${HOME}/.colima/launchd.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.colima/launchd.log</string>
</dict></plist>
PLIST
        launchctl load "${COLIMA_PLIST}" 2>/dev/null || true
        ok "Colima registered for autostart on login"
    fi
fi

# ── Install Electron app ──────────────────────────────────────────────────────

if [ "$PLATFORM" = "linux" ]; then
    if [ "$DISTRO" = "debian" ]; then
        DEB_FILE="/tmp/vulcan-${VERSION}.deb"
        info "Downloading Vulcan .deb..."
        curl -fsSL "${VULCAN_VERSIONS_BASE}/linux/Vulcan-${VERSION}.deb" -o "$DEB_FILE"
        sudo dpkg -i "$DEB_FILE"
        sudo apt-get install -f -y
        rm -f "$DEB_FILE"
        ok "Vulcan app installed (.deb)"

    elif [ "$DISTRO" = "fedora" ] || [ "$DISTRO" = "rhel" ]; then
        RPM_FILE="/tmp/vulcan-${VERSION}.rpm"
        info "Downloading Vulcan .rpm..."
        curl -fsSL "${VULCAN_VERSIONS_BASE}/linux/Vulcan-${VERSION}.rpm" -o "$RPM_FILE"
        sudo rpm -i "$RPM_FILE" 2>/dev/null || sudo dnf install -y "$RPM_FILE"
        rm -f "$RPM_FILE"
        ok "Vulcan app installed (.rpm)"

    elif [ "$DISTRO" = "arch" ]; then
        TAR_FILE="/tmp/vulcan-${VERSION}.tar.gz"
        info "Downloading Vulcan tarball..."
        curl -fsSL "${VULCAN_VERSIONS_BASE}/linux/Vulcan-${VERSION}.tar.gz" -o "$TAR_FILE"
        sudo mkdir -p /opt/vulcan
        sudo tar -xzf "$TAR_FILE" -C /opt/vulcan --strip-components=1
        sudo ln -sf /opt/vulcan/vulcan /usr/local/bin/vulcan-app
        rm -f "$TAR_FILE"
        ICON_PATH="/opt/vulcan/resources/app/build/icons/icon_256.png"
        sudo tee /usr/share/applications/vulcan.desktop > /dev/null << DESKTOP
[Desktop Entry]
Name=Vulcan
Comment=AI harness with Docker workspace, terminal, and Etna integration
Exec=/opt/vulcan/vulcan %U
Icon=${ICON_PATH}
Type=Application
Categories=Network;
StartupWMClass=Vulcan
DESKTOP
        sudo update-desktop-database /usr/share/applications 2>/dev/null || true
        ok "Vulcan app installed (tarball → /opt/vulcan)"

    else
        APPIMAGE_PATH="${HOME}/.local/bin/vulcan-app"
        mkdir -p "${HOME}/.local/bin"
        info "Downloading Vulcan AppImage (fallback)..."
        curl -fsSL "${VULCAN_VERSIONS_BASE}/linux/Vulcan-${VERSION}.AppImage" -o "$APPIMAGE_PATH"
        chmod +x "$APPIMAGE_PATH"
        ok "Vulcan app installed (AppImage → ${APPIMAGE_PATH})"
    fi

elif [ "$PLATFORM" = "macos" ]; then
    DMG_FILE="/tmp/vulcan-${VERSION}.dmg"
    info "Downloading Vulcan .dmg..."
    curl -fsSL "${VULCAN_VERSIONS_BASE}/macos/Vulcan-${VERSION}.dmg" -o "$DMG_FILE"
    info "Mounting and installing..."
    hdiutil attach "$DMG_FILE" -nobrowse -quiet
    cp -r /Volumes/Vulcan/Vulcan.app /Applications/
    hdiutil detach /Volumes/Vulcan -quiet
    rm -f "$DMG_FILE"
    ok "Vulcan.app installed to /Applications"
fi

# ── Register Vulcan backend autostart ─────────────────────────────────────────

if [ "$PLATFORM" = "linux" ]; then
    SERVICE_DIR="${HOME}/.config/systemd/user"
    mkdir -p "$SERVICE_DIR"
    cat > "${SERVICE_DIR}/vulcan.service" << SERVICE
[Unit]
Description=Vulcan AI Harness Backend
After=network.target

[Service]
ExecStart=${VULCAN_BIN} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
    systemctl --user daemon-reload
    systemctl --user enable vulcan
    ok "Vulcan backend registered with systemd (starts on login)"

elif [ "$PLATFORM" = "macos" ]; then
    PLIST="${HOME}/Library/LaunchAgents/com.dwhite.vulcan.plist"
    cat > "${PLIST}" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dwhite.vulcan</string>
  <key>ProgramArguments</key>
  <array><string>${VULCAN_BIN}</string><string>start</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
PLIST
    launchctl load "${PLIST}" 2>/dev/null || true
    ok "Vulcan backend registered with launchd (starts on login)"
fi

# ── First-time setup ──────────────────────────────────────────────────────────

printf "\n${PREFIX}Running first-time setup...\n"
"${VULCAN_BIN}" install
ok "Vulcan setup complete"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
printf "${PREFIX}${light_green}✔${reset}  Vulcan ${VERSION} installed\n"
echo ""
printf "  Start the backend:   ${grey}vulcan start${reset}\n"
printf "  Check status:        ${grey}vulcan status${reset}\n"
printf "  Open the app:        ${grey}Vulcan (in your app launcher)${reset}\n"
echo ""
