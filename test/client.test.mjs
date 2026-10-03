/**
 * Pure-logic and contract tests for the client half.
 *
 * These run through the *same* loader stub the shell uses, so they exercise the
 * real `lib/client.js` byte-for-byte — including the "must not contain
 * import/export" and "must register under the package name" contracts — instead
 * of a re-implementation that could drift.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/**
 * Decode a non-interlaced 8-bit RGBA PNG and return the alpha channel's
 * [min, max]. Written by hand so the check needs no image dependency and can
 * inspect the actual pixels rather than the header's claim.
 */
function pngAlphaExtrema(bytes) {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'not a PNG',
  )
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', 'must start with IHDR')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert.equal(bytes[24], 8, 'expected bit depth 8')
  assert.equal(bytes[26], 0, 'expected deflate compression')
  assert.equal(bytes[28], 0, 'expected no interlacing')

  const chunks = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
    if (type === 'IEND') break
  }
  const raw = inflateSync(Buffer.concat(chunks))

  const bpp = 4
  const stride = width * bpp
  let lowest = 255
  let highest = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? line[i - bpp] : 0
      const up = previous[i]
      const upLeft = i >= bpp ? previous[i - bpp] : 0
      let value = line[i]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      line[i] = value & 0xff
    }
    for (let x = 3; x < stride; x += bpp) {
      if (line[x] < lowest) lowest = line[x]
      if (line[x] > highest) highest = line[x]
    }
    previous = line
  }
  return [lowest, highest]
}
/** Minimal React surface: enough for the module to load, never used to render. */
const reactStub = {
  createElement: () => null,
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value ?? null }),
  useMemo: (factory) => factory(),
  useCallback: (factory) => factory,
}

function loadClient() {
  let registration = null
  const windowStub = {
    __ModuleLoader__: {
      load: (value) => {
        registration = value
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  }
  // The bundle is a script, not a module: evaluate it with a window to hang on.
  const evaluate = new Function('window', source) // eslint-disable-line no-new-func
  evaluate(windowStub)
  assert.ok(registration !== null, 'the bundle must register itself through __ModuleLoader__')
  const module = registration.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require: ${name}`)
  })
  return { registration, module }
}

const { registration, module: bundle } = loadClient()
const helpers = bundle.__test

/** Load the bundle with a storage state of our choosing, without calling the factory. */
function loadWithStorage(storage) {
  let registered = null
  const windowStub = {
    __ModuleLoader__: {
      load: (value) => {
        registered = value
      },
    },
    localStorage: {
      getItem: () => storage,
      setItem: () => {},
    },
    // Read during render (edge peek / settings panel placement).
    innerWidth: 1280,
    innerHeight: 800,
  }
  new Function('window', source)(windowStub) // eslint-disable-line no-new-func
  return registered
}

/** A React stand-in that records the element tree instead of rendering it. */
function recordingReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (init) => ({ current: init ?? null }),
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
  }
}

function renderRegistered(storage) {
  const registered = loadWithStorage(storage)
  const module = registered.factory(() => recordingReact())
  const components = []
  module.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        components.push(component)
        return () => {}
      },
    },
  })
  return components[0]()
}

/**
 * The component's `useState` order. Seeding by position is the only way this
 * stub can reach the render branches that exist *after* clips.json has loaded
 * (effects never run here), and recording the initial values in the same order
 * makes a future `useState` addition fail loudly instead of silently shifting
 * every seeded value by one.
 */
const STATE_ORDER = [
  'description',
  'failure',
  'attempt',
  'settings',
  'showSettings',
  'bubble',
  'clip',
  'playing',
  'pos',
  'motion',
  'spin',
  'probeDismissed',
]

/** Seed key for a named state slot. */
function at(name) {
  const index = STATE_ORDER.indexOf(name)
  assert.notEqual(index, -1, `${name} is not in STATE_ORDER`)
  return index
}

/**
 * Render the real component once with the state a loaded page would have.
 * `seed` is keyed by the index in STATE_ORDER.
 */
function renderPet(seed = {}) {
  const registered = loadWithStorage(null)
  const inits = []
  const setters = []
  let index = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => {
      const value = typeof init === 'function' ? init() : init
      inits.push(value)
      const slotIndex = index
      const slot = Object.prototype.hasOwnProperty.call(seed, slotIndex) ? seed[slotIndex] : value
      index += 1
      return [slot, (next) => setters.push({ index: slotIndex, value: next })]
    },
    useEffect: () => {},
    useRef: (init) => ({ current: init ?? null }),
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
  }
  const module = registered.factory(() => react)
  const components = []
  module.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        components.push(component)
        return () => {}
      },
    },
  })
  return { tree: components[0](), inits, setters, stateCount: index }
}

/** Depth-first search of the recorded tree (children may be nested arrays). */
function findByType(node, type) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByType(item, type)
      if (found !== null) return found
    }
    return null
  }
  if (node === null || typeof node !== 'object') return null
  if (node.type === type) return node
  return findByType(node.children ?? [], type)
}

/** The description a healthy clips.json load would produce. */
function sampleDescription({ withPoster = true } = {}) {
  const payload = {
    clips: [
      { id: 'idle_breath', file: 'idle_breath.webm', category: 'idle' },
      { id: 'click_happy', file: 'click_happy.webm', category: 'click' },
    ],
    canvas: [640, 360],
    body_box: [212, 60, 428, 330],
  }
  if (withPoster) payload.idle_poster = 'data:image/png;base64,AAA'
  return helpers.parseClips(payload)
}

test('hiding the pet still leaves a way back to it', () => {
  // The hidden preference is persisted, so removing the whole tree would strand
  // the user: the settings panel they would use to come back lives inside it.
  const tree = renderRegistered(JSON.stringify({ enabled: false }))
  assert.notEqual(tree, null, 'a hidden pet must not render nothing')
  assert.equal(tree.props['data-dsh-pet-restore'], '1')
  assert.equal(typeof tree.props.onClick, 'function')
})

test('a visible pet never renders the restore affordance', () => {
  // Nothing is loaded yet, so the first render is empty — and crucially not a
  // restore chip, which must appear only for a deliberately hidden pet.
  assert.equal(renderRegistered(null), null)
})

test('the bundle registers under the package name the loader expects', () => {
  assert.equal(registration.id, '@local/dsh-pet')
})

test('the bundle contains no import/export statements', () => {
  // The host concatenates client.js verbatim into a classic script.
  assert.equal(/\b(?:import|export)\s/.test(source), false)
})

test('the plugin requires only the slot registry and exposes apply', () => {
  assert.deepEqual(bundle.inject, ['slots'])
  assert.equal(typeof bundle.apply, 'function')
})

test('apply registers one entry into the shell overlay and never throws', () => {
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, callback) => {
        assert.equal(name, 'shell.overlay')
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  bundle.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'shell.overlay')
  assert.equal(registrations[0].options.id, 'dsh-pet')
  assert.equal(typeof registrations[0].component, 'function')
})

test('apply swallows a failing slot registry instead of breaking the page', () => {
  const ctx = {
    slots: {
      inject: () => {
        throw new Error('slot registry exploded')
      },
    },
  }
  assert.doesNotThrow(() => bundle.apply(ctx))
})

test('the overlay registration is owned by ctx.effect so a reload cannot leave a second pet', () => {
  // Two mounted pets have independent random chains, so one idles while the
  // other animates — the same double image, from a second cause.
  const registered = loadWithStorage(null)
  const module = registered.factory(() => recordingReact())
  const effects = []
  const disposers = []
  assert.doesNotThrow(() =>
    module.apply({
      effect: (register, label) => {
        effects.push(label)
        disposers.push(register())
      },
      slots: {
        inject: (name, callback) => callback(),
        register: () => () => {},
      },
    }),
  )
  assert.deepEqual(effects, ['dsh-pet: overlay'])
  assert.equal(typeof disposers[0], 'function', 'ctx.effect must own a disposer')
})

test('a host without ctx.effect still registers the overlay directly', () => {
  const registered = loadWithStorage(null)
  const module = registered.factory(() => recordingReact())
  let registrations = 0
  module.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: () => {
        registrations += 1
        return () => {}
      },
    },
  })
  assert.equal(registrations, 1)
})

test('pickCategory follows the documented cumulative chain', () => {
  const chain = { idle: 0.3, turn: 0.4, act: 0.8, move: 1 }
  assert.equal(helpers.pickCategory(0.0, chain), 'idle')
  assert.equal(helpers.pickCategory(0.29, chain), 'idle')
  assert.equal(helpers.pickCategory(0.3, chain), 'turn')
  assert.equal(helpers.pickCategory(0.39, chain), 'turn')
  assert.equal(helpers.pickCategory(0.4, chain), 'act')
  assert.equal(helpers.pickCategory(0.79, chain), 'act')
  assert.equal(helpers.pickCategory(0.8, chain), 'move')
  assert.equal(helpers.pickCategory(0.999999, chain), 'move')
  // Out-of-range rolls must still land somewhere sane rather than undefined.
  assert.equal(helpers.pickCategory(1, chain), 'move')
  assert.equal(helpers.pickCategory(-5, chain), 'idle')
})

test('bubbleDurationMs matches the desktop timing and clamps', () => {
  assert.equal(helpers.bubbleDurationMs(''), 2500)
  assert.equal(helpers.bubbleDurationMs('短'), 2500)
  // 40 characters: 1200 + 2400 = 3600ms, inside the window.
  assert.equal(helpers.bubbleDurationMs('字'.repeat(40)), 3600)
  // Long text stops growing at 8s.
  assert.equal(helpers.bubbleDurationMs('字'.repeat(500)), 8000)
})

test('quantizeMove snaps to whole strides and never returns zero', () => {
  assert.equal(helpers.quantizeMove(100, 90), 90)
  assert.equal(helpers.quantizeMove(140, 90), 180)
  assert.equal(helpers.quantizeMove(-140, 90), -180)
  assert.equal(helpers.quantizeMove(3, 120), 120)
  assert.equal(helpers.quantizeMove(-3, 120), -120)
  // A missing stride must not distort the distance.
  assert.equal(helpers.quantizeMove(77, 0), 77)
  assert.equal(helpers.quantizeMove(77, undefined), 77)
})

test('readSettings fills defaults and clamps hostile input', () => {
  const defaults = helpers.readSettings(null)
  assert.equal(defaults.bubbles, true)
  assert.equal(defaults.selfTalk, true)
  assert.equal(defaults.idleAnimation, 'off')

  const parsed = helpers.readSettings(
    JSON.stringify({ scale: 99, bubbleTextScale: -10, selfTalkMinMs: 10, selfTalkMaxMs: 1, bubbles: 'yes' }),
  )
  assert.equal(parsed.bubbleTextScale, 50)
  assert.equal(parsed.selfTalkMinMs, 3000)
  assert.equal(parsed.selfTalkMaxMs, 3000)
  assert.equal(parsed.bubbles, true, 'a non-boolean must not silently disable a feature')
  assert.equal(parsed.scale, undefined, 'a stale scale key from an older build is ignored')

  // Corrupt JSON must degrade to defaults instead of throwing.
  assert.deepEqual(helpers.readSettings('{not json'), defaults)
})

test('parseClips rejects junk and indexes what it accepts', () => {
  assert.equal(helpers.parseClips(null), null)
  assert.equal(helpers.parseClips({}), null)
  assert.equal(helpers.parseClips({ clips: [] }), null)
  // Without an idle clip the pet could never rest, so the whole set is refused.
  assert.equal(helpers.parseClips({ clips: [{ id: 'a', file: 'a.webm', category: 'random' }] }), null)

  const parsed = helpers.parseClips({
    clips: [
      { id: 'idle_breath', file: 'idle_breath.webm', category: 'idle' },
      { id: 'act_code', file: 'act_code.webm', category: 'random' },
      { id: 'broken' },
    ],
    canvas: [640, 360],
    body_box: [212, 60, 428, 330],
    chain: { idle: 0.3, turn: 0.4, act: 0.8, move: 1 },
  })
  assert.notEqual(parsed, null)
  assert.equal(parsed.clips.length, 2, 'malformed entries are dropped, not trusted')
  assert.equal(parsed.byCategory.idle.length, 1)
  assert.equal(parsed.byCategory.random.length, 1)
  assert.equal(parsed.byId.act_code.file, 'act_code.webm')
  assert.deepEqual(parsed.canvas, [640, 360])
})

test('bodyRectFractions converts the body box into frame fractions', () => {
  const rect = helpers.bodyRectFractions({ canvas: [640, 360], bodyBox: [212, 60, 428, 330] })
  assert.equal(rect.left, 212 / 640)
  assert.equal(rect.top, 60 / 360)
  assert.equal(rect.width, 216 / 640)
  assert.equal(rect.height, 270 / 360)
  // A missing box falls back to the whole frame rather than producing NaN.
  assert.deepEqual(helpers.bodyRectFractions({ canvas: [640, 360], bodyBox: null }), {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  })
})

test('the still frame and the decoder never paint at the same time (no double image)', () => {
  // Both layers are full-stage and share one geometry. When both painted, the
  // visible silhouette was the union of two different poses: measured on the
  // shipped clips that added 2%-14% extra opaque pixels on every action, which
  // is exactly the "重影" users reported.
  const poster = 'data:image/png;base64,AAA'
  for (const playing of [true, false]) {
    for (const source of [poster, null, '']) {
      const layers = helpers.mediaLayers(playing, source)
      assert.equal(
        layers.posterVisible && layers.video,
        false,
        `playing=${playing} poster=${source} paints two poses at once`,
      )
      assert.equal(
        Number(layers.posterVisible) + Number(layers.video),
        1,
        'exactly one layer paints the character',
      )
    }
  }
})

test('the decoder takes over the still frame instead of leaving a blank gap', () => {
  const poster = 'data:image/png;base64,AAA'
  const action = helpers.mediaLayers(true, poster)
  assert.equal(action.poster, true, 'the still frame stays mounted so its bitmap stays warm')
  assert.equal(action.posterVisible, false)
  assert.equal(action.video, true)
  assert.equal(action.videoPoster, poster, 'the decoder paints the same pixels while it warms up')

  const idle = helpers.mediaLayers(false, poster)
  assert.equal(idle.posterVisible, true)
  assert.equal(idle.video, false, 'idle must not keep a decoder alive')

  // Without an inlined still frame a decoder is still better than an empty corner.
  const noPoster = helpers.mediaLayers(false, null)
  assert.equal(noPoster.poster, false)
  assert.equal(noPoster.video, true)
  assert.equal(noPoster.videoPoster, null)
})

test('a playing pet hides the still frame and hands it to the decoder poster', () => {
  const description = sampleDescription()
  const clip = description.byId.click_happy
  const { tree, stateCount } = renderPet({
    [at('description')]: description,
    [at('clip')]: clip,
    [at('playing')]: true,
    [at('pos')]: { x: 10, y: 10 },
  })
  assert.equal(
    stateCount,
    STATE_ORDER.length,
    'the component useState order changed: update STATE_ORDER and this seed map',
  )
  assert.equal(findByType(tree, 'div').props['data-dsh-pet-stage'], '1', 'the pet must actually render')

  const poster = findByType(tree, 'img')
  const video = findByType(tree, 'video')
  assert.notEqual(poster, null, 'the still frame stays mounted while playing')
  assert.equal(poster.props.style.opacity, 0, 'the still frame must not paint under the decoder')
  assert.notEqual(video, null, 'a playing pet mounts a decoder')
  assert.equal(video.props.poster, description.idlePoster, 'the hand-over must not blink')
  assert.equal(video.props.key, 'video:' + clip.id, 'a reused element would keep the previous clip frame')
  assert.equal(video.props.src.endsWith('/' + clip.file), true, 'the decoder points at the clip')
})

test('the resting pet paints the still frame and mounts no decoder', () => {
  const description = sampleDescription()
  const { tree } = renderPet({
    [at('description')]: description,
    [at('clip')]: description.byId.idle_breath,
    [at('playing')]: false,
    [at('pos')]: { x: 10, y: 10 },
  })
  const poster = findByType(tree, 'img')
  assert.notEqual(poster, null)
  assert.equal(poster.props.style.opacity, undefined, 'the resting still frame is fully visible')
  assert.equal(findByType(tree, 'video'), null, 'idle must not keep a decoder alive')
})

test('a failed decoder puts the still frame back instead of leaving a corner empty', () => {
  // The still frame is hidden while a decoder is up, so a decoder that never
  // delivers a frame would otherwise leave nothing on screen at all.
  const description = sampleDescription()
  const { tree, setters } = renderPet({
    [at('description')]: description,
    [at('clip')]: description.byId.click_happy,
    [at('playing')]: true,
    [at('pos')]: { x: 10, y: 10 },
  })
  const video = findByType(tree, 'video')
  assert.equal(typeof video.props.onError, 'function', 'a decoder failure needs a handler')
  setters.length = 0
  assert.doesNotThrow(() => video.props.onError())
  assert.equal(
    setters.some((entry) => entry.index === at('playing') && entry.value === false),
    true,
    'a failed decoder must fall back to the still frame',
  )
  assert.equal(
    setters.some((entry) => entry.index === at('failure')),
    false,
    'a still frame is available, so this is not a reportable failure',
  )
})

test('without a fallback frame a decoder failure is reported rather than silent', () => {
  const description = sampleDescription({ withPoster: false })
  const { tree, setters } = renderPet({
    [at('description')]: description,
    [at('clip')]: description.byId.click_happy,
    [at('playing')]: true,
    [at('pos')]: { x: 10, y: 10 },
  })
  assert.equal(findByType(tree, 'img'), null, 'no inline frame means no still layer')
  setters.length = 0
  assert.doesNotThrow(() => findByType(tree, 'video').props.onError())
  assert.equal(
    setters.some((entry) => entry.index === at('failure') && typeof entry.value === 'string'),
    true,
    'with nothing to fall back to the pet must say so',
  )
})

test('the pet has no size control left and renders at a fixed scale', () => {
  // The size slider is gone by request; size is a constant now.
  assert.equal(helpers.FIXED_SCALE, 0.5)
  assert.equal(640 * helpers.FIXED_SCALE, 320)
  assert.equal(helpers.readSettings(null).scale, undefined, 'the scale setting must be gone')
  assert.equal(/settings\.scale/.test(source), false, 'nothing may read settings.scale again')
})

test('the shipped still frame is inlined and keeps its alpha channel (no black box)', () => {
  // Regression guard for two silent, very visible failures:
  //   - ffmpeg's native vp9 decoder drops the VP9 alpha stream, so the frame is
  //     opaque and the pet sits on a black rectangle;
  //   - a still frame served as a *file* 404s on a host whose allow-list predates
  //     the extension, and Chrome paints the failure as a bordered placeholder.
  // Both are avoided by inlining exactly one frame — and by checking the pixels,
  // not just the header (colour type 6 with an all-255 alpha is still opaque).
  const description = JSON.parse(readFileSync(join(here, '..', 'assets', 'clips.json'), 'utf8'))
  const poster = description.idle_poster
  assert.equal(typeof poster, 'string', 'the idle frame must be inlined')
  assert.equal(poster.startsWith('data:image/png;base64,'), true, 'expected an inline PNG')
  // Nothing may reference an image file: that is what produced the white box.
  for (const clip of description.clips) {
    assert.equal(clip.poster, undefined, `${clip.id} must not reference a poster file`)
  }
  const bytes = Buffer.from(poster.split(',', 2)[1], 'base64')
  const [lowest, highest] = pngAlphaExtrema(bytes)
  assert.equal(lowest < 255, true, 'the frame is fully opaque: it would render a black box')
  assert.equal(highest, 255, 'no fully opaque pixel, which is implausible')
})

test('no still-frame files are shipped at all', () => {
  const directory = join(here, '..', 'assets')
  const files = readdirSync(directory)
  assert.equal(files.filter((name) => name.endsWith('.png')).length, 0)
  assert.equal(files.filter((name) => name.endsWith('.webm')).length >= 14, true)
})

test('parseClips exposes the inlined idle frame used as the resting frame', () => {
  const parsed = helpers.parseClips({
    idle_poster: 'data:image/png;base64,AAA',
    clips: [
      { id: 'idle_breath', file: 'idle_breath.webm', category: 'idle' },
      { id: 'act_code', file: 'act_code.webm', category: 'random' },
    ],
  })
  assert.equal(parsed.idlePoster, 'data:image/png;base64,AAA')
  // An older descriptor that kept the frame on the clip still works.
  const legacy = helpers.parseClips({
    clips: [{ id: 'idle_breath', file: 'idle_breath.webm', category: 'idle', poster: 'data:image/png;base64,OLD' }],
  })
  assert.equal(legacy.idlePoster, 'data:image/png;base64,OLD')
})

test('anchorAfterResize keeps the bottom-right corner put and stays on screen', () => {
  const viewport = { width: 1000, height: 800 }
  const previous = { width: 300, height: 200 }
  const next = { width: 400, height: 260 }
  const pos = { x: 600, y: 500 }

  // Grew by 100x60, so the origin moves up-left by exactly that much.
  assert.deepEqual(helpers.anchorAfterResize(previous, next, pos, viewport), { x: 500, y: 440 })

  // Shrinking moves it back down-right.
  assert.deepEqual(helpers.anchorAfterResize(next, previous, { x: 500, y: 440 }, viewport), { x: 600, y: 500 })

  // Never leaves the viewport, even when the pet is bigger than the space left.
  const clamped = helpers.anchorAfterResize({ width: 300, height: 200 }, { width: 900, height: 700 }, { x: 700, y: 600 }, viewport)
  assert.deepEqual(clamped, { x: 100, y: 100 })

  // Unchanged size must not move the pet at all (identity, so callers can skip).
  assert.equal(helpers.anchorAfterResize(previous, previous, pos, viewport), pos)
  // Before the first placement there is nothing to anchor to.
  assert.equal(helpers.anchorAfterResize({ width: 0, height: 0 }, next, null, viewport), null)
})

test('the frame coalescer commits at most once per frame', () => {
  const queued = []
  const committed = []
  const push = helpers.createFrameCoalescer(
    (fn) => {
      queued.push(fn)
      return queued.length
    },
    () => committed.push(Date.now()),
  )

  // Ten pointer samples in one frame must produce exactly one commit.
  for (let index = 0; index < 10; index += 1) push()
  assert.equal(queued.length, 1)
  assert.equal(committed.length, 0, 'nothing commits before the frame runs')

  queued.shift()()
  assert.equal(committed.length, 1)

  // The next frame is free to schedule again.
  push()
  assert.equal(queued.length, 1)
})

test('the settings saver debounces and still flushes the last value', () => {
  let nextHandle = 0
  const pending = new Map()
  const saves = []
  const saver = helpers.createDebouncedSaver(
    (fn, delay) => {
      nextHandle += 1
      const handle = nextHandle
      // Model a real timer: firing removes it from the pending set.
      pending.set(handle, {
        fn: () => {
          pending.delete(handle)
          fn()
        },
        delay,
      })
      return handle
    },
    (handle) => pending.delete(handle),
    () => saves.push(1),
    250,
  )

  // A drag: many schedules, one timer left pending, zero writes yet.
  for (let index = 0; index < 20; index += 1) saver.schedule()
  assert.equal(pending.size, 1)
  assert.equal(saves.length, 0)

  const [{ fn, delay }] = [...pending.values()]
  assert.equal(delay, 250)
  fn()
  assert.equal(saves.length, 1)
  assert.equal(pending.size, 0)

  // A teardown with a write still pending must not lose the final value.
  saver.schedule()
  saver.flush()
  assert.equal(saves.length, 2)
  assert.equal(pending.size, 0)
  // Flushing twice is harmless.
  saver.flush()
  assert.equal(saves.length, 2)
})
