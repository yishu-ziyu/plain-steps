import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Outcome } from '../types'

// true：每一步一行中文；false：引擎原样画（完整命令和输出）。/steps 切换。
const plain = atom({ plugin: 'plain-steps', key: 'plain' } as const, true)

// REPL 在后台跑：调用当场只回一张收据（evalId），结果随后从 Poll 送到。
// waiting：evalId → 那次 REPL 调用的 tool_use_id；done：tool_use_id → 结果。
const waiting = atom({ plugin: 'plain-steps', key: 'waiting' } as const, {} as Record<string, string>)
const done = atom({ plugin: 'plain-steps', key: 'done' } as const, {} as Record<string, Outcome>)
// 只留最近这么多条，旧的行退回显示“✓”。
const MAX_KEPT = 300
// 没写说明的脚本：另请模型补一句“为了什么”。tool_use_id → 那句话。
const guessed = atom({ plugin: 'plain-steps', key: 'guessed' } as const, {} as Record<string, string>)
// 补说明时给模型的上下文：用户最近一句话、Claude 调用前说的话。重载后从头记。
let lastAsk = ''
// 失败的那一步：用一句人话说卡在哪儿。tool_use_id → 那句话（没问到就是报错最后一行）。
const explained = atom({ plugin: 'plain-steps', key: 'explained' } as const, {} as Record<string, string>)
// 改东西的步骤：根据实际执行的改动写一句“从什么改成什么”。tool_use_id → 那句话。
const changed = atom({ plugin: 'plain-steps', key: 'changed' } as const, {} as Record<string, string>)
// 每个步骤实际做了哪些改动（脚本里的改文件、会改东西的命令）。重载后从头记。
const evidence = new Map<string, string[]>()
// 每个循环里最近派出的脚本：脚本里的调用记到它名下。
const currentScript = new Map<string, string>()
// 每次调用的说明，解释报错时给模型当上下文。重载后从头记。
const purposeOf = new Map<string, string>()
let lastSaid = ''
const keepLast = <T,>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).slice(-MAX_KEPT))

// 每次调用花了多久（模块自己的变量，重载后从头记）。
const took = new Map<string, number>()
const started = new Map<string, number>()

const field = (v: unknown, k: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const clip = (t: string, n: number) => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
const fileName = (v: unknown) => str(v).split('/').filter(Boolean).at(-1) ?? ''

// 只接手这些工具的行；别的工具照引擎原样画。
const LABELS: Record<string, (input: unknown) => string> = {
  Bash: i => clip(str(field(i, 'description')), 80) || clip(str(field(i, 'command')).replace(/\/Users\/[^\s"']*\//g, '…/'), 60),
  Read: i => `读 ${fileName(field(i, 'file_path'))}`,
  Edit: i => `改 ${fileName(field(i, 'file_path'))}`,
  MultiEdit: i => `改 ${fileName(field(i, 'file_path'))}`,
  Write: i => `写 ${fileName(field(i, 'file_path'))}`,
  Grep: i => `搜 “${clip(str(field(i, 'pattern')), 40)}”`,
  Glob: i => `找文件 ${clip(str(field(i, 'pattern')), 40)}`,
  Agent: i => `派子代理：${clip(str(field(i, 'description')), 60)}`,
  SendMessage: i => `发消息给 ${clip(str(field(i, 'to')), 30)}${str(field(i, 'summary')) ? `：${clip(str(field(i, 'summary')), 50)}` : ''}`,
  ToolSearch: () => '加载工具',
  // 没写说明时不露代码：用户读不懂代码，宁可说得笼统。
  REPL: i => clip(str(field(i, 'description')), 80),
  Skill: i => `用技能 ${clip(str(field(i, 'skill')), 40)}`,
}

// 说明的写法：对象在前，读的写查什么、改的写从什么改成什么；不用套话开头，不露代码。
const DESCRIBE = [
  'Every REPL and Bash call carries a `description`: one line, in the language the person writes in, that a non-programmer reads to follow your work. They cannot read code.',
  'Start with the product area or thing concerned, then a colon, then what you want to learn or what changes. A step that changes something says from what to what.',
  'Good: 「结算页优惠券：查叠加与门槛规则」「登录弹窗：重发间隔从 30 秒改为 60 秒」「新会话：确认 REPL 还能用」「旧支付接口：确认已没有残留」.',
  'Bad: 「为了了解优惠券逻辑，正在查看结算代码」「运行脚本」「读取 index.ts」「执行 git status」.',
  'Never open with 为了, 正在, 尝试, 查看, 运行, 执行, 检查一下 or their equivalents. Never name files, paths, commands, functions or variables. Keep it under about 25 characters. Never leave it out.',
].join(' ')

const GUESS_SYSTEM = [
  '你替一个看不懂代码的产品人，用一行中文说明 AI 编程助手正在做的这一步。',
  '格式：对象在前，冒号，再写想弄清什么或改成什么；改动要写从什么改成什么。不超过 25 个字。',
  '好：「结算页优惠券：查叠加与门槛规则」「新会话：确认 REPL 还能用」「登录弹窗：重发间隔改为 60 秒」。',
  '差：「为了了解优惠券逻辑，正在查看代码」「运行脚本」「读取配置文件」。',
  '不要以 为了、正在、尝试、查看、运行、执行、检查 开头；不出现文件名、路径、命令、函数名、变量名；只输出这一行，不加引号和句号。',
].join('\n')

const guessPurpose = async ($: EngineInterface, id: string, code: string) => {
  const prompt = [
    lastAsk && `用户刚才说：${clip(lastAsk, 400)}`,
    lastSaid && `助手调用前说：${clip(lastSaid, 400)}`,
    `这一步的代码：\n${code.slice(0, 3000)}`,
  ].filter(Boolean).join('\n\n')
  const r = await $.model.complete({ model: 'sonnet', system: GUESS_SYSTEM, prompt, maxTokens: 80, effort: 'low' })
  const text = r.isAnswered ? clip(r.text.replace(/^["“「]|["”」。]$/g, ''), 40) : ''
  if (text) {
    purposeOf.set(id, text)
    await update($, guessed, g => keepLast({ ...g, [id]: text }))
  }
}

// 这段脚本会不会改东西：看代码里有没有写文件、改仓库、装依赖、删东西，以及脚本里实际调了哪些工具。
// 看不准时算作“会改”，宁可多占一行，也不把改动藏进合并行。
// 脚本代码本身：写文件、改文件、派子代理。
const JS_WRITES = /\b(write|edit)\s*\(|tools\.(Write|Edit|NotebookEdit|Agent)\b/
// 脚本里跑的命令（反引号里的那部分）：改仓库、删改文件、装依赖、写进文件、发改动请求。
const SHELL_WRITES = /\bgit\s+(commit|push|add|rm|mv|reset|checkout|switch|merge|rebase|stash|tag|clean|init|clone|pull)\b|\b(rm|mv|cp|mkdir|touch|ln|chmod|kill|pkill|killall)\s|sed\s+-i|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|publish|run)\b|\b(pip|brew|cargo)\s+install|\btmux\s+(new|kill|send)|-X\s*(POST|PUT|PATCH|DELETE)|(?<![\d&])>>?\s*[\w~/.$'"]/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent'])
const shellPartsOf = (code: string) => (code.match(/`[^`]*`/g) ?? []).join('\n').replace(/\d?>\s*\/dev\/null|\d>&\d/g, '')
const isLookOnly = (code: string, inner: readonly { tool: string }[]) =>
  !JS_WRITES.test(code) && !SHELL_WRITES.test(shellPartsOf(code)) && !inner.some(c => EDIT_TOOLS.has(c.tool))

const isInside = (id: string | undefined) => (id ?? '').startsWith('repl_')

const EXPLAIN_SYSTEM = [
  'AI 编程助手的一步出错了。你用一句中文告诉一个看不懂代码的产品人：卡在了哪儿。',
  '直接说原因：缺了什么、哪里写错了、哪项检查没通过、没有权限、连不上网、找不到东西。对象在前，比如「订单导出：空列表没有兜底，测试没通过」「设置文件：不存在」。',
  '只有需要这个人提供或决定什么时才说出来。不转述用户的要求，不说助手接下来做不做什么，不以「想」「尝试」「为了」开头。',
  '不出现文件路径、命令、函数名、错误码、英文报错原文。不超过 25 个字。只输出这一句，不加引号和句号。',
].join('\n')

const PLAIN_FAILURE = '正在弄清哪里出了问题…'
// 用户按 Esc、拒绝了权限：不是出错，不用解释。
const NOT_A_FAILURE = /interrupted|doesn't want to proceed|was rejected|user denied|declined/i

const explainFailure = async ($: EngineInterface, id: string, error: string) => {
  if (!error.trim() || NOT_A_FAILURE.test(error) || (await read($, explained))[id] !== undefined) return
  const body = error.length > 4000 ? `${error.slice(0, 1500)}\n…\n${error.slice(-2500)}` : error
  const prompt = [
    lastAsk && `用户刚才说：${clip(lastAsk, 300)}`,
    purposeOf.get(id) && `这一步原本要做：${purposeOf.get(id)}`,
    `报错原文：\n${body}`,
  ].filter(Boolean).join('\n\n')
  const r = await $.model.complete({ model: 'sonnet', system: EXPLAIN_SYSTEM, prompt, maxTokens: 120, effort: 'low' }).catch(() => undefined)
  const text = r?.isAnswered ? clip(r.text.replace(/^["“「]|["”」]$/g, ''), 60) : failureTail(error).split('\n').filter(Boolean).at(-1) ?? ''
  await update($, explained, x => keepLast({ ...x, [id]: text }))
}
const later = ($: EngineInterface, work: () => Promise<unknown>) => $.clock.after(1, () => work().catch(() => undefined))

const CHANGE_SYSTEM = [
  'AI 编程助手刚改了东西。根据下面“实际执行的改动”（不是它事前的说明），用一行中文告诉看不懂代码的产品人改了什么。',
  '格式：对象在前，冒号，再写从什么改成什么，比如「商品价格：从 99 元改为 199 元」「登录弹窗：重发间隔从 30 秒改为 60 秒」。多处改动用顿号连起来。不超过 30 个字。',
  '不出现文件路径、命令、函数名、变量名。如果实际改动和事前说明明显不一致（多改了、少改了、改了别处），在句末加「（和说明不符：……）」。只输出这一行，不加引号和句号。',
].join('\n')

// 实际改动和事前说明对不上：整行标黄，让人一眼看到。
const MISMATCH = /和说明不符/

const EDIT_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const evidenceOf = (name: string, input: unknown): string => {
  const at = fileName(field(input, 'file_path') ?? field(input, 'notebook_path'))
  if (name === 'Edit') return `改 ${at}：把「${clip(str(field(input, 'old_string')), 300)}」换成「${clip(str(field(input, 'new_string')), 300)}」`
  if (name === 'MultiEdit') {
    const edits = field(input, 'edits')
    return `改 ${at}：${(Array.isArray(edits) ? edits : []).map(one => `把「${clip(str(field(one, 'old_string')), 200)}」换成「${clip(str(field(one, 'new_string')), 200)}」`).join('；')}`
  }
  if (name === 'Write') return `写入 ${at}，新内容开头：${clip(str(field(input, 'content')), 400)}`
  if (name === 'NotebookEdit') return `改笔记本 ${at}：${clip(str(field(input, 'new_source')), 300)}`
  return `命令：${clip(str(field(input, 'command')), 300)}`
}
const addEvidence = (id: string, line: string) => evidence.set(id, [...(evidence.get(id) ?? []), line].slice(-20))

// 脚本里的改动记录可能在脚本结果之后才进会话，而且一条条到：等它们停下来 1.5 秒再写。
const settleThenSummarize = ($: EngineInterface, id: string) => {
  const seen = evidence.get(id)?.length ?? 0
  $.clock.after(1500, () => {
    if ((evidence.get(id)?.length ?? 0) !== seen) return
    summarizeChange($, id).catch(() => undefined)
  })
}

const summarizeChange = async ($: EngineInterface, id: string) => {
  const done_ = evidence.get(id)
  if (!done_?.length || (await read($, changed))[id] !== undefined) return
  const prompt = [
    lastAsk && `用户刚才说：${clip(lastAsk, 300)}`,
    purposeOf.get(id) && `事前说明：${purposeOf.get(id)}`,
    `实际执行的改动：\n${done_.join('\n')}`,
  ].filter(Boolean).join('\n\n')
  const r = await $.model.complete({ model: 'sonnet', system: CHANGE_SYSTEM, prompt, maxTokens: 150, effort: 'low' }).catch(() => undefined)
  if (r?.isAnswered) await update($, changed, x => keepLast({ ...x, [id]: clip(r.text.replace(/^["“「]|["”」。]$/g, ''), 80) }))
}

const PLACEHOLDER = '正在弄清这一步要做什么…'
const replLabel = async ($: EngineInterface, id: string, input: unknown) =>
  LABELS.REPL!(input) || (await read($, guessed))[id] || PLACEHOLDER

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`)

type Row = { tool_use_id: string; tool: string; isRunning: boolean; isErrored: boolean; isInterrupted: boolean; output?: unknown }

// 这一版引擎在结果到手后仍可能给 isRunning: true，有结果就算跑完。
const stillRunning = (row: Row) => row.isRunning && row.output === undefined

const isReceipt = (row: Row) => row.tool === 'REPL' && field(row.output, 'asyncDispatched') === true

// 子代理的 REPL 也从 1 编号，所以带上是哪个循环。
const evalKey = (agentId: string | undefined, evalId: unknown) => `${agentId ?? 'main'}:${String(evalId)}`

// pending：这张收据还在等结果（本次加载里见过它派出、还没收到结果）。
const statusOf = (row: Row, outcome?: Outcome, pending = false) => {
  if (outcome) return outcome.ok ? (outcome.ms >= 2000 ? `✓ ${duration(outcome.ms)}` : '✓') : '✗ 失败'
  if (stillRunning(row) || pending) return '进行中…'
  // 重载、恢复会话之前的收据：结果没记下来，不猜。
  if (isReceipt(row)) return ''
  if (row.tool === 'REPL' && str(field(row.output, 'error'))) return '✗ 失败'
  if (row.isInterrupted) return '已中断'
  if (row.isErrored) return '✗ 失败'
  if (field(row.output, 'timedOutAfterMs') !== undefined) return '超时，转到后台'
  if (field(row.output, 'backgroundTaskId') !== undefined) return '在后台跑'
  const ms = took.get(row.tool_use_id)
  return ms !== undefined && ms >= 2000 ? `✓ ${duration(ms)}` : '✓'
}

// 失败时交给模型的那段文字（报错调用的 output 就是它），只露最后几行。
const failureTail = (output: unknown) => {
  const text = typeof output === 'string' ? output : str(field(output, 'error')) || str(field(output, 'stderr')) || str(field(output, 'stdout'))
  return text.trim().split('\n').slice(-6).map(line => clip(line, 160)).join('\n')
}

// Poll 送来的每个 repl-eval 事件：哪次、跑了多久、成没成、报错末尾。
const EVENT = /<event\b([^>]*)>([\s\S]*?)<\/event>/g
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
const evalsIn = (content: string) =>
  [...content.matchAll(EVENT)]
    .filter(m => attr(m[1]!, 'kind') === 'repl-eval' && attr(m[1]!, 'eval') !== undefined)
    .map(m => {
      const error = /<error>([\s\S]*?)<\/error>/.exec(m[2]!)?.[1]
      const hasResult = /<result>/.test(m[2]!)
      return { id: attr(m[1]!, 'eval')!, ms: Number(attr(m[1]!, 'ms') ?? 0), error, isFinal: error !== undefined || hasResult }
    })
    .filter(one => one.isFinal)

// tool_result 的内容可能是字符串，也可能是若干文字块。
const textOf = (content: unknown) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => str(field(b, 'text'))).join('\n') : ''

const record = async ($: EngineInterface, agentId: string | undefined, content: string) => {
  const got = evalsIn(content)
  if (got.length === 0) return
  const w = await read($, waiting)
  const add: Record<string, Outcome> = {}
  for (const one of got) {
    const use = w[evalKey(agentId, one.id)]
    if (use) add[use] = { ok: one.error === undefined, ms: one.ms, tail: one.error === undefined ? '' : failureTail(one.error) }
    if (use && one.error !== undefined) later($, () => explainFailure($, use, one.error!))
    if (use && one.error === undefined && evidence.has(use)) settleThenSummarize($, use)
  }
  if (Object.keys(add).length > 0) await update($, done, d => keepLast({ ...d, ...add }))
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'steps', description: '切换每一步的显示：一行中文，或完整命令和输出' })
    return next(e)
  })

  // 这一行的文字就是工具调用里的 description；没写，用户就只能看到“运行一段脚本”。
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('REPL') && !e.tools.includes('Bash')) return composed
    return { sections: [...composed.sections, { id: 'plain-steps:describe', scope: 'session' as const, text: DESCRIBE }] }
  })

  on('command.run', { command: 'steps' }, async $ => {
    await update($, plain, v => !v)
    return { text: (await read($, plain)) ? '每一步显示一行中文。' : '每一步显示完整命令和输出。' }
  })

  // 不挂 tool.call：挂了它，新会话会关掉 Code Mode（没有 REPL 工具）。
  // 改为读每一行记录：模型发出调用时记下开始时间，结果进来时算耗时、对上 REPL 的后台结果。
  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    if (e.door === 'prompt') {
      const text = e.message.content.map(b => str(field(b, 'text'))).join(' ').trim()
      if (text) lastAsk = text
    }
    if (e.door === 'response') {
      const now = await $.clock.now()
      for (const block of e.message.content) {
        if (field(block, 'type') === 'text' && str(field(block, 'text')).trim()) lastSaid = str(field(block, 'text'))
        const id = field(block, 'type') === 'tool_use' ? str(field(block, 'id')) : ''
        if (!id) continue
        started.set(id, now)
        const input = field(block, 'input')
        const said = str(field(input, 'description'))
        if (said) purposeOf.set(id, said)
        const name = str(field(block, 'name'))
        const loop = e.agentId ?? 'main'
        if (name === 'REPL' && !isInside(id)) currentScript.set(loop, id)
        if (EDIT_NAMES.has(name) || (name === 'Bash' && SHELL_WRITES.test(shellPartsOf('`' + str(field(input, 'command')) + '`')))) {
          const owner = isInside(id) ? currentScript.get(loop) : id
          if (owner) {
            addEvidence(owner, evidenceOf(name, input))
            if ((await read($, done))[owner]?.ok) settleThenSummarize($, owner)
          }
        }
        if (str(field(block, 'name')) === 'REPL' && !str(field(input, 'description')).trim() && (await read($, plain))) {
          // 不等它：模型回话的这几秒不该拖住会话。
          const code = str(field(input, 'code'))
          $.clock.after(1, () => guessPurpose($, id, code).catch(() => undefined))
        }
      }
    }
    // 后台结果也可能不经 Poll，作为送达消息直接进会话。
    if (e.door === 'delivery' || e.door === 'queue') {
      const text = e.message.content.map(b => str(field(b, 'text'))).join('\n')
      if (text.includes('repl-eval')) await record($, e.agentId, text)
    }
    if (e.door === 'tool-result') {
      const now = await $.clock.now()
      const tool = e.origin.kind === 'tool' ? e.origin.tool : ''
      for (const block of e.message.content) {
        const useId = field(block, 'type') === 'tool_result' ? str(field(block, 'tool_use_id')) : ''
        if (!useId) continue
        const begun = started.get(useId)
        if (begun !== undefined) took.set(useId, now - begun)
        const text = textOf(field(block, 'content'))
        const receipt = tool === 'REPL' ? /^\(dispatched #(\d+)\)$/.exec(text.trim()) : null
        if (receipt) await update($, waiting, w => keepLast({ ...w, [evalKey(e.agentId, receipt[1])]: useId }))
        if (tool === 'Poll') await record($, e.agentId, text)
        else if (field(block, 'is_error') === true && !isInside(useId)) later($, () => explainFailure($, useId, text))
        else if (!isInside(useId) && !receipt && evidence.has(useId)) later($, () => summarizeChange($, useId))
      }
    }
    return kept
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    // Poll 只是把后台结果取回来，结果已经写在对应的那一行上。
    if (e.props.tool === 'Poll' && !e.props.isExpanded && !e.props.isErrored && (await read($, plain))) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    // 脚本里跑的命令（id 以 repl_ 开头）：成败看脚本那一行，这里不另起一行原始命令。
    if (isInside(e.props.tool_use_id) && !e.props.isExpanded && (await read($, plain))) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    const fact = (await read($, changed))[e.props.tool_use_id]
    const label = fact ?? (e.props.tool === 'REPL' ? await replLabel($, e.props.tool_use_id, e.props.input) : LABELS[e.props.tool]?.(e.props.input))
    if (!label || e.props.isExpanded || !(await read($, plain))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const outcome = e.props.tool === 'REPL' ? (await read($, done))[e.props.tool_use_id] : undefined
    const bad = (e.props.isErrored && !e.props.isInterrupted) || outcome?.ok === false || (e.props.tool === 'REPL' && !isReceipt(e.props) && !e.props.isRunning && !!str(field(e.props.output, 'error')))
    const pending = !outcome && isReceipt(e.props) && Object.values(await read($, waiting)).includes(e.props.tool_use_id)
    const running = !outcome && (stillRunning(e.props) || pending)
    return (
      <Box>
        {bad ? <Text color="red">● </Text> : running ? <Text dimColor>● </Text> : <Text color="green">● </Text>}
        <Text color={MISMATCH.test(label) ? 'yellow' : undefined}>{label}</Text>
        {bad ? <Text color="red">{`  ${statusOf(e.props, outcome, pending)}`}</Text> : <Text dimColor>{`  ${statusOf(e.props, outcome, pending)}`}</Text>}
      </Box>
    )
  })

  // Code Mode 下引擎把 REPL、取结果的 Poll、脚本里跑的命令收进一个折叠组，
  // 只画“Listed 1 directory”这类计数，REPL 的说明看不到。这里改成每个 REPL 一行说明。
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    // repl-error-… 是引擎替出错的那次脚本补的一行，和原调用重复，不画。
    const scripts = e.props.calls.filter(c => c.tool === 'REPL' && !(c.tool_use_id ?? '').startsWith('repl-error-'))
    if (e.props.isExpanded || !(await read($, plain))) return next(e)
    // 只剩引擎补的出错记录、取结果的 Poll、脚本里的命令：脚本那一行已经说了，不再画。
    const onlyEcho = e.props.calls.length > 0 && e.props.calls.every(c => (c.tool_use_id ?? '').startsWith('repl-error-') || c.tool === 'Poll' || isInside(c.tool_use_id))
    if (scripts.length === 0 && onlyEcho) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    if (scripts.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [finished, w, g, why, facts] = await Promise.all([read($, done), read($, waiting), read($, guessed), read($, explained), read($, changed)])
    const lines = scripts.map(c => {
      const row = { ...c, tool_use_id: c.tool_use_id ?? '' } as Row
      const outcome = finished[row.tool_use_id]
      const pending = !outcome && isReceipt(row) && Object.values(w).includes(row.tool_use_id)
      const bad = (c.isErrored && !c.isInterrupted) || outcome?.ok === false || (!isReceipt(row) && !c.isRunning && !!str(field(c.output, 'error')))
      const running = !outcome && (stillRunning(row) || pending)
      const tail = bad ? why[row.tool_use_id] ?? PLAIN_FAILURE : ''
      return { key: row.tool_use_id, label: facts[row.tool_use_id] ?? (c.input === undefined ? '' : LABELS.REPL!(c.input) || g[row.tool_use_id] || PLACEHOLDER), status: statusOf(row, outcome, pending), bad, running, tail }
    })
    // 连续几段只查看、没出错的脚本合成一行：显示最新那段的说明和一共查了几步。
    // 改东西的、出错的脚本各占一行，不合并。
    const inner = e.props.calls.filter(c => isInside(c.tool_use_id))
    const lookOnly = scripts.map(c => !facts[c.tool_use_id ?? ''] && isLookOnly(str(field(c.input, 'code')), inner))
    type Line = (typeof lines)[number] & { steps: number }
    const folded: Line[] = []
    lines.forEach((one, i) => {
      const prev = folded.at(-1)
      if (prev && prev.steps > 0 && lookOnly[i] && !one.bad && !prev.bad) {
        folded[folded.length - 1] = { ...one, label: one.label, steps: prev.steps + 1, running: prev.running || one.running }
      } else folded.push({ ...one, steps: lookOnly[i] && !one.bad ? 1 : 0 })
    })
    const shown = folded.map(one =>
      one.steps > 1 ? { ...one, status: one.running ? `进行中… · 已查 ${one.steps} 步` : `✓ · 查了 ${one.steps} 步` } : one,
    )
    return (
      <Box flexDirection="column">
        {shown.map(one => (
          <Box key={one.key}>
            {one.bad ? <Text color="red">● </Text> : one.running ? <Text dimColor>● </Text> : <Text color="green">● </Text>}
            <Text color={MISMATCH.test(one.label) ? 'yellow' : undefined}>{one.label}</Text>
            {one.bad ? <Text color="red">{`  ${one.status}`}</Text> : <Text dimColor>{`  ${one.status}`}</Text>}
          </Box>
        ))}
        {shown.filter(one => one.tail).map(one => (
          <Box key={`t${one.key}`}>
            <Text color="red" dimColor>{`    ${one.tail}`}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const isPoll = (e.props.tool === 'Poll' && !e.props.isErrored) || isInside(e.props.tool_use_id)
    if ((!LABELS[e.props.tool] && !isPoll) || e.props.isExpanded || !(await read($, plain))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (isPoll) return <Box />
    const outcome = e.props.tool === 'REPL' ? (await read($, done))[e.props.tool_use_id] : undefined
    const replError = e.props.tool === 'REPL' && !!str(field(e.props.output, 'error'))
    if (!e.props.isErrored && !outcome?.tail && !replError) return <Box />
    if (e.props.isErrored && NOT_A_FAILURE.test(failureTail(e.props.output))) return <Box />
    const why = (await read($, explained))[e.props.tool_use_id] ?? PLAIN_FAILURE
    return (
      <Box>
        <Text color="red" dimColor>{`  ${why}`}</Text>
      </Box>
    )
  })
}
