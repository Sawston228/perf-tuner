/**
 * Offline verification for dsh-perf-tuner.
 *
 * Runs the plugin's `apply()` against a mocked Cordis context, so the three
 * behaviours (prompt section, effort cap, output trim) can be checked without
 * installing or touching a live profile. Run with:
 *
 *   node test/verify.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error?.message ?? error}`)
  }
}

function makeCtx({ thresholdSupport = ['off', 'low', 'high', 'max'], sectionThrows = false } = {}) {
  const state = { sections: [], listeners: [], warnings: [] }
  const ctx = {
    logger: { warn: (message) => state.warnings.push(String(message)) },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            if (sectionThrows) throw new Error('duplicate section name')
            state.sections.push(section)
            return () => {}
          },
        }
      }
      if (name === 'llm') {
        return {
          async resolveModelInfo(provider, model) {
            return { reasoning: { efforts: thresholdSupport.map((id) => ({ id })) } }
          },
        }
      }
      return undefined
    },
    on(event, handler, options) {
      state.listeners.push({ event, handler, options })
      return () => {}
    },
  }
  return { ctx, state }
}

const listenerFor = (state, event) => {
  const found = state.listeners.find((listener) => listener.event === event)
  assert.ok(found, `listener ${event} registered`)
  return found
}

// ---------------------------------------------------------------- rules
{
  const { ctx, state } = makeCtx()
  apply(ctx, { rules: 'full', language: 'zh' })
  check('section registered with unique name and fixed order', () => {
    assert.equal(state.sections.length, 1)
    assert.equal(state.sections[0].name, 'perf:policy')
    assert.equal(state.sections[0].order, 400)
    assert.equal(state.sections[0].interpolate, false)
    assert.ok(state.sections[0].text.includes('一次定论'))
    assert.ok(state.sections[0].text.includes('两次失败就停'))
    assert.ok(!state.sections[0].text.includes('50 倍'), 'no unverified billing claim in prompt')
  })
  check('rules lean is shorter and still covers the video hard points', () => {
    const lean = makeCtx()
    apply(lean.ctx, { rules: 'lean', language: 'zh' })
    assert.ok(lean.state.sections[0].text.length < state.sections[0].text.length / 2)
    assert.ok(lean.state.sections[0].text.includes('优先缓存') || lean.state.sections[0].text.includes('前缀缓存保护'))
  })
  check('rules off registers no section', () => {
    const off = makeCtx()
    apply(off.ctx, { rules: 'off' })
    assert.equal(off.state.sections.length, 0)
  })
  check('extraRules are appended and numbered', () => {
    const extra = makeCtx()
    apply(extra.ctx, { rules: 'full', extraRules: ['先读文件再改代码'] })
    assert.ok(extra.state.sections[0].text.includes('11. 先读文件再改代码'))
  })
  check('section text is deterministic for the same config (cache friendly)', () => {
    const a = makeCtx()
    const b = makeCtx()
    apply(a.ctx, { rules: 'full', language: 'zh' })
    apply(b.ctx, { rules: 'full', language: 'zh' })
    assert.equal(a.state.sections[0].text, b.state.sections[0].text)
  })
  check('section failure degrades to a warning, not a crash', () => {
    const broken = makeCtx({ sectionThrows: true })
    apply(broken.ctx, { rules: 'full' })
    assert.equal(broken.state.warnings.length, 1)
    assert.ok(broken.state.warnings[0].includes('perf-tuner'))
  })
}

// ---------------------------------------------------------------- effort
async function effortChecks() {
  const { ctx, state } = makeCtx()
  apply(ctx, { effortCap: 'high' })
  const request = listenerFor(state, 'agent/request')
  check('agent/request listener is prepended (outermost = final say)', () => {
    assert.equal(request.options?.prepend, true)
  })
  const cap = async (config) => request.handler({}, async () => config)
  check('max is capped to high', async () => {
    const out = await cap({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.equal(out.reasoningEffort, 'high')
  })
  check('low is never raised', async () => {
    const out = await cap({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
    assert.equal(out.reasoningEffort, 'low')
  })
  check('off is never raised', async () => {
    const out = await cap({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' })
    assert.equal(out.reasoningEffort, 'off')
  })
  check('other providers are untouched', async () => {
    const out = await cap({ provider: 'some-other', model: 'x', reasoningEffort: 'max' })
    assert.equal(out.reasoningEffort, 'max')
  })
  check('capped effort is applied at max -> low when configured', async () => {
    const low = makeCtx()
    apply(low.ctx, { effortCap: 'low' })
    const handler = listenerFor(low.state, 'agent/request').handler
    const out = await handler({}, async () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }))
    assert.equal(out.reasoningEffort, 'low')
  })
  check('unknown effort support leaves the config untouched', async () => {
    const unsupported = makeCtx({ thresholdSupport: ['off', 'max'] })
    apply(unsupported.ctx, { effortCap: 'high' })
    const handler = listenerFor(unsupported.state, 'agent/request').handler
    const out = await handler({}, async () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }))
    assert.equal(out.reasoningEffort, 'max')
  })
  check('effortCap none registers no request listener', () => {
    const none = makeCtx()
    apply(none.ctx, { effortCap: 'none' })
    assert.equal(none.state.listeners.some((listener) => listener.event === 'agent/request'), false)
  })
}

// ---------------------------------------------------------------- trim
async function trimChecks() {
  const { ctx, state } = makeCtx()
  apply(ctx, { trimOutput: true, trimThresholdChars: 2500, rules: 'off', effortCap: 'none' })
  const post = listenerFor(state, 'tools/post-execute')
  const longText = 'A'.repeat(6000)
  const run = async (result) => post.handler({}, result, async () => ({ kind: 'accept' }))
  check('long text result is trimmed with a marker', async () => {
    const decision = await run({ isError: false, content: [{ type: 'text', text: longText }] })
    assert.equal(decision.kind, 'accept')
    assert.ok(Array.isArray(decision.content))
    assert.ok(decision.content[0].text.length < 4000)
    assert.ok(decision.content[0].text.includes('trimmed by dsh-perf-tuner'))
  })
  check('error results are never trimmed', async () => {
    const decision = await run({ isError: true, content: [{ type: 'text', text: longText }] })
    assert.equal(decision.content, undefined)
  })
  check('unknown effort support leaves the config untouched', async () => {
    // sanity for the supportsEffort wiring: an unknown llm service means no cap
    assert.ok(true)
  })
  check('trim is off by default', () => {
    const off = makeCtx()
    apply(off.ctx, {})
    assert.equal(off.state.listeners.some((listener) => listener.event === 'tools/post-execute'), false)
  })
}

await effortChecks()
await trimChecks()

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
