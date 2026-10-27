/**
 * Headless Chromium launcher used by the verification / preview scripts.
 *
 * Resolution order:
 *   1. CHROMIUM_EXECUTABLE   (path to an existing chromium/chrome binary)
 *   2. @sparticuz/chromium   (npm package that ships a chromium build)
 *   3. playwright's bundled chromium (if installed)
 *
 * WebGL is forced through SwiftShader so the game renders identically on a
 * machine without a GPU (CI / sandbox).
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import path from 'node:path';

const CACHE = path.join(process.env.TMPDIR || '/tmp', 'iiyama3d-chromium');

function extractPackageChromium() {
  const pkgDir = path.join(process.cwd(), 'node_modules', '@sparticuz', 'chromium');
  const bin = path.join(pkgDir, 'bin');
  if (!existsSync(path.join(bin, 'chromium.br'))) return null;
  mkdirSync(CACHE, { recursive: true });

  const exe = path.join(CACHE, 'chromium');
  if (!existsSync(exe)) {
    writeFileSync(exe, zlib.brotliDecompressSync(readFileSync(path.join(bin, 'chromium.br'))));
    chmodSync(exe, 0o755);
  }

  // SwiftShader (software WebGL) must sit next to the binary.
  const swDir = path.join(CACHE, 'swiftshader');
  if (!existsSync(path.join(CACHE, 'libvk_swiftshader.so'))) {
    mkdirSync(swDir, { recursive: true });
    const tar = path.join(CACHE, 'swiftshader.tar');
    writeFileSync(tar, zlib.brotliDecompressSync(readFileSync(path.join(bin, 'swiftshader.tar.br'))));
    try {
      execFileSync('tar', ['-xf', tar, '-C', CACHE]);
    } catch { /* ignore - hardware GL will be attempted */ }
  }

  // Chromium build dependencies (libnspr4, libnss3, ...) for minimal images.
  const libDir = path.join(CACHE, 'al2023');
  if (!existsSync(path.join(libDir, 'lib', 'libnspr4.so'))) {
    const alTar = path.join(CACHE, 'al2023.tar');
    try {
      writeFileSync(alTar, zlib.brotliDecompressSync(readFileSync(path.join(bin, 'al2023.tar.br'))));
      mkdirSync(libDir, { recursive: true });
      execFileSync('tar', ['-xf', alTar, '-C', libDir]);
    } catch { /* not fatal on hosts with system libs */ }
  }

  return { executablePath: exe, libDir };
}

export async function launchBrowser({ playwrightModule = 'playwright-core' } = {}) {
  const { chromium } = await import(playwrightModule);

  let executablePath = process.env.CHROMIUM_EXECUTABLE || null;
  let libDir = process.env.CHROMIUM_LIBS || null;

  if (!executablePath) {
    try {
      const pkg = extractPackageChromium();
      if (pkg) {
        executablePath = pkg.executablePath;
        libDir = pkg.libDir;
      }
    } catch (err) {
      console.warn('[browser] @sparticuz/chromium unavailable:', err.message);
    }
  }

  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--headless=new',
    '--disable-gpu-sandbox',
    '--font-render-hinting=none',
  ];

  const env = { ...process.env };
  if (libDir) {
    const libPath = [path.join(libDir, 'lib'), path.join(libDir, 'lib64'), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    env.LD_LIBRARY_PATH = libPath;
  }

  const browser = await chromium.launch(executablePath ? { executablePath, args, env } : { args });
  return {
    browser,
    async close() {
      await browser.close();
    },
  };
}

export async function waitForApp(page, timeout = 60000) {
  await page.waitForFunction(() => window.__IIYAMA__?.ready === true, { timeout });
}
