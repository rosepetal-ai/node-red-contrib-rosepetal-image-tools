/**
 * @file Platform-aware bridge that loads the correct native C++ addon.
 * Follows Sharp's pattern for platform-specific binary loading.
 *
 * Loading order:
 * 1. Try platform-specific package (@rosepetal/rosepetal-engine-{platform})
 * 2. Fallback to local build (development mode)
 * 3. Fallback to node-gyp rebuild if build tools available
 * 4. Error with helpful message
 */
const util = require('util');
const path = require('path');
const fs = require('fs');

/**
 * Detect the current platform identifier
 * @returns {string} Platform identifier (e.g., 'linux-x64', 'darwin-arm64', 'linuxmusl-x64')
 */
function detectPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  let platformId = `${platform}-${arch}`;

  // On Linux, distinguish between glibc and musl (Alpine)
  if (platform === 'linux') {
    const isMusl = detectMusl();
    platformId = isMusl ? `linuxmusl-${arch}` : `linux-${arch}`;
  }

  return platformId;
}

/**
 * Detect if running on musl libc (Alpine Linux, etc.)
 * @returns {boolean} True if musl libc detected
 */
function detectMusl() {
  try {
    // Method 1: Check for Alpine release file
    if (fs.existsSync('/etc/alpine-release')) {
      return true;
    }

    // Method 2: Check for musl loader
    if (fs.existsSync('/lib/ld-musl-x86_64.so.1') ||
        fs.existsSync('/lib/ld-musl-aarch64.so.1')) {
      return true;
    }

    // Method 3: Check ldd output
    const { execSync } = require('child_process');
    const lddOutput = execSync('ldd --version 2>&1 || true', {
      encoding: 'utf8',
      timeout: 5000
    });
    if (lddOutput.toLowerCase().includes('musl')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Try to load the addon from the platform-specific npm package
 * @param {string} platformId - Platform identifier
 * @returns {object|null} The loaded addon or null
 */
function tryLoadFromPackage(platformId) {
  const packageName = `@rosepetal/rosepetal-engine-${platformId}`;

  try {
    // Try to resolve and load the platform-specific package
    const addonPath = require.resolve(`${packageName}/lib/addon.node`);
    return require(addonPath);
  } catch (err) {
    // Package not installed or not found
    return null;
  }
}

/**
 * Try to load the addon from local build (development mode)
 * @returns {object|null} The loaded addon or null
 */
function tryLoadFromLocalBuild() {
  const localPaths = [
    // From node-red-contrib-rosepetal-image-tools/lib/ -> rosepetal-image-engine/build/
    path.join(__dirname, '../../rosepetal-image-engine/build/Release/addon.node'),
    // Alternative path structure
    path.join(__dirname, '../../../rosepetal-image-engine/build/Release/addon.node'),
    // Direct sibling
    path.resolve(__dirname, '../../rosepetal-image-engine/build/Release/addon.node'),
  ];

  for (const addonPath of localPaths) {
    try {
      if (fs.existsSync(addonPath)) {
        return require(addonPath);
      }
    } catch {
      // Continue to next path
    }
  }

  return null;
}

/**
 * Try to build the addon using node-gyp (fallback for systems with build tools)
 * @returns {object|null} The loaded addon or null
 */
function tryBuildFromSource() {
  try {
    const { execSync } = require('child_process');

    // Find the rosepetal-image-engine directory
    const enginePaths = [
      path.join(__dirname, '../../rosepetal-image-engine'),
      path.join(__dirname, '../../../rosepetal-image-engine'),
    ];

    let engineDir = null;
    for (const p of enginePaths) {
      if (fs.existsSync(path.join(p, 'binding.gyp'))) {
        engineDir = p;
        break;
      }
    }

    if (!engineDir) {
      return null;
    }

    // Check if OpenCV is available via pkg-config
    try {
      execSync('pkg-config --exists opencv4', { encoding: 'utf8', timeout: 5000 });
    } catch {
      // OpenCV not available, can't build from source
      return null;
    }

    // Try to build
    console.log('rosepetal-image-engine: Pre-built binary not found, attempting to build from source...');
    execSync('npm run rebuild', {
      cwd: engineDir,
      encoding: 'utf8',
      stdio: 'inherit',
      timeout: 300000 // 5 minutes
    });

    // Try to load the freshly built addon
    const addonPath = path.join(engineDir, 'build/Release/addon.node');
    if (fs.existsSync(addonPath)) {
      return require(addonPath);
    }

    return null;
  } catch (err) {
    console.warn('rosepetal-image-engine: Build from source failed:', err.message);
    return null;
  }
}

/**
 * Load the native addon with platform detection and fallback
 * @returns {object} The loaded addon
 * @throws {Error} If no addon could be loaded
 */
function loadAddon() {
  const platformId = detectPlatform();

  // 1. Try platform-specific package first (production)
  let addon = tryLoadFromPackage(platformId);
  if (addon) {
    return addon;
  }

  // 2. Try local build (development)
  addon = tryLoadFromLocalBuild();
  if (addon) {
    return addon;
  }

  // 3. Try building from source (fallback)
  addon = tryBuildFromSource();
  if (addon) {
    return addon;
  }

  // 4. Provide helpful error message
  const supportedPlatforms = [
    'linux-x64', 'linux-arm64',
    'linuxmusl-x64', 'linuxmusl-arm64',
    'darwin-x64', 'darwin-arm64',
    'win32-x64'
  ];

  throw new Error(
    `Could not load the rosepetal-image-engine native addon.\n\n` +
    `Detected platform: ${platformId}\n` +
    `Supported platforms: ${supportedPlatforms.join(', ')}\n\n` +
    `Possible solutions:\n` +
    `1. Reinstall the package: npm install @rosepetal/node-red-contrib-rosepetal-image-tools\n` +
    `2. If your platform is supported, ensure you're using a recent npm version (npm >= 9)\n` +
    `3. For unsupported platforms or development:\n` +
    `   - Install OpenCV 4.x and build tools\n` +
    `   - Run: cd rosepetal-image-engine && npm run rebuild\n`
  );
}

// Load and promisify the addon
const addon = loadAddon();
const promisifiedAddon = {};

for (const key in addon) {
  if (typeof addon[key] === 'function') {
    promisifiedAddon[key] = util.promisify(addon[key]);
  }
}

module.exports = promisifiedAddon;
