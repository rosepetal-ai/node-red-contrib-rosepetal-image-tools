#!/bin/bash

#=============================================================================
# Node-RED Rosepetal Image Tools - Simple Installation Script
#=============================================================================
# This script installs system dependencies and builds the package for Node-RED
# Usage: ./install.sh
#=============================================================================

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_MANAGER=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

#=============================================================================
# System Detection
#=============================================================================

detect_distro() {
    print_step "Detecting Linux distribution..."
    
    if command -v apt >/dev/null 2>&1; then
        PACKAGE_MANAGER="apt"
        echo "Detected: Ubuntu/Debian (using apt)"
    elif command -v dnf >/dev/null 2>&1; then
        PACKAGE_MANAGER="dnf"
        echo "Detected: Fedora/CentOS 8+ (using dnf)"
    elif command -v yum >/dev/null 2>&1; then
        PACKAGE_MANAGER="yum"
        echo "Detected: CentOS/RHEL (using yum)"
    elif command -v pacman >/dev/null 2>&1; then
        PACKAGE_MANAGER="pacman"
        echo "Detected: Arch Linux (using pacman)"
    else
        print_error "Unsupported Linux distribution. This script supports Ubuntu/Debian, CentOS/RHEL/Fedora, and Arch Linux."
        exit 1
    fi
}

#=============================================================================
# System Dependencies Installation
#=============================================================================

check_dependencies() {
    print_step "Checking system dependencies..."
    
    local missing_deps=()
    
    # Check essential tools
    command -v gcc >/dev/null 2>&1 || missing_deps+=("build tools")
    command -v cmake >/dev/null 2>&1 || missing_deps+=("cmake")
    command -v pkg-config >/dev/null 2>&1 || missing_deps+=("pkg-config")
    command -v python3 >/dev/null 2>&1 || missing_deps+=("python3")
    
    # Check OpenCV
    if ! pkg-config --libs opencv4 >/dev/null 2>&1 && ! pkg-config --libs opencv >/dev/null 2>&1; then
        missing_deps+=("opencv")
    fi
    
    if [ ${#missing_deps[@]} -eq 0 ]; then
        echo "All required dependencies are already installed ✓"
        return 0
    else
        echo "Missing dependencies: ${missing_deps[*]}"
        return 1
    fi
}

install_dependencies() {
    if check_dependencies; then
        return 0
    fi
    
    print_step "Installing missing system dependencies..."
    
    case "$PACKAGE_MANAGER" in
        apt)
            echo "Updating package list..."
            sudo apt update
            
            echo "Installing build tools and dependencies..."
            sudo apt install -y \
                build-essential \
                cmake \
                pkg-config \
                python3-dev \
                python-is-python3 \
                libopencv-dev \
                git
            ;;
        dnf)
            echo "Installing build tools and dependencies..."
            sudo dnf install -y \
                gcc-c++ \
                cmake \
                pkgconfig \
                python3-devel \
                opencv-devel \
                git
            ;;
        yum)
            echo "Installing build tools and dependencies..."
            sudo yum install -y \
                gcc-c++ \
                cmake \
                pkgconfig \
                python3-devel \
                opencv-devel \
                git
            ;;
        pacman)
            echo "Updating package database..."
            sudo pacman -Sy
            
            echo "Installing build tools and dependencies..."
            sudo pacman -S --noconfirm \
                base-devel \
                cmake \
                pkgconf \
                python \
                opencv \
                git
            ;;
    esac
    
    print_success "System dependencies installed"
}

#=============================================================================
# Main Installation
#=============================================================================

main() {
    echo "==============================================="
    echo "  Node-RED Rosepetal Image Tools Installer"
    echo "==============================================="
    echo ""
    
    # Check if running as root
    if [[ $EUID -eq 0 ]]; then
        print_error "Please do not run this script as root. We'll use sudo when needed."
        exit 1
    fi
    
    # Check if Node.js is installed
    if ! command -v node >/dev/null 2>&1; then
        print_error "Node.js is not installed. Please install Node.js first."
        echo "Ubuntu/Debian: sudo apt install nodejs npm"
        echo "CentOS/RHEL/Fedora: sudo dnf install nodejs npm"
        echo "Arch: sudo pacman -S nodejs npm"
        exit 1
    fi
    
    echo "Node.js version: $(node --version)"
    echo "npm version: $(npm --version)"
    echo ""
    
    # Install system dependencies
    detect_distro
    install_dependencies
    
    echo ""
    print_step "Step 1: Installing C++ engine and building native addon..."
    cd "$SCRIPT_DIR/rosepetal-image-engine"
    npm install
    print_success "C++ engine installed and built"
    
    echo ""
    print_step "Step 2: Installing Node-RED package dependencies..."
    cd "$SCRIPT_DIR/node-red-contrib-rosepetal-image-tools"
    npm install
    print_success "Node-RED package dependencies installed"
    
    echo ""
    echo "============================================="
    print_success "Installation completed successfully!"
    echo "============================================="
    echo ""
    echo "FINAL STEP - Install in your Node-RED:"
    echo ""
    echo "Go to your .node-red directory and run:"
    echo "cd ~/.node-red"
    echo "npm install $SCRIPT_DIR/node-red-contrib-rosepetal-image-tools"
    echo ""
    echo "After installation, restart Node-RED and look for"
    echo "'Rosepetal Image' nodes in the palette."
    echo ""
}

# Handle script interruption
trap 'print_error "Installation interrupted by user"; exit 1' INT TERM

# Run main function
main