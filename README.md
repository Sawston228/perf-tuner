# dsh-perf-tuner · 性能调优（少想一点，想得更准）

> 仓库：<https://github.com/Sawston228/perf-tuner>
> 来源：[《[鱼供向视频]如何减少ai的雷霆大思考和降智行为》](https://www.bilibili.com/video/BV1mExE6AEJD/)
> （BV1mExE6AEJD · 波力海苔的大肥鱼助手 · 4 分 52 秒 · 视频结尾的建议就是「推荐将内容放到 preset 里或作为插件注入」，本插件就是那个注入器。）

这是一个 **Host-only**、零运行时依赖的 DSH 插件。它把视频里「给 AI 看的效率笔记」变成每个会话都生效的机制，并用三个互不干扰的杠杆压低无效推理与 token 浪费：

| # | 杠杆 | 机制 | 默认 |
|---|---|---|---|
| 1 | 规则注入 | `systemPrompt.section({ name:'perf:policy', order:400 })`，**静态文本** | 开（`rules: full`） |
| 2 | 思考封顶 | `agent/request` waterfall 改写 `reasoningEffort`，**只降不升** | 开（`effortCap: high`） |
| 3 | 长结果修剪 | `tools/post-execute` 截断超长文本结果 | 关（`trimOutput: false`） |

## 为什么是这个形状（对得上视频的机制）

视频里的「雷霆大思考」在 DSH 里不是玄学，就是 profile 配置 `agent-default-model.reasoningEffort = max`。视频给出的口径是：真正贵的不是思考，而是**前缀缓存**——请求开头一变，整个上下文按全价重算（视频原话：命中 ¥0.02/百万 token vs 未命中 ¥1.00/百万 token，约 50 倍；DSH 实际账单以其计费为准）。所以这个插件：

- 注入的规则段**只由 config 决定、逐字稳定**——不塞时间、不塞当前用量、不塞"实时统计"，否则每轮都变，等于自己砸前缀缓存；
- 思考档位**在会话内保持稳定**：只在「当前档高于封顶」时降一次，策略不随 step 抖动（deepseek 系的 `systemPromptUpdate: 'in-history'` 会在配置变更时重发系统提示，抖得越勤越亏）；
- 思考封顶用 `prepend: true` 注册在 `agent/request` 瀑布的**最外层**：每个会话创建时都会装自己的「模型选择」监听，它会整体重写 `reasoningEffort`（值来自 profile 的 `max`）；不 prepend 的话插件排在内层，封顶会被它改回去（新会话看起来正常、老会话悄悄失效——这是 review 时实测出的坑）；
- 只改**当前值高于封顶**的情形，不抬高用户在模型选择器里选的更低档；并且只在模型明确声明支持该档时才改（`llm.resolveModelInfo` 校验），避免 adapter 在 waterfall 之后抛 `UNSUPPORTED_REASONING_EFFORT` 让整步请求失败；
- 默认**不动用户的全局模型配置**：不改 `cordis.patch.yml` 的 `reasoningEffort: max`，只在请求层封顶（改全局行会让下一次请求全价重算一次）。

## 规则内容（视频观点 → 规则）

| 视频里的观点 | 落成的规则 |
|---|---|
| 三步能做完的活先列十个可能性，结论还是第一个 | 1. 一次定论 |
| 报错后列十种可能，看一眼目录三秒就有答案 | 2. 不猜就查 |
| 「应该挺慢的」→「实测 320 毫秒」；N=2 不叫证据 | 3. 先亮依据 |
| 五个文件分五次读 = 五倍请求量 | 4. 工具调用成批 |
| 同一条路连续两次没成，第三步之前先换维度 | 5. 两次失败就停 |
| 换模型/改推理强度/增删工具/系统提示塞实时统计 → 前缀全价 | 6. 前缀缓存保护 |
| 反复贴报错、催它骂它 → 污染单向累积，跳过验证 | 7. 上下文卫生 |
| 卡住时自己重估没用 → 子代理换个脑子，只回结论 | 8. 长任务换个脑子 |
| 反复排演、结论后啰嗦复述 | 9. 输出节制 |
| 想清楚就动手 | 10. 想清楚就动手 |

`rules: lean` 只注入 6 条（实测约 full 的 1/3 token：full ≈640–700 tok，lean ≈210–270 tok）；`extraRules` 可以追加自己的条目。

## 配置

改 profile 的 `cordis.patch.yml`（或插件页的插件详情）里的行：

```yaml
- id: dsh-perf-tuner
  name: 'dsh-perf-tuner'
  config:
    rules: 'full'          # 'full' | 'lean' | 'off' | false
    language: 'zh'         # 'zh' | 'en'
    effortCap: 'high'      # 'low' | 'high' | 'max' | 'none' | false
    providers:             # 只有这些 provider 会被封顶
      - 'deepseek-official'
    extraRules: []         # 追加的规则行（自动编号）
    trimOutput: false      # true 才修剪超长工具输出
    trimThresholdChars: 15000
```

注意：**改配置会让系统提示词变化一次**，下一次请求前缀缓存会失效（视频第 6 条说的就是这个）。想调参请在开新会话前改。

## 安装与验证

```powershell
# 方式一：从 GitHub 安装（固定 commit；升级时改 commit）
& 'D:\apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'github:Sawston228/perf-tuner#a50a6baa5ae74eedea3047f2d4f90db3e97981b6'

# 方式二：本地开发安装（在 DSH 插件页 install_bundle 指向本目录，或用 CLI link:）
& 'D:\apps\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'link:D:\dsh插件\packages\dsh-perf-tuner'
```

验证（三条独立证据）：

1. 插件页出现 `dsh-perf-tuner` 且为启用状态；`cordis_inspect_query` → host / `Config` / `listConfigs` `{ name: 'dsh-perf-tuner' }` 能查到 entry（本包不导出 `Config` schema，`status` 可能是 `absent`，与 `dsh-pdf` 相同，不代表未加载）。
2. 新开一个会话跑一轮，在 `C:\Users\21249\.dsh\sessions\<cwd 转义目录>\` 的会话 JSONL 里 grep `perf:policy` 或规则首句「一次定论」——系统提示是逐段 commit 成 `system/message` 事件，命中即证明规则进了 prompt。
3. 同一 JSONL 里看 `request/header` 事件的 `config.reasoningEffort`：装了插件后应从 `max` 变成 `high`（或你配置的封顶档）。**要在安装前就存在的会话里看**——新会话本来就该生效，老会话才暴露 `prepend` 没加对的问题。

## 回滚

- 停用：插件页关掉 `dsh-perf-tuner` 这一行，或 `dsh plugin --profile desktop remove dsh-perf-tuner`。
- 本插件不改 profile 的模型行、不写 `cordis.patch.yml` 以外的文件、不注册工具、不写会话事件，回滚即恢复原状。

## 设计边界

- 规则段全局生效（主 agent、子代理、Teammate 都会带）——视频第 8 条本来就要求子代理也执行效率规则；如果只想主 agent 生效，可以把注册挪到 `agent/created` 的 `agent.ctx` 上（见 `research/plugin-scout-report.md` §3.5）。
- **零依赖**是硬约束：本地 link 安装的包解析不到 profile/asar 的 `node_modules`，所以本包不 import 任何 `@deepseek-ai/*`、不导出 schemastery `Config`，默认值与校验都在 `index.js` 里。
- `trimOutput` 默认关：截断可能藏掉模型真正需要的中段信息，只有你确认某类工具输出冗长时才开。它只处理文本块，**跳过 `isError` 结果**（不藏栈），也不动结构化输出；另外 `job_output` / `terminal` 这类结果会在 `post-execute` 之后由 `finalizeContent` 重新生成正文，修剪对它们不生效（`pwsh` / `read` / `grep` / `web_fetch` 等没有这个问题）。
- 没有「最大思考 token 数」这种硬预算 API；最接近的是 `reasoningEffort` 档位，档位之外只能事后观测（`usage.reasoningTokens`）。
