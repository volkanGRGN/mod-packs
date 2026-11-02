/** Mesaj kutusundaki taslağın tahmini token'ı; boşken ya da kısayken 0. */
export type Taslak = number

declare module 'claude-code' {
  interface PluginState {
    'token-onizleme': {
      taslak: Taslak
    }
  }
}
