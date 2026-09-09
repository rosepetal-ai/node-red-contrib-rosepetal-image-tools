/**
 * @file Platform-aware bridge that loads the correct native C++ addon.
 * Follows Sharp's pattern for platform-specific binary loading.
 *
 * Loading order:
 * 1. Local build (development / install.sh)
 * 2. Platform-specific package (@rosepetal/node-red-contrib-image-tools-{platform})
 * 3. node-gyp rebuild if build tools + OpenCV are available
 * 4. Error with helpful message
 *
 * Everything here is asynchronous: the probing uses fs.promises, child
 * processes are spawned with the async child_process API, and the addon is
 * resolved lazily through a single cached promise. The only synchronous step
 * left is `require()` of the `.node` file itself (dlopen has no async form in
 * Node.js); it takes a few milliseconds and happens once per process.
 *
 * The exported object has the same shape as before: one async function per
 * native operation (`resize`, `rotate`, … `decode`, `encode`). Callers keep
 * doing `await Cpp.resize(...)`.
 */
const util = require('util');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const fsp = fs.promises;
const execFileAsync = util.promisify(execFile);

/** Public API of the native addon (mirrors rosepetal-image-engine/src/main.cpp). */
const FUNCTION_NAMES = [
  'resize', 'rotate', 'crop', 'concat', 'padding', 'filter',
  'mosaic', 'advancedMosaic', 'blend', 'addMask', 'addMasks', 'addBBs',
  'imageAlign', 'draw', 'colorConvert', 'heatDiff',
  'decode', 'encode'
];

const SUPPORTED_PLATFORMS = [
  'linux-x64', 'linux-arm64',
  'linuxmusl-x64',
  'darwin-x64', 'darwin-arm64'
];

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if running on musl libc (Alpine Linux, etc.)
 * @returns {Promise<boolean>} True if musl libc detected
 */
async function detectMusl() {
  try {
    // Method 1: Alpine release file
    if (await pathExists('/etc/alpine-release')) return true;

    // Method 2: musl loader
    if (await pathExists('/lib/ld-musl-x86_64.so.1') ||
        await pathExists('/lib/ld-musl-aarch64.so.1')) {
      return true;
    }

    // Method 3: ldd output (async subprocess, never blocks the event loop)
    try {
      const { stdout, stderr } = await execFileAsync('ldd', ['--version'], {
        encoding: 'utf8',
        timeout: 5000
      });
      return `${stdout}\n${stderr}`.toLowerCase().includes('musl');
    } catch (err) {
      // ldd exits non-zero on some libcs; its output is still useful
      const out = `${err && err.stdout ? err.stdout : ''}\n${err && err.stderr ? err.stderr : ''}`;
      return out.toLowerCase().includes('musl');
    }
  } catch {
    return false;
  }
}

/**
 * Detect the current platform identifier
 * @returns {Promise<string>} Platform identifier (e.g., 'linux-x64', 'darwin-arm64', 'linuxmusl-x64')
 */
async function detectPlatform() {
  const platform = process.platform;
  const arch = process.arch;

  // On Linux, distinguish between glibc and musl (Alpine)
  if (platform === 'linux') {
    const isMusl = await detectMusl();
    return isMusl ? `linuxmusl-${arch}` : `linux-${arch}`;
  }

  return `${platform}-${arch}`;
}

/**
 * Try to load the addon from the platform-specific npm package.
 * The node_modules lookup dirs come from `require.resolve.paths()` (pure
 * computation, no I/O); existence is probed with fs.promises.
 * @param {string} platformId - Platform identifier
 * @returns {Promise<object|null>} The loaded addon or null
 */
async function tryLoadFromPackage(platformId) {
  const packageName = `@rosepetal/node-red-contrib-image-tools-${platformId}`;
  const searchDirs = require.resolve.paths(packageName) || [];

  for (const dir of searchDirs) {
    const addonPath = path.join(dir, packageName, 'lib', 'addon.node');
    if (await pathExists(addonPath)) {
      try {
        return require(addonPath);
      } catch {
        // Broken package (wrong ABI, partial install, ...) — keep looking
      }
    }
  }
  return null;
}

/**
 * Try to load the addon from local build (development mode)
 * @returns {Promise<object|null>} The loaded addon or null
 */
async function tryLoadFromLocalBuild() {
  const localPaths = [
    // From node-red-contrib-image-tools/lib/ -> rosepetal-image-engine/build/
    path.join(__dirname, '../../rosepetal-image-engine/build/Release/addon.node'),
    // Alternative path structure
    path.join(__dirname, '../../../rosepetal-image-engine/build/Release/addon.node'),
  ];

  for (const addonPath of localPaths) {
    if (await pathExists(addonPath)) {
      try {
        return require(addonPath);
      } catch {
        // Continue to next path
      }
    }
  }

  return null;
}

/**
 * Spawn a command asynchronously with inherited stdio and a timeout.
 * @returns {Promise<void>} resolves on exit code 0, rejects otherwise
 */
function spawnAsync(cmd, args, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`"${cmd} ${args.join(' ')}" timed out after ${timeout} ms`));
    }, timeout);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`"${cmd} ${args.join(' ')}" exited with ${signal || code}`));
    });
  });
}

/**
 * Try to build the addon using node-gyp (fallback for systems with build tools)
 * @returns {Promise<object|null>} The loaded addon or null
 */
async function tryBuildFromSource() {
  try {
    // Find the rosepetal-image-engine directory
    const enginePaths = [
      path.join(__dirname, '../../rosepetal-image-engine'),
      path.join(__dirname, '../../../rosepetal-image-engine'),
    ];

    let engineDir = null;
    for (const p of enginePaths) {
      if (await pathExists(path.join(p, 'binding.gyp'))) {
        engineDir = p;
        break;
      }
    }

    if (!engineDir) {
      return null;
    }

    // Check if OpenCV is available via pkg-config
    try {
      await execFileAsync('pkg-config', ['--exists', 'opencv4'], { timeout: 5000 });
    } catch {
      // OpenCV not available, can't build from source
      return null;
    }

    // Try to build (async subprocess; Node-RED keeps serving meanwhile)
    console.log('rosepetal-image-engine: Pre-built binary not found, attempting to build from source...');
    await spawnAsync('npm', ['run', 'rebuild'], {
      cwd: engineDir,
      timeout: 300000 // 5 minutes
    });

    // Try to load the freshly built addon
    const addonPath = path.join(engineDir, 'build/Release/addon.node');
    if (await pathExists(addonPath)) {
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
 * @returns {Promise<object>} The loaded (promisified) addon
 * @throws {Error} If no addon could be loaded
 */
async function loadAddon() {
  // 1. Try local build first (development / install.sh)
  let addon = await tryLoadFromLocalBuild();

  // 2. Try platform-specific package (npm install without build tools)
  if (!addon) {
    const platformId = await detectPlatform();
    addon = await tryLoadFromPackage(platformId);

    // 3. Try building from source (fallback)
    if (!addon) {
      addon = await tryBuildFromSource();
    }

    // 4. Provide helpful error message
    if (!addon) {
      throw new Error(
        `Could not load the rosepetal-image-engine native addon.\n\n` +
        `Detected platform: ${platformId}\n` +
        `Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}\n\n` +
        `Possible solutions:\n` +
        `1. Reinstall the package: npm install @rosepetal/node-red-contrib-image-tools\n` +
        `2. If your platform is supported, ensure you're using a recent npm version (npm >= 9)\n` +
        `3. For unsupported platforms or development:\n` +
        `   - Install OpenCV 4.x and build tools\n` +
        `   - Run: cd rosepetal-image-engine && npm run rebuild\n`
      );
    }
  }

  // Promisify every native (callback-style) function
  const promisified = {};
  for (const key of Object.keys(addon)) {
    if (typeof addon[key] === 'function') {
      promisified[key] = util.promisify(addon[key]);
    }
  }

  const missing = FUNCTION_NAMES.filter((name) => typeof promisified[name] !== 'function');
  if (missing.length > 0) {
    console.warn(
      `rosepetal-image-engine: the loaded native addon does not export ${missing.join(', ')}. ` +
      `It was built from an older source tree; rebuild it (cd rosepetal-image-engine && npm run rebuild) ` +
      `or update the platform package.`
    );
  }

  return promisified;
}

// Single cached load. Kicked off eagerly (without blocking) so missing-addon
// diagnostics show up at startup; every call awaits the same promise.
let addonPromise = null;

function getAddon() {
  if (!addonPromise) {
    addonPromise = loadAddon();
    // Avoid an unhandled-rejection warning: callers get the error when they await.
    addonPromise.catch((err) => {
      console.error(`rosepetal-image-engine: ${err.message}`);
    });
  }
  return addonPromise;
}

getAddon();

const bridge = {};
for (const name of FUNCTION_NAMES) {
  bridge[name] = async function (...args) {
    const addon = await getAddon();
    const fn = addon[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `rosepetal-image-engine: native function "${name}" is not available in the loaded addon. ` +
        `Rebuild the native module (cd rosepetal-image-engine && npm run rebuild) or update the platform package.`
      );
    }
    return fn(...args);
  };
}

/** Resolves once the native addon is loaded (or rejects with the load error). */
bridge.ready = () => getAddon().then(() => undefined);

module.exports = bridge;
