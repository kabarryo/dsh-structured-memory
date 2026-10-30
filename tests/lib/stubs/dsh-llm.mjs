/** Test stubs for the two @deepseek-ai/dsh-llm exports the plugin imports. */
export const createUserMessage = (value) => value

export class BlockAssembler {
  constructor() {
    this.usage = null
    this.finish = null
  }

  blocks() {
    return []
  }
}

/** Enough of the real error base for consumers (the real dsh-tools imports it). */
export class HarnessError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
  }
}
