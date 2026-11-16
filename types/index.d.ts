export type Plain = boolean
/** 一次后台 REPL 的结果：成没成、跑了多久、失败时报错的最后几行。 */
export type Outcome = { ok: boolean; ms: number; tail: string }

declare module 'claude-code' {
  interface PluginState {
    'plain-steps': {
      plain: Plain
      /** evalId → 那次 REPL 调用的 tool_use_id */
      waiting: Record<string, string>
      /** tool_use_id → 结果 */
      done: Record<string, Outcome>
      /** tool_use_id → 替没写说明的脚本补的一句“为了什么” */
      guessed: Record<string, string>
      /** tool_use_id → 失败原因的一句人话 */
      explained: Record<string, string>
      /** tool_use_id → 按实际改动写的“从什么改成什么” */
      changed: Record<string, string>
    }
  }
}
