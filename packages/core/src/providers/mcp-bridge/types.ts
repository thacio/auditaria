/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BridgeableToolSchema {
  name: string;
  description: string;
  inputSchema: unknown; // JSON Schema object from DeclarativeTool.schema.parametersJsonSchema
}

export interface ToolExecuteRequest {
  tool: string;
  params: Record<string, unknown>;
}

export interface ToolExecuteResponse {
  content: string;
  isError: boolean;
  returnDisplay?: string; // AUDITARIA: Rich display data from tool execution (e.g., browser step JSON)
}
