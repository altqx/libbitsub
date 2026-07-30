#!/usr/bin/env bun
/**
 * Headless Chromium/Chrome runner for backend pixel parity.
 *
 * Usage:
 *   bun tests/visual/run.mjs
 *
 * Browser resolution order:
 *   CHROME_PATH, then chromium, google-chrome, google-chrome-stable, chromium-browser
 *
 * In CI, install Chrome via browser-actions/setup-chrome and set CHROME_PATH.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const timeoutMs = Number(process.env.VISUAL_TIMEOUT_MS || 20000)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.json': 'application/json'
}

function contentType(filePath) {
  return MIME[extname(filePath)] || 'application/octet-stream'
}

async function pathExists(filePath) {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function which(command) {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], {
    encoding: 'utf8'
  })
  if (result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

async function resolveBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    which('google-chrome'),
    which('google-chrome-stable'),
    which('chromium'),
    which('chromium-browser'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  return null
}

async function startServer() {
  let resolveResults
  let settled = false
  const results = new Promise((resolvePromise) => {
    resolveResults = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
  })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      let pathname = decodeURIComponent(url.pathname)

      if (pathname === '/results' && req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          res.writeHead(400)
          res.end('bad json')
          return
        }
        res.writeHead(204)
        res.end()
        resolveResults({ source: 'post', payload: parsed })
        return
      }

      if (pathname === '/') pathname = '/tests/visual/index.html'
      const filePath = join(root, pathname.replace(/^\//, ''))
      if (!filePath.startsWith(root)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const body = await readFile(filePath)
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      })
      res.end(body)
    } catch (error) {
      res.writeHead(404)
      res.end(error instanceof Error ? error.message : 'not found')
    }
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind visual harness server')
  }
  return { server, port: address.port, results, resolveResults: (value) => resolveResults(value) }
}

function runBrowser(executable, url) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--autoplay-policy=no-user-gesture-required',
    // Keep the process alive until we kill it after receiving /results.
    url
  ]

  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Avoid interactive chrome prompts in CI.
      CHROME_LOG_FILE: process.env.CHROME_LOG_FILE || '/dev/null'
    }
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const exit = new Promise((resolveExit) => {
    child.once('error', (error) => {
      resolveExit({ code: null, error, stdout, stderr })
    })
    child.once('close', (code, signal) => {
      resolveExit({ code, signal, stdout, stderr })
    })
  })

  return {
    child,
    exit,
    getStderr: () => stderr,
    getStdout: () => stdout
  }
}

function evaluatePayload(payload) {
  if (!payload?.ok) {
    console.error('Visual regression failed')
    if (payload?.error) console.error(payload.error)
    return 1
  }

  for (const name of ['software', 'canvas2d']) {
    if (payload.results?.[name]?.status !== 'ok') {
      console.error(`Required backend failed: ${name}`)
      return 1
    }
  }

  console.log('Visual regression passed (software + Canvas2D required; GPU backends best-effort)')
  return 0
}

async function main() {
  const browser = await resolveBrowser()
  if (!browser) {
    const message =
      'No Chromium/Chrome binary found. Install Chrome or set CHROME_PATH. ' +
      'In GitHub Actions use browser-actions/setup-chrome and export CHROME_PATH.'
    if (process.env.VISUAL_OPTIONAL === '1') {
      console.warn(`skip visual: ${message}`)
      return
    }
    console.error(message)
    process.exitCode = 1
    return
  }

  console.log(`Using browser: ${browser}`)

  const { server, port, results, resolveResults } = await startServer()
  const url = `http://127.0.0.1:${port}/tests/visual/index.html?t=${Date.now()}`
  const chrome = runBrowser(browser, url)

  const timer = setTimeout(() => {
    resolveResults({
      source: 'timeout',
      payload: {
        ok: false,
        error: `visual harness timed out after ${timeoutMs}ms`,
        stderrTail: chrome.getStderr().trim().split('\n').slice(-20).join('\n')
      }
    })
    try {
      chrome.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, timeoutMs)

  try {
    // If the browser dies before posting, fail immediately instead of waiting.
    void chrome.exit.then((exitInfo) => {
      const detail = exitInfo.error
        ? exitInfo.error.message
        : `browser exited code=${exitInfo.code} signal=${exitInfo.signal ?? ''}`
      resolveResults({
        source: 'browser-exit',
        payload: {
          ok: false,
          error: `Browser ended before posting results (${detail})`,
          stderrTail: (exitInfo.stderr || chrome.getStderr()).trim().split('\n').slice(-30).join('\n')
        }
      })
    })

    const outcome = await results
    clearTimeout(timer)

    console.log(JSON.stringify(outcome.payload, null, 2))
    if (outcome.payload?.stderrTail) {
      console.error(outcome.payload.stderrTail)
    } else if (chrome.getStderr().trim()) {
      console.error(chrome.getStderr().trim().split('\n').slice(-12).join('\n'))
    }

    process.exitCode = evaluatePayload(outcome.payload)
  } finally {
    clearTimeout(timer)
    try {
      chrome.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
