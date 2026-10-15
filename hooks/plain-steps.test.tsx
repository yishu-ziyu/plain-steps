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
    expect(await failed.find({ type: 'Text', text: /FAIL k/ })).toBeDefined()
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
