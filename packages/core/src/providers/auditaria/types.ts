// AUDITARIA_AGENT_SESSION: Config types for the Auditaria CLI sub-agent driver

export interface AuditariaCLIDriverConfig {
  /** Gemini model name (e.g., 'gemini-2.5-pro'). If omitted, uses auditaria's default. */
  model?: string;
  /** Working directory for the spawned process. */
  cwd: string;
  /** Approval mode: 'yolo' for work (all tools), 'default' for consult (blocks destructive tools). */
  approvalMode: 'yolo' | 'default';
}
