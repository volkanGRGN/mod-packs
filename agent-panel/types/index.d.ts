/** One line of the conversation: what the person asked, what the agent answered, why it could not, or a quiet note such as a stop. */
export type ChatLine = { id: string; who: 'me' | 'agent' | 'error' | 'note'; text: string; at: number }

/** Who answers: a program of one's own by its command, or with no command, the session's own Claude. */
export type Agent = { name: string; argv: string[] }

/** Where the session works: the repository's name where it has one, else the folder's, and the folder itself. */
export type Project = { name: string; path: string }

/**
 * A folder that looks like someone's agent: it has a persona of its own, or
 * the agent-panel.json that tells how to reach it. `name` is the agent's when
 * the file gives one, else the folder's; `ready` when it can be connected.
 */
export type Candidate = { name: string; folder: string; ready: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-panel': {
      chat: Shaped<ChatLine[]>
      busy: boolean
      /** The question being waited on, by an id of its own; empty once answered or stopped. */
      asking: string
      /** The chat is open in the sidebar; closed, only its button shows. */
      isOpen: boolean
      /** An answer came while the chat was closed. */
      hasUnread: boolean
      agent: Shaped<Agent>
      /** The project the session works in: its name as the app shows it, and its folder. */
      project: Shaped<Project>
      /** The sidebar shows the settings instead of the chat. */
      isSettings: boolean
      /** What the last connect or disconnect came to, shown in the settings. */
      notice: string
      /** Folders nearby that look like an agent, to ask about; and the ones the person said were not theirs. */
      candidates: Shaped<Candidate[]>
      dismissed: Shaped<string[]>
    }
  }
}
