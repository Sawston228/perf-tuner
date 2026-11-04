/**
 * `dsh-perf-tuner` — keep every Harness session decisive and cheap.
 *
 * The rules injected by this plugin are distilled from the Bilibili video
 * 《[鱼供向视频]如何减少ai的雷霆大思考和降智行为》 (BV1mExE6AEJD, "给 AI 看的
 * 效率笔记：少想一点，想得更准"). The video's own closing line says it best:
 * 想清楚就动手，卡住了就换个脑子；少烧一点，多干一点。
 *
 * Three independent levers, all Host-side:
 *
 *   1. A static prompt section ("perf:policy") carrying the action rules.
 *      Static on purpose: the prefix cache in DeepSeek billing is ~50x cheaper
 *      on a hit, so nothing time-varying is ever injected here.
 *   2. An `agent/request` waterfall that caps `reasoningEffort` (down only).
 *      The video's "雷霆大思考" is exactly the `reasoningEffort: max` row in
 *      the profile patch; this plugin caps per request without touching the
 *      user's global model setting.
 *   3. An optional `tools/post-execute` trimmer for very long text results
 *      (off by default — truncation can hide information the model needs).
 *
 * The package is deliberately dependency-free: a workspace-linked bundle
 * cannot resolve the profile's or asar's `node_modules`, so it imports nothing
 * from `@deepseek-ai/*` and exports no schemastery `Config` schema. Defaults
 * and validation below are the contract.
 *
 * @module dsh-perf-tuner
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-perf-tuner'

/** Section id — own namespace to avoid clashing with tool/* and deployment rows. */
const SECTION_NAME = 'perf:policy'
/**
 * Built-in section orders put deployment persona at 0 and PLAN_POLICY at 500.
 * 400 keeps these rules after the persona and before the tool instructions.
 */
const SECTION_ORDER = 400

/** Reasoning effort ids accepted by the deepseek adapters, cheapest first. */
const EFFORT_RANK = Object.freeze({ off: 0, low: 1, high: 2, max: 3 })

/** Providers allowed to receive the capped effort (unknown providers keep theirs). */
const DEFAULT_PROVIDERS = ['deepseek-official']

/** Text longer than this is trimmed when `trimOutput` is on. */
const DEFAULT_TRIM_THRESHOLD = 15_000
/** Marker inserted where a long tool result was cut. */
const TRIM_MARKER = '\n\n[... middle of this tool result trimmed by dsh-perf-tuner trimOutput ...]\n\n'

/**
 * Full rule set (Chinese, the default). Kept short on purpose: every line is a
 * per-session prompt cost, and the video's own point is that padding costs more
 * than it earns.
 */
const RULES_ZH_FULL = `## 性能与效率政策（少想一点，想得更准）

以下规则默认适用于每个任务，除非用户明确要求深入分析、完整性审查或穷举方案。

1. 一次定论：同一个问题只推一遍，结论出来就往下走。代码写完、测试跑过就交付；「心里不踏实」不是新证据，只有拿到新证据才回头。
2. 不猜就查：能用一条命令确认的事（路径、版本、依赖、配置），不要在心里推演；心里推十次不如跑一次。
3. 先亮依据：写下结论前先问「依据是哪一条」——工具输出、源码行、实测数字至少占一个；指不出来就把结论标成待验证。外推前先数样本，N=2 不是证据。
4. 工具调用成批：每调一次工具都是一整轮重发上下文。能一条命令读完多个文件就合并，能一次查完就别拆成几轮；不重复读同一文件、不重复跑同一命令来「确认」已有结果。
5. 两次失败就停：同一路径连续两次失败，别微调参数硬试第三次（换参数、换命令不算换路）；先换维度——换思路、换工具或换执行者（子代理）。
6. 前缀缓存保护：会话期间不要无故更换模型、推理强度，也不要增删工具——请求开头一变，整段上下文就要按全价重算，前缀缓存省下的钱可能一次赔光；也不要在系统提示里注入每轮都变的实时数据。
7. 上下文卫生：不反复粘贴同一段报错，不用催促或责备（「你怎么又错了」）驱动进度——它们会留在历史里变成后续依据，并诱导跳过验证。给事实、不给判断；污染已重就建议用户开新会话。
8. 长任务换个脑子：输出长、只需要结论的任务（日志分析、资料汇总、多源比对、批量抓取）交给子代理，主对话只保留结论；连中间成品都不需要检查时，让子代理直接产出文件并只回路径。短任务自己做，不要为省 token 多派活。
9. 输出节制：先给答案或改动，解释长度与风险成正比；不寒暄、不复述计划、不用「可能/也许」堆免责；三行答案不用小标题。
10. 想清楚就动手：连续几步的思考没有改变计划时，立即停止思考、执行下一步。`

/** Compact variant: the five thinking rules plus one cost line. */
const RULES_ZH_LEAN = `## 性能与效率政策（少想一点，想得更准）

1. 一次定论：同一问题只推一遍，结论出来就往下走；「心里不踏实」不是新证据。
2. 不猜就查：能用一条命令确认的，不要在心里推演；心里推十次不如跑一次。
3. 先亮依据：结论必须能指到工具输出、源码行或实测数字；N=2 不是证据。
4. 工具调用成批：一次调用就是一轮上下文重发，能合并就合并，不重复确认已有结果。
5. 两次失败就停：同一路径连续两次没成，先换维度（思路/工具/执行者），换参数不算换路。
6. 前缀缓存保护：会话中不无故换模型、改推理强度、增删工具，不注入每轮都变的系统提示。`

const RULES_EN_FULL = `## Performance and effort policy (think less, be more accurate)

These rules apply to every task unless the user explicitly asks for a deep analysis, a completeness review, or an exhaustive comparison of options.

1. Decide once: reason through a question only once and move on when the conclusion is reachable. If code is written and tests pass, deliver it; unease is not new evidence, and only new evidence justifies revisiting a decision.
2. Check instead of guessing: anything one command can confirm (paths, versions, installs, configuration) should not be reasoned about; one command beats ten mental simulations.
3. Cite the evidence first: before stating a conclusion, ask which evidence backs it — tool output, a source line, or a measured number. If none can be named, mark the conclusion as unverified. Before extrapolating, count samples; N=2 is not evidence.
4. Batch tool calls: every call is a full context resend. Combine reads of multiple files into one command, finish a lookup in one pass instead of six rounds, and never re-read a file or re-run a command merely to "confirm" a result you already have.
5. Stop after two failures: when the same approach fails twice, do not tweak parameters for a third try (a new flag or command is still the same path). Change the dimension first: different approach, different tool, or a subagent as a different executor.
6. Protect the prefix cache: do not change model, reasoning effort, or the tool set mid-session without reason — any change to the request prefix re-bills the whole context at full price and can erase what the cache saved. Never inject per-turn live data into the system prompt.
7. Keep context clean: do not paste the same error repeatedly, and do not drive progress with pressure or blame — that history becomes later evidence and invites skipped verification. Give facts, not judgments; when the context is already polluted, suggest a new session.
8. Use a different brain for long tasks: hand long-output, conclusion-only work (log analysis, research summaries, multi-source comparison, bulk scraping) to a subagent and keep only the conclusion in the main conversation; when the deliverable itself needs no checking, have the subagent produce the file and return only its path. Do short work yourself instead of delegating to save tokens.
9. Keep output lean: lead with the answer or the change and scale explanation to risk. No pleasantries, no restating the plan, no hedging walls of "probably/might", no headers for a three-line answer.
10. Think, then act: when several consecutive thinking steps have not changed the plan, stop thinking and execute the next step.`

const RULES_EN_LEAN = `## Performance and effort policy (think less, be more accurate)

1. Decide once: reason through a question once and move on; unease is not new evidence.
2. Check instead of guessing: do not simulate what one command can confirm.
3. Cite evidence: name the tool output, source line, or measured number behind every conclusion; N=2 is not evidence.
4. Batch tool calls: each call resends the whole context; merge reads and never re-confirm a result you already have.
5. Stop after two failures: change the dimension (approach, tool, or subagent), not the parameters.
6. Protect the prefix cache: no mid-session model/effort/tool changes and no per-turn live data in the system prompt.`

/**
 * Read the row's raw config defensively.
 *
 * No `Config` schema is exported on purpose; these defaults are the contract.
 *
 * @param {unknown} raw
 */
function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {}
  const providers = Array.isArray(config.providers)
    ? config.providers.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
    : []
  const extraRules = Array.isArray(config.extraRules)
    ? config.extraRules
        .filter((value) => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim())
    : []

  /** @type {'none' | 'low' | 'high' | 'max'} */
  let effortCap = 'high'
  if (config.effortCap === 'low' || config.effortCap === 'high' || config.effortCap === 'max') effortCap = config.effortCap
  else if (config.effortCap === 'none' || config.effortCap === false) effortCap = 'none'

  /** @type {'full' | 'lean' | 'off'} */
  let rules = 'full'
  if (config.rules === false || config.rules === 'off') rules = 'off'
  else if (config.rules === 'lean') rules = 'lean'

  const threshold = Number.isFinite(config.trimThresholdChars) && Number(config.trimThresholdChars) >= 2000
    ? Math.trunc(Number(config.trimThresholdChars))
    : DEFAULT_TRIM_THRESHOLD

  return {
    rules,
    language: config.language === 'en' ? 'en' : 'zh',
    effortCap,
    providers: providers.length > 0 ? providers : DEFAULT_PROVIDERS,
    extraRules,
    trimOutput: config.trimOutput === true,
    trimThresholdChars: threshold,
  }
}

/**
 * Render the static prompt section body. This function is deterministic given
 * the config: the same text is emitted for every step of every session, which
 * is what keeps the prompt prefix (and therefore the billed cache hit) stable.
 *
 * @param {ReturnType<typeof resolveConfig>} config
 */
function renderRules(config) {
  const table = config.language === 'en'
    ? { full: RULES_EN_FULL, lean: RULES_EN_LEAN }
    : { full: RULES_ZH_FULL, lean: RULES_ZH_LEAN }
  const base = config.rules === 'lean' ? table.lean : table.full
  if (config.extraRules.length === 0) return base
  const numberingStart = config.rules === 'lean' ? 7 : 11
  const extra = config.extraRules.map((line, index) => `${numberingStart + index}. ${line}`).join('\n')
  return `${base}\n${extra}`
}

/**
 * Return a capped effort for the current request, or `undefined` when the
 * current effort is already at or below the cap (or the value is unknown).
 *
 * Only downgrades. An absent effort is treated as the adapter default (`high`)
 * so the plugin never raises a lower user selection. `off` ranks below every
 * cap and is left alone.
 *
 * @param {unknown} effort
 * @param {'low' | 'high' | 'max'} cap
 */
function capEffort(effort, cap) {
  const capRank = EFFORT_RANK[cap]
  const current = typeof effort === 'string' && Object.prototype.hasOwnProperty.call(EFFORT_RANK, effort)
    ? effort
    : 'high'
  return EFFORT_RANK[current] > capRank ? cap : undefined
}

/**
 * Effort ids each provider/model actually advertises, cached per route.
 *
 * The adapter validates the effort *after* the `agent/request` waterfall and
 * throws `UNSUPPORTED_REASONING_EFFORT` (failing that whole step) when the
 * value is not advertised. A plugin can therefore not fail open there; the only
 * safe policy is to modify the config only when the model explicitly lists the
 * capped effort. Unknown routes are left untouched.
 */
const effortSupport = new Map()

/**
 * @param {any} llm
 * @param {string} provider
 * @param {string} model
 * @param {string} effort
 * @returns {Promise<boolean>}
 */
async function supportsEffort(llm, provider, model, effort) {
  const key = `${provider}\u0000${model}`
  let allowed = effortSupport.get(key)
  if (allowed === undefined) {
    allowed = null
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info?.reasoning?.efforts
      allowed = Array.isArray(efforts)
        ? new Set(efforts.map((item) => (typeof item === 'string' ? item : item?.id)).filter((id) => typeof id === 'string'))
        : new Set()
      effortSupport.set(key, allowed)
    } catch {
      // Service missing or adapter unavailable: stay conservative and skip.
      return false
    }
  }
  return allowed.has(effort)
}

/**
 * Log a degraded state where the user can actually see it.
 *
 * @param {any} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  try {
    if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(message)
      return
    }
  } catch { /* fall through to console */ }
  try {
    globalThis.console?.warn?.(message)
  } catch { /* logging is best-effort */ }
}

/**
 * Trim one text block, keeping head and tail around a visible marker.
 *
 * @param {string} text
 * @param {number} threshold
 */
function truncateText(text, threshold) {
  const tail = Math.min(4_000, Math.floor(threshold / 5))
  const head = Math.max(1, threshold - tail)
  return `${text.slice(0, head)}${TRIM_MARKER}${text.slice(-tail)}`
}

/**
 * Plugin entry point.
 *
 * @param {import('cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 1) Static prompt section: the video's action rules, for every agent.
  const systemPrompt = ctx.get?.('systemPrompt')
  if (config.rules !== 'off' && systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        text: renderRules(config),
      })
    } catch (error) {
      // A prompt section must never take the agent down; degrade to the other
      // levers and leave a visible trace in the Host log.
      warn(ctx, `[dsh-perf-tuner] prompt section registration failed: ${error?.message ?? error}`)
    }
  }

  // 2) Per-request effort cap: fixes the "雷霆大思考" without editing the
  //    user's global model row. Fail-open: any surprise returns the original.
  //
  //    `prepend: true` is required: waterfall listeners compose with the first
  //    registered outermost, and each session installs its own model-selection
  //    listener (registered when the session was created, i.e. before this
  //    plugin may load) that rewrites reasoningEffort wholesale. Without
  //    prepend we would sit inside it and cap a value it then restores.
  if (config.effortCap !== 'none') {
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      try {
        if (resolved === null || typeof resolved !== 'object') return resolved
        if (!config.providers.includes(resolved.provider)) return resolved
        const capped = capEffort(resolved.reasoningEffort, config.effortCap)
        if (capped === undefined) return resolved
        const llm = ctx.get?.('llm')
        if (llm === undefined || !(await supportsEffort(llm, resolved.provider, resolved.model, capped))) return resolved
        return { ...resolved, reasoningEffort: capped }
      } catch {
        return resolved
      }
    }, { prepend: true })
  }

  // 3) Optional tool-result trimmer. Post-execute may only transform results,
  //    never deny them. The model-facing content lives on the `result`
  //    parameter; the default accept decision carries no `content`, so the
  //    trimmed array is attached to the returned decision. Error results and
  //    structured-output decisions are never touched.
  if (config.trimOutput) {
    ctx.on('tools/post-execute', async (_exec, result, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'accept') return decision
        if ('value' in decision) return decision
        if (result?.isError === true) return decision
        if (!Array.isArray(result?.content)) return decision
        let changed = false
        const content = result.content.map((block) => {
          if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return block
          if (block.text.length <= config.trimThresholdChars) return block
          changed = true
          return { ...block, text: truncateText(block.text, config.trimThresholdChars) }
        })
        return changed ? { ...decision, content } : decision
      } catch {
        return decision
      }
    })
  }
}
