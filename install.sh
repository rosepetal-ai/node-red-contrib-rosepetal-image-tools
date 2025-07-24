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

refresh_sudo() {
    # Refresh sudo timestamp to prevent timeout during long operations
    if [[ $EUID -ne 0 ]]; then
        sudo -v 2>/dev/null || true
    fi
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
            refresh_sudo
            sudo apt update
            
            echo "Installing build tools and dependencies..."
            refresh_sudo
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
            refresh_sudo
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
            refresh_sudo
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
            refresh_sudo
            sudo pacman -Sy
            
            echo "Installing build tools and dependencies..."
            refresh_sudo
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
    
    # Check if running as root - allow it but warn
    if [[ $EUID -eq 0 ]]; then
        echo -e "${RED}[WARNING]${NC} Running as root. This is generally not recommended."
        echo "This script will install system packages and may modify system files."
        echo ""
    fi
    
    # Ensure we can use sudo for system operations
    print_step "Checking sudo access..."
    if ! sudo -n true 2>/dev/null; then
        echo "This script requires sudo access for installing system packages."
        echo "You may be prompted for your password."
        if ! sudo -v; then
            print_error "Cannot obtain sudo access. Please ensure you have sudo privileges."
            exit 1
        fi
    fi
    print_success "Sudo access confirmed"
    echo ""
    
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
    print_step "Step 1: Installing C++ engine dependencies..."
    cd "$SCRIPT_DIR/rosepetal-image-engine"
    refresh_sudo  # Refresh in case npm needs elevated privileges
    if ! npm install; then
        print_error "Failed to install C++ engine dependencies"
        echo "This might be due to missing build tools or permissions."
        echo "Try running with sudo if the error persists."
        exit 1
    fi
    print_success "C++ engine dependencies installed"
    
    echo ""
    print_step "Step 2: Building C++ native addon..."
    if ! npm run build; then
        print_error "Failed to build C++ native addon"
        echo "This might be due to missing build tools or OpenCV libraries."
        echo "Make sure all system dependencies are properly installed."
        exit 1
    fi
    print_success "C++ native addon built successfully"
    
    echo ""
    print_step "Step 3: Installing Node-RED package dependencies..."
    cd "$SCRIPT_DIR/node-red-contrib-rosepetal-image-tools"
    refresh_sudo  # Refresh in case npm needs elevated privileges
    if ! npm install; then
        print_error "Failed to install Node-RED package dependencies"
        echo "This might be due to missing dependencies or permissions."
        echo "Try running with sudo if the error persists."
        exit 1
    fi
    print_success "Node-RED package dependencies installed"
    
    echo ""
    print_step "Step 4: Building Node-RED package..."
    if ! npm run build; then
        print_error "Failed to build Node-RED package"
        echo "This might be due to C++ engine build issues."
        exit 1
    fi
    print_success "Node-RED package built successfully"
    
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
    echo "If you encounter permission errors during npm install,"
    echo "you may need to run the Node-RED installation command with sudo:"
    echo "sudo npm install $SCRIPT_DIR/node-red-contrib-rosepetal-image-tools"
    echo ""
    echo "After installation, restart Node-RED and look for"
    echo "'Rosepetal Image' nodes in the palette."
    echo ""
    echo "NOTE: If this script failed, you can try running it with sudo:"
    echo "sudo ./install.sh"
    echo ""
}

# Handle script interruption
trap 'print_error "Installation interrupted by user"; exit 1' INT TERM

# Run main function
main