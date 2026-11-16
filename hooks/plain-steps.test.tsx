import { expect, test } from 'claude-code/testing'

const ROW = { tool_use_id: 't1', tool: 'Bash', input: { command: 'cd "/Users/x/repo" && npx tsx a.mts --headless 2>&1 | tail', description: '跑验收' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'PASS a\nShell cwd was reset', stderr: '', interrupted: false } }

test('a shell step is one Chinese line; a passing result shows nothing, a failure its last lines', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'plain-steps', surface, component: 'ToolUse', props: ROW })
    expect(await row.find({ type: 'Text', text: /跑验收/ })).toBeDefined()
    expect(await row.find({ type: 'Text', text: /npx tsx/ })).toBeUndefined()
    await row.unmount()

    const ok = await $.ui.mount({ plugin: 'plain-steps', surface, component: 'ToolResult', props: { tool_use_id: 't1', tool: 'Bash', output: ROW.output, isErrored: false } })
    expect(await ok.find({ type: 'Text', text: /PASS a|Shell cwd/ })).toBeUndefined()
    await ok.unmount()

    const failed = await $.ui.mount({ plugin: 'plain-steps', surface, component: 'ToolResult', props: { tool_use_id: 't2', tool: 'Bash', output: 'line1\nline2\nline3\nline4\nline5\nline6\nFAIL k 点「整理」', isErrored: true } })
    expect(await failed.find({ type: 'Text', text: /FAIL k/ })).toBeUndefined()
    expect(await failed.find({ type: 'Text', text: /正在弄清哪里出了问题/ })).toBeDefined()
    expect(await failed.find({ type: 'Text', text: /line1/ })).toBeUndefined()
    await failed.unmount()
  }
})

test('/steps switches back to the engine row with the full command', async ($, on) => {
  // 代替引擎自己画的那一行。
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`Bash(${String((e.props.input as { command: string }).command)})`}</Text>
  })
  await $.command.run({ command: 'steps', args: '' })
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: ROW })
  expect(await row.find({ type: 'Text', text: /跑验收/ })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /npx tsx/ })).toBeDefined()
  await row.unmount()
})



const on_ = { kind: 'model', model: 'm' } as const
const useRow = (id: string) => ({ door: 'response', origin: on_, uuid: 'u-' + id, message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] } })
const resultRow = (id: string, tool: string, text: string, agentId?: string) => ({ door: 'tool-result', origin: { kind: 'tool', tool }, uuid: 'r-' + id, ...(agentId ? { agentId } : {}), message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

const REPL_ROW = (id: string, output: unknown) => ({ tool_use_id: id, tool: 'REPL', input: { code: 'await $`npm test`', description: '跑一遍测试' }, isRunning: false, isErrored: false, isInterrupted: false, output })
const POLL = (body: string) => `<system>nonces</system>\n${body}`

test('a background REPL shows its description, then the result Poll brings back', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '脚本里用到的一个值还没准备好就被拿来用了', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const POLL_TEXT = POLL('<event nonce="n" kind="repl-eval" at="t" eval="1" ms="3400" status="settled">\n<result>ok</result>\n</event><event nonce="n" kind="repl-eval" at="t" eval="2" ms="10" status="settled">\n<error>a\nb\nc\nd\ne\nf\nTypeError: x is undefined</error>\n</event>')
  const receipt = { code: '', result: '(dispatched #1)', stdout: '', stderr: '', evalId: 1, asyncDispatched: true }

  await $.session.append(resultRow('r1', 'REPL', '(dispatched #1)') as never)
  const waitingRow = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('r1', receipt) })
  expect(await waitingRow.find({ type: 'Text', text: /跑一遍测试/ })).toBeDefined()
  expect(await waitingRow.find({ type: 'Text', text: /进行中/ })).toBeDefined()
  expect(await waitingRow.find({ type: 'Text', text: /npm test/ })).toBeUndefined()
  await waitingRow.unmount()

  await $.session.append(resultRow('r2', 'REPL', '(dispatched #2)') as never)
  await $.session.append(resultRow('p1', 'Poll', POLL_TEXT) as never)

  const ok = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('r1', receipt) })
  expect(await ok.find({ type: 'Text', text: /✓ 3 秒/ })).toBeDefined()
  await ok.unmount()

  const bad = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('r2', { ...receipt, evalId: 2 }) })
  expect(await bad.find({ type: 'Text', text: /✗ 失败/ })).toBeDefined()
  await bad.unmount()
  const tail = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'r2', tool: 'REPL', output: { ...receipt, evalId: 2 }, isErrored: false } })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(await tail.find({ type: 'Text', text: /TypeError/ })).toBeUndefined()
  expect(await tail.find({ type: 'Text', text: /^a\n/ })).toBeUndefined()
  await tail.unmount()
  const told = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'r2', tool: 'REPL', output: { ...receipt, evalId: 2 }, isErrored: false } })
  expect(await told.find({ type: 'Text', text: /还没准备好就被拿来用了/ })).toBeDefined()
  await told.unmount()

  const poll = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'p1', tool: 'Poll', output: { content: POLL('<event>…</event>') }, isErrored: false } })
  expect(await poll.find({ type: 'Text', text: /event/ })).toBeUndefined()
  await poll.unmount()
})

test('a step that took a while says how long', async ($, on) => {
  let now = 0
  on('clock.now', () => ({ value: (now += 19_000) }))
  await $.session.append(useRow('b1') as never)
  await $.session.append(resultRow('b1', 'Bash', 'done') as never)
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: { ...ROW, tool_use_id: 'b1' } })
  expect(await row.find({ type: 'Text', text: /✓ 19 秒/ })).toBeDefined()
  await row.unmount()
})

test('an old receipt with nothing recorded says nothing, never 进行中', async ($, on) => {
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('old', { code: '', result: '(dispatched #9)', stdout: '', stderr: '', evalId: 9, asyncDispatched: true }) })
  expect(await row.find({ type: 'Text', text: /跑一遍测试/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /进行中/ })).toBeUndefined()
  await row.unmount()
})

test('a REPL without a description never shows its code', async $ => {
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: { ...REPL_ROW('x', undefined), input: { code: 'await $`rm -rf build`' }, isRunning: true } })
  expect(await row.find({ type: 'Text', text: /正在弄清这一步要做什么/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /rm -rf/ })).toBeUndefined()
  await row.unmount()
})

test('a subagent numbering its scripts from 1 does not mark the main loop rows', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  await $.session.append(resultRow('main1', 'REPL', '(dispatched #1)') as never)
  await $.session.append(resultRow('sub1', 'REPL', '(dispatched #1)', 'a1') as never)
  await $.session.append(resultRow('p', 'Poll', POLL('<event nonce="n" kind="repl-eval" at="t" eval="1" ms="5" status="settled">\n<error>boom</error>\n</event>'), 'a1') as never)
  const receipt = { code: '', result: '(dispatched #1)', stdout: '', stderr: '', evalId: 1, asyncDispatched: true }
  const main = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('main1', receipt) })
  expect(await main.find({ type: 'Text', text: /进行中/ })).toBeDefined()
  await main.unmount()
  const sub = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('sub1', receipt) })
  expect(await sub.find({ type: 'Text', text: /✗ 失败/ })).toBeDefined()
  await sub.unmount()
})

test('ctrl+o shows the full output, Poll included', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const poll = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'p1', tool: 'Poll', output: { content: 'x' }, isErrored: false, isExpanded: true } })
  expect(await poll.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await poll.unmount()
})

test('the system prompt asks for a plain description on each step', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const out = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['REPL'], outputStyle: null, traits: [] } as never)
  expect(out.sections.some((s: { id: string }) => s.id === 'plain-steps:describe')).toBe(true)
})

test('a Code Mode group draws each script by its description, not the commands inside it', async ($, on) => {
  const group = {
    isActive: false, isExpanded: false, isCallsOnly: false,
    calls: [
      { tool_use_id: 'g1', tool: 'REPL', input: { code: 'await $`git log -1`', description: '看仓库状态' }, isRunning: false, isErrored: false, isInterrupted: false, output: { code: '', result: 'x', stdout: '', stderr: '' } },
      { tool_use_id: 'repl_1', tool: 'Bash', input: { command: 'git log -1' }, isRunning: false, isErrored: true, isInterrupted: false, output: 'fatal' },
      { tool_use_id: 'p', tool: 'Poll', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: { content: '' } },
    ],
  }
  const ui = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolGroup', props: group })
  expect(await ui.find({ type: 'Text', text: /看仓库状态/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /git log/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /await/ })).toBeUndefined()
  await ui.unmount()
})

test('a result delivered straight into the session, not through Poll, still lands', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  await $.session.append(resultRow('d1', 'REPL', '(dispatched #4)') as never)
  await $.session.append({ door: 'delivery', origin: { kind: 'engine' }, uuid: 'dv', message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: '<event nonce="n" kind="repl-eval" at="t" eval="4" ms="2500" status="settled">\n<result>ok</result>\n</event>' }] } } as never)
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('d1', { code: '', result: '(dispatched #4)', stdout: '', stderr: '', evalId: 4, asyncDispatched: true }) })
  expect(await row.find({ type: 'Text', text: /✓ 3 秒/ })).toBeDefined()
  await row.unmount()
})

test('a script without a description gets a purpose line from the model', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '确认新会话里还能用 REPL。', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: 'q', message: { type: 'user', role: 'user', content: [{ type: 'text', text: '看看 Code Mode 还开着吗' }] } } as never)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'a', message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'nd', name: 'REPL', input: { code: 'await $`tmux new-session`' } }] } } as never)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: { ...REPL_ROW('nd', undefined), input: { code: 'await $`tmux new-session`' }, isRunning: true } })
  expect(await row.find({ type: 'Text', text: /确认新会话里还能用 REPL/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /tmux/ })).toBeUndefined()
  await row.unmount()
})

test('a command run inside a script draws no row of its own', async $ => {
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: { ...ROW, tool_use_id: 'repl_abc', input: { command: 'git rev-parse --verify HEAD' }, isErrored: true, output: 'fatal' } })
  expect(await row.find({ type: 'Text', text: /git rev-parse|失败/ })).toBeUndefined()
  await row.unmount()
})

test('a finished step whose row still says isRunning shows its result', async $ => {
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: { ...ROW, isRunning: true } })
  expect(await row.find({ type: 'Text', text: /进行中/ })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: /✓/ })).toBeDefined()
  await row.unmount()
})

const SCRIPT = (id: string, description: string, code: string) => ({ tool_use_id: id, tool: 'REPL', input: { code, description }, isRunning: false, isErrored: false, isInterrupted: false, output: { code: '', result: 'x', stdout: '', stderr: '' } })

test('consecutive look-only scripts fold into one line; a change keeps its own line', async $ => {
  const group = {
    isActive: false, isExpanded: false, isCallsOnly: true,
    calls: [
      SCRIPT('s1', '结算页优惠券：查叠加规则', 'const a = await $`rg coupon src 2>/dev/null`.text(); a.split("\\n").filter(x => x > "")'),
      SCRIPT('s2', '结算页优惠券：查门槛规则', 'await file("src/checkout.ts").text()'),
      SCRIPT('s3', '优惠券门槛：从 99 元改为 199 元', 'await edit("src/checkout.ts", "99", "199")'),
      SCRIPT('s4', '结算页：确认改动生效', 'await $`npm test`'),
    ],
  }
  const ui = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolGroup', props: group })
  expect(await ui.find({ type: 'Text', text: /查叠加规则/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /查门槛规则/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /查了 2 步/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /从 99 元改为 199 元/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /确认改动生效/ })).toBeDefined()
  await ui.unmount()
})

test('a script that writes, installs or redirects into a file is never folded', async $ => {
  const group = {
    isActive: false, isExpanded: false, isCallsOnly: true,
    calls: [
      SCRIPT('w1', '甲：查', 'await $`ls`'),
      SCRIPT('w2', '乙：写日志', 'await $`echo hi > out.txt`'),
      SCRIPT('w3', '丙：查', 'await $`ls`'),
      SCRIPT('w4', '丁：装依赖', 'await $`npm install left-pad`'),
    ],
  }
  const ui = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolGroup', props: group })
  for (const word of [/甲：查/, /乙：写日志/, /丙：查/, /丁：装依赖/]) expect(await ui.find({ type: 'Text', text: word })).toBeDefined()
  await ui.unmount()
})

test('the step-description prompt asks for the thing first and bans filler openers', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['REPL'], outputStyle: null, traits: [] } as never)
  const text = out.sections.find((s: { id: string }) => s.id === 'plain-steps:describe')?.text ?? ''
  expect(text).toContain('结算页优惠券：查叠加与门槛规则')
  expect(text).toContain('为了')
})

test('a failed command is told in plain words, an Esc is not a failure', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '订单导出：空订单列表没有兜底，测试没通过', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const errRow = (id: string, text: string) => ({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'e-' + id, message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] } })
  await $.session.append(errRow('x1', 'npm ERR! Test failed. See above for more details.') as never)
  await $.session.append(errRow('x2', "The user doesn't want to proceed with this tool use.") as never)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  const bad = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'x1', tool: 'Bash', output: 'npm ERR! Test failed.', isErrored: true } })
  expect(await bad.find({ type: 'Text', text: /空订单列表没有兜底/ })).toBeDefined()
  expect(await bad.find({ type: 'Text', text: /npm ERR/ })).toBeUndefined()
  await bad.unmount()
  const esc = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'x2', tool: 'Bash', output: "The user doesn't want to proceed with this tool use.", isErrored: true } })
  expect(await esc.find({ type: 'Text', text: /出了问题|兜底/ })).toBeUndefined()
  await esc.unmount()
})

test('a group holding only the engine echo of a failed script draws nothing', async $ => {
  const group = { isActive: false, isExpanded: false, isCallsOnly: false, calls: [{ tool_use_id: 'repl-error-1', tool: 'REPL', input: {}, isRunning: false, isErrored: true, isInterrupted: false, output: { error: 'ShellError: Command failed with exit code 1:' } }] }
  const ui = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolGroup', props: group })
  expect(await ui.find({ type: 'Text', text: /ShellError/ })).toBeUndefined()
  await ui.unmount()
})

test('a script that changed something is described by what it actually did', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => ({ value: undefined }))
  let asked = ''
  on('model.complete', (_: unknown, e: { prompt: unknown }) => {
    asked = String(e.prompt)
    return { value: { isAnswered: true, text: '商品价格：从 99 改为 199、限额从 5 改为 8', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  const use = (id: string, name: string, input: unknown, model = 'm') => ({ door: 'response', origin: { kind: 'model', model }, uuid: 'u' + id, message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  await $.session.append(use('c1', 'REPL', { code: 'await edit("shop.txt","99","199")', description: '商品清单：改价格' }) as never)
  await $.session.append(use('repl_1', 'Edit', { file_path: '/x/shop.txt', old_string: '99', new_string: '199' }, '<synthetic>') as never)
  await $.session.append(use('repl_2', 'Bash', { command: 'sed -i "" "s/limit = 5/limit = 8/" shop.txt' }, '<synthetic>') as never)
  await $.session.append(use('repl_3', 'Bash', { command: 'cat shop.txt' }, '<synthetic>') as never)
  await $.session.append(resultRow('c1', 'REPL', '(dispatched #7)') as never)
  await $.session.append(resultRow('pp', 'Poll', POLL('<event nonce="n" kind="repl-eval" at="t" eval="7" ms="40" status="settled">\n<result>ok</result>\n</event>')) as never)
  for (let i = 0; i < 80; i++) await Promise.resolve()
  expect(asked).toContain('把「99」换成「199」')
  expect(asked).toContain('sed -i')
  expect(asked).not.toContain('cat shop.txt')
  expect(asked).toContain('事前说明：商品清单：改价格')
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('c1', { code: '', result: '(dispatched #7)', stdout: '', stderr: '', evalId: 7, asyncDispatched: true }) })
  expect(await row.find({ type: 'Text', text: /从 99 改为 199/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /跑一遍测试/ })).toBeUndefined()
  await row.unmount()
})

test('change records that arrive after the script finished still produce the line', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.after', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '商品价格：从 99 改为 199', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const use = (id: string, name: string, input: unknown, model = 'm') => ({ door: 'response', origin: { kind: 'model', model }, uuid: 'u' + id, message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  await $.session.append(use('c9', 'REPL', { code: 'await edit("shop.txt","99","199")', description: '商品清单：改价格' }) as never)
  await $.session.append(resultRow('c9', 'REPL', '(dispatched #9)') as never)
  await $.session.append(resultRow('p9', 'Poll', POLL('<event nonce="n" kind="repl-eval" at="t" eval="9" ms="40" status="settled">\n<result>ok</result>\n</event>')) as never)
  await $.session.append(use('repl_9', 'Edit', { file_path: '/x/shop.txt', old_string: '99', new_string: '199' }, '<synthetic>') as never)
  for (let i = 0; i < 80; i++) await Promise.resolve()
  const row = await $.ui.mount({ plugin: 'plain-steps', surface: 'terminal', component: 'ToolUse', props: REPL_ROW('c9', { code: '', result: '(dispatched #9)', stdout: '', stderr: '', evalId: 9, asyncDispatched: true }) })
  expect(await row.find({ type: 'Text', text: /从 99 改为 199/ })).toBeDefined()
  await row.unmount()
})
