/** The estimated tokens of the draft in the prompt box; 0 while empty or short. */
export type Draft = number

declare module 'claude-code' {
  interface PluginState {
    'token-preview': {
      draft: Draft
    }
  }
}
