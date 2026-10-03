/**
 * Host-half tests.
 *
 * The host half owns exactly one thing that can hurt a user if it is wrong: an
 * HTTP route that reads files off disk. These tests pin the two properties that
 * matter — the route refuses anything outside a strict allow-list, and the
 * index tap only ever adds one inert `<script>` — plus the promise that the
 * plugin asks the host for nothing beyond the webserver.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const host = await import('../lib/index.js')

/** Capture what the host half registers without starting a real server. */
function makeContext() {
  const captured = { routes: [], taps: [] }
  const ctx = {
    effect: (factory) => {
      factory()
      return () => {}
    },
    webServer: {
      register: (route) => {
        captured.routes.push(route)
        return () => {}
      },
      tapIndex: (tap) => {
        captured.taps.push(tap)
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

function makeResponse() {
  return {
    headersSent: false,
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body
      this.headersSent = true
    },
    destroy() {},
  }
}

test('the host half asks only for the webserver', () => {
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

test('apply registers one prefix route and one index tap', () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)
  assert.equal(captured.routes.length, 1)
  assert.equal(captured.routes[0].kind, 'prefix')
  assert.equal(captured.routes[0].path, '/dsh-pet')
  assert.equal(captured.taps.length, 1)
})

test('enabled:false registers nothing at all', () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, { enabled: false })
  assert.equal(captured.routes.length, 0)
  assert.equal(captured.taps.length, 0)
})

test('the index tap injects the asset base and nothing else', () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)
  const html = captured.taps[0]('<html><head><title>x</title></head><body></body></html>')
  assert.equal((html.match(/<script/g) ?? []).length, 1)
  assert.match(html, /window\.__DSH_PET__=/)
  assert.match(html, /"base":"\/dsh-pet"/)
  // The payload must not contain a raw `<`, or a crafted value could close the
  // tag early. The generated script body is `<`-free by construction.
  const body = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(body !== null, 'the injected script must be well formed')
  assert.equal(body[1].includes('<'), false)
})

test('the route refuses traversal, unknown names and nested paths', async () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)
  const handler = captured.routes[0].handler

  const hostile = [
    '/dsh-pet/../../../package.json',
    '/dsh-pet/..%2f..%2fpackage.json',
    '/dsh-pet/%2e%2e%2fpackage.json',
    '/dsh-pet/sub/dir/clip.webm',
    '/dsh-pet/clip.txt',
    '/dsh-pet/',
    '/dsh-pet/no-such-clip.webm',
  ]
  for (const url of hostile) {
    const res = makeResponse()
    await handler({ method: 'GET', url, headers: {} }, res)
    assert.ok(res.status === 404 || res.status === 400, `${url} answered ${res.status}`)
  }
})

test('a traversal attempt cannot reach a file above assets/', async () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)
  // The file above assets/ that a naive join would reach is package.json.
  const res = makeResponse()
  await captured.routes[0].handler(
    { method: 'GET', url: '/dsh-pet/%2e%2e%2fpackage.json', headers: {} },
    res,
  )
  assert.equal(res.status, 404)
  assert.match(String(res.body), /missing-asset/)
})

test('the route resolves assets from the package root, not from lib/', async () => {
  // Regression guard: `index.js` sits in `lib/`, so a `new URL('.')` package
  // root silently resolves to `<pkg>/lib/` and every asset lookup 404s while
  // the route itself still looks healthy. Only a real read catches that.
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)

  const res = makeResponse()
  await captured.routes[0].handler({ method: 'GET', url: '/dsh-pet/clips.json', headers: {} }, res)
  assert.equal(res.status, 200, 'clips.json must be served from <package>/assets')
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.match(res.headers.ETag, /^W\//)

  const head = makeResponse()
  await captured.routes[0].handler({ method: 'HEAD', url: '/dsh-pet/clips.json', headers: {} }, head)
  assert.equal(head.status, 200)
  assert.equal(Number(head.headers['Content-Length']) > 0, true)
})

test('range requests are answered with 206 and a matching slice', async () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)
  const full = makeResponse()
  await captured.routes[0].handler({ method: 'GET', url: '/dsh-pet/clips.json', headers: {} }, full)
  const size = Number(full.headers['Content-Length'])
  assert.ok(size > 20)

  const res = makeResponse()
  await captured.routes[0].handler(
    { method: 'GET', url: '/dsh-pet/clips.json', headers: { range: 'bytes=0-9' } },
    res,
  )
  assert.equal(res.status, 206)
  assert.equal(res.headers['Content-Range'], `bytes 0-9/${size}`)
  assert.equal(res.headers['Content-Length'], '10')

  const bad = makeResponse()
  await captured.routes[0].handler(
    { method: 'GET', url: '/dsh-pet/clips.json', headers: { range: 'bytes=99999999-' } },
    bad,
  )
  assert.equal(bad.status, 416)
  assert.equal(bad.headers['Content-Range'], `bytes */${size}`)
})

test('the route rejects methods other than GET and HEAD', async () => {
  const { ctx, captured } = makeContext()
  host.apply(ctx, undefined)
  const res = makeResponse()
  captured.routes[0].handler({ method: 'POST', url: '/dsh-pet/clips.json', headers: {} }, res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.Allow, 'GET, HEAD')
})
