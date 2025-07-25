#!/bin/bash

#=============================================================================
# Node-RED Rosepetal Image Tools - Universal Installation Script
#=============================================================================
# Installs system dependencies and builds the package for Node-RED.
# Supports Debian/Ubuntu, Fedora/CentOS/RHEL, Arch Linux, and macOS.
#
# Usage: ./install.sh
#=============================================================================

set -e  # Exit on any error

# --- Configuration & Helpers ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() { echo -e "\n${BLUE}▶ $1${NC}"; }
print_success() { echo -e "${GREEN}✔ $1${NC}"; }
print_error() { echo -e "${RED}✖ $1${NC}" >&2; }
print_info() { echo "  $1"; }

# --- System & Dependency Checks ---

check_command() {
    command -v "$1" >/dev/null 2>&1
}

detect_os_and_pm() {
    print_step "Detecting Operating System and Package Manager..."
    OS=$(uname -s)
    case "$OS" in
        Linux*)
            if check_command apt; then PM="apt"; OS_NAME="Debian/Ubuntu"
            elif check_command dnf; then PM="dnf"; OS_NAME="Fedora/CentOS"
            elif check_command yum; then PM="yum"; OS_NAME="CentOS/RHEL"
            elif check_command pacman; then PM="pacman"; OS_NAME="Arch Linux"
            else print_error "Unsupported Linux distribution." && exit 1; fi
            ;;
        Darwin*)
            if ! check_command brew; then
                print_error "Homebrew not found. Please install it from https://brew.sh"
                exit 1
            fi
            PM="brew"; OS_NAME="macOS"
            ;;
        *)
            print_error "Unsupported Operating System: $OS" && exit 1
            ;;
    esac
    print_success "Detected $OS_NAME (using $PM)"
}

install_dependencies() {
    print_step "Checking and installing system dependencies..."
    
    # List of required packages per package manager
    declare -A deps
    deps[apt]="build-essential cmake pkg-config python3-dev libopencv-dev"
    deps[dnf]="gcc-c++ cmake pkgconfig python3-devel opencv-devel"
    deps[yum]="gcc-c++ cmake pkgconfig python3-devel opencv-devel"
    deps[pacman]="base-devel cmake pkgconf python opencv"
    deps[brew]="cmake pkg-config opencv"

    if ! pkg-config --exists opencv4; then
        print_info "OpenCV 4 not found, attempting to install..."
        sudo -v # Refresh sudo timestamp
        case "$PM" in
            apt)    sudo apt-get update && sudo apt-get install -y ${deps[apt]} ;;
            dnf)    sudo dnf install -y ${deps[dnf]} ;;
            yum)    sudo yum install -y ${deps[yum]} ;;
            pacman) sudo pacman -S --noconfirm ${deps[pacman]} ;;
            brew)   brew install ${deps[brew]} ;;
        esac
        print_success "System dependencies installed."
    else
        print_success "All system dependencies are already satisfied."
    fi
}

# --- Main Logic ---

main() {
    echo "================================================="
    echo "  Node-RED Rosepetal Image Tools Installer"
    echo "================================================="

    if ! check_command node || ! check_command npm; then
        print_error "Node.js and npm are required. Please install them first."
        exit 1
    fi
    print_info "Node.js version: $(node --version)"
    print_info "npm version:     $(npm --version)"

    detect_os_and_pm
    install_dependencies

    print_step "Building the Node-RED package and C++ engine..."
    cd "$SCRIPT_DIR/node-red-contrib-rosepetal-image-tools"
    
    # A single npm install here will trigger the postinstall script,
    # which in turn installs and builds the C++ engine.
    if npm install; then
        print_success "Package and C++ engine built successfully!"
    else
        print_error "Build failed. Please check the logs above for errors."
        exit 1
    fi

    echo "================================================="
    print_success "Build complete!"
    echo "================================================="

    # --- Interactive Node-RED Installation ---
    NODE_RED_DIR="$HOME/.node-red"
    if [ -d "$NODE_RED_DIR" ]; then
        print_step "Optional: Install into your Node-RED instance"
        read -p "Do you want to install this package into '$NODE_RED_DIR'? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            print_info "Installing into Node-RED..."
            (cd "$NODE_RED_DIR" && npm install "$SCRIPT_DIR/node-red-contrib-rosepetal-image-tools")
            print_success "Successfully installed in Node-RED."
            print_info "Please restart your Node-RED instance to see the new nodes."
        else
            print_info "Skipping automatic installation."
            print_info "You can install it later by running this command:"
            print_info "  cd ~/.node-red && npm install $SCRIPT_DIR/node-red-contrib-rosepetal-image-tools"
        fi
    fi
}

# --- Script Execution ---
trap 'print_error "Installation interrupted."; exit 1' INT TERM
main