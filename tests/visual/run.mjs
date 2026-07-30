#!/usr/bin/env bun
/**
 * Headless Chromium runner for backend pixel parity.
 *
 * Usage:
 *   bun tests/visual/run.mjs
 *
 * Requires Chromium/Chrome on PATH (or CHROME_PATH).
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const executable = process.env.CHROME_PATH || 'chromium'

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

async function startServer() {
  /** @type {{ resolve: (value: any) => void, promise: Promise<any> }} */
  const gate = {}
  gate.promise = new Promise((resolveResult) => {
    gate.resolve = resolveResult
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
        gate.resolve(parsed)
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
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return { server, port, results: gate.promise }
}

function runChrome(url) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    url
  ]
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return {
    child,
    stderr: () => stderr
  }
}

async function main() {
  const { server, port, results } = await startServer()
  const url = `http://127.0.0.1:${port}/tests/visual/index.html`
  const chrome = runChrome(url)

  const timeoutMs = Number(process.env.VISUAL_TIMEOUT_MS || 30000)
  const timeout = setTimeout(() => {
    try {
      chrome.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, timeoutMs)

  try {
    const payload = await Promise.race([
      results,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`visual harness timed out after ${timeoutMs}ms`)), timeoutMs)
      })
    ])

    console.log(JSON.stringify(payload, null, 2))

    if (chrome.stderr().trim()) {
      const tail = chrome.stderr().trim().split('\n').slice(-12).join('\n')
      console.error(tail)
    }

    if (!payload?.ok) {
      console.error('Visual regression failed')
      process.exitCode = 1
      return
    }

    const required = ['software', 'canvas2d']
    for (const name of required) {
      if (payload.results?.[name]?.status !== 'ok') {
        console.error(`Required backend failed: ${name}`)
        process.exitCode = 1
        return
      }
    }

    console.log('Visual regression passed (software + Canvas2D required; GPU backends best-effort)')
  } finally {
    clearTimeout(timeout)
    try {
      chrome.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    server.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
