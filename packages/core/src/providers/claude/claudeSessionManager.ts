// AUDITARIA_CLAUDE_PROVIDER: Simple session ID tracker for Claude conversations

export class ClaudeSessionManager {
  private sessionId: string | undefined;

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  clearSession(): void {
    this.sessionId = undefined;
  }
}
