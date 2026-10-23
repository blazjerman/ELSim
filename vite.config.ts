import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join('; '),
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

export default defineConfig(({ command, mode }) => {
  const base = process.env.VITE_BASE_PATH?.trim() || '/'
  if (!base.startsWith('/') || !base.endsWith('/') || base.startsWith('//') || base.includes('..') || /[?#]/.test(base)) {
    throw new Error('VITE_BASE_PATH must be a safe absolute URL path that starts and ends with /, such as / or /ELSim/.')
  }
  if (command === 'build' && mode === 'offline') {
    for (const fileName of ['ngspice.mjs', 'ngspice.wasm']) {
      if (!existsSync(path.join(root, 'public/engine', fileName))) {
        throw new Error(`Offline build requires public/engine/${fileName}. Build the local runtime first with tools/build-ngspice-wasm.sh.`)
      }
    }
  }
  if (command === 'build' && mode === 'release') {
    execFileSync(process.execPath, ['tools/check-ngspice-release.mjs'], { stdio: 'inherit' })
  }
  return {
    base,
    plugins: [react(), {
      name: 'emit-offline-app-shell',
      apply: 'build',
      generateBundle(_output, bundle) {
        const assets: { path: string; source: string | Uint8Array }[] = []
        for (const fileName of Object.keys(bundle).sort()) {
          if (fileName === 'index.html' || /^assets\/.*\.(?:js|css|svg|woff2?)$/i.test(fileName)) {
            const output = bundle[fileName]
            assets.push({ path: `./${fileName}`, source: output.type === 'chunk' ? output.code : output.source })
          }
        }
        for (const fileName of ['manifest.webmanifest', 'icon.svg']) {
          const source = readFileSync(path.join(root, 'src/pwa', fileName))
          this.emitFile({ type: 'asset', fileName, source })
          assets.push({ path: `./${fileName}`, source })
        }
        const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'))
        assets.push({ path: './THIRD_PARTY_NOTICES.md', source: notices })
        assets.push({ path: './LICENSE', source: readFileSync(path.join(root, 'LICENSE')) })
        assets.push({ path: './licenses/npm-dependencies.json', source: readFileSync(path.join(root, 'licenses/npm-dependencies.json')) })
        const engineDirectory = path.join(root, 'public/engine')
        const engineFiles = command === 'build' && (mode === 'release' || mode === 'offline') && existsSync(engineDirectory)
          ? readdirSync(engineDirectory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
          : []
        for (const fileName of engineFiles) assets.push({ path: `./engine/${fileName}`, source: readFileSync(path.join(engineDirectory, fileName)) })

        const hash = createHash('sha256')
        for (const asset of assets) hash.update(asset.path).update(asset.source)
        const cacheName = `elsim-shell-${hash.digest('hex').slice(0, 16)}`
        const precache = ['./', ...assets.map(({ path: assetPath }) => assetPath)]
        const worker = `const CACHE_PREFIX = 'elsim-shell-'\nconst CACHE_NAME = ${JSON.stringify(cacheName)}\nconst PRECACHE_URLS = ${JSON.stringify(precache)}\n\nself.addEventListener('message', (event) => {\n  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()\n})\n\nself.addEventListener('install', (event) => {\n  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)))\n})\n\nself.addEventListener('activate', (event) => {\n  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)))))\n})\n\nself.addEventListener('fetch', (event) => {\n  const request = event.request\n  if (request.method !== 'GET' && request.method !== 'HEAD') return\n  const url = new URL(request.url)\n  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return\n  if (request.method === 'HEAD') {\n    event.respondWith((async () => {\n      const cache = await caches.open(CACHE_NAME)\n      const cached = await cache.match(new Request(request.url, { method: 'GET' }))\n      if (cached) return new Response(null, { status: cached.status, statusText: cached.statusText, headers: cached.headers })\n      return fetch(request)\n    })())\n    return\n  }\n  if (request.mode === 'navigate') {\n    event.respondWith(fetch(request).then((response) => response).catch(async () => {\n      const cache = await caches.open(CACHE_NAME)\n      return (await cache.match(request)) || (await cache.match(new URL('./index.html', self.registration.scope).href)) || Response.error()\n    }))\n    return\n  }\n  event.respondWith((async () => {\n    const cache = await caches.open(CACHE_NAME)\n    const cached = await cache.match(request)\n    if (cached) return cached\n    const response = await fetch(request)\n    if (response.ok && response.type === 'basic' && !/no-store/i.test(response.headers.get('Cache-Control') || '')) await cache.put(request, response.clone())\n    return response\n  })())\n})\n`
        this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker })
        const hostedHeaders = ['/*', ...Object.entries(securityHeaders).map(([name, value]) => `  ${name}: ${value}`)].join('\n') + '\n'
        this.emitFile({ type: 'asset', fileName: '_headers', source: hostedHeaders })
      },
    }, {
      name: 'copy-third-party-notices',
      apply: 'build',
      closeBundle() {
        const output = path.join(root, 'dist')
        mkdirSync(output, { recursive: true })
        copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'))
        copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'))
        const licenses = path.join(output, 'licenses')
        mkdirSync(licenses, { recursive: true })
        copyFileSync(path.join(root, 'licenses/npm-dependencies.json'), path.join(licenses, 'npm-dependencies.json'))
      },
    }],
    worker: { format: 'es' },
    preview: { headers: securityHeaders },
    // Ordinary builds stay engine-free. Offline mode packages the developer's
    // ignored runtime for PWA testing; release mode includes it only
    // after the distribution review gate above.
    publicDir: command === 'build' && mode !== 'release' && mode !== 'offline' ? false : 'public',
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return
            if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(id)) return 'react-vendor'
            if (id.includes('/node_modules/lucide-react/')) return 'icons-vendor'
          },
        },
      },
    },
  }
})
