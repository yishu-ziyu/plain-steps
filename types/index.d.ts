export type Plain = boolean

declare module 'claude-code' {
  interface PluginState {
    'plain-steps': { plain: Plain }
  }
}
