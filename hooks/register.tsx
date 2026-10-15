import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// true：每一步一行中文；false：引擎原样画（完整命令和输出）。/steps 切换。
const plain = atom({ plugin: 'plain-steps', key: 'plain' } as const, true)

// 每次调用花了多久（模块自己的变量，重载后从头记）。
const took = new Map<string, number>()

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
  Skill: i => `用技能 ${clip(str(field(i, 'skill')), 40)}`,
}

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`)

type Row = { tool_use_id: string; isRunning: boolean; isErrored: boolean; isInterrupted: boolean; output?: unknown }

const statusOf = (row: Row) => {
  if (row.isRunning) return '进行中…'
  if (row.isInterrupted) return '已中断'
  if (row.isErrored) return '✗ 失败'
  if (field(row.output, 'timedOutAfterMs') !== undefined) return '超时，转到后台'
  if (field(row.output, 'backgroundTaskId') !== undefined) return '在后台跑'
  const ms = took.get(row.tool_use_id)
  return ms !== undefined && ms >= 2000 ? `✓ ${duration(ms)}` : '✓'
}

// 失败时交给模型的那段文字（报错调用的 output 就是它），只露最后几行。
const failureTail = (output: unknown) => {
  const text = typeof output === 'string' ? output : str(field(output, 'stderr')) || str(field(output, 'stdout'))
  return text.trim().split('\n').slice(-6).map(line => clip(line, 160)).join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'steps', description: '切换每一步的显示：一行中文，或完整命令和输出' })
    return next(e)
  })

  on('command.run', { command: 'steps' }, async $ => {
    await update($, plain, v => !v)
    return { text: (await read($, plain)) ? '每一步显示一行中文。' : '每一步显示完整命令和输出。' }
  })

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()
    const ran = await next(e)
    took.set(e.tool_use_id, (await $.clock.now()) - started)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const label = LABELS[e.props.tool]?.(e.props.input)
    if (!label || !(await read($, plain))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const bad = e.props.isErrored && !e.props.isInterrupted
    return (
      <Box>
        {bad ? <Text color="red">● </Text> : e.props.isRunning ? <Text dimColor>● </Text> : <Text color="green">● </Text>}
        <Text>{label}</Text>
        {bad ? <Text color="red">{`  ${statusOf(e.props)}`}</Text> : <Text dimColor>{`  ${statusOf(e.props)}`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!LABELS[e.props.tool] || !(await read($, plain))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (!e.props.isErrored) return <Box />
    const tail = failureTail(e.props.output)
    return tail ? (
      <Box>
        <Text color="red" dimColor>{tail}</Text>
      </Box>
    ) : (
      <Box />
    )
  })
}
