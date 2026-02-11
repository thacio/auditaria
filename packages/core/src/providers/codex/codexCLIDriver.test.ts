import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodexCLIDriver } from './codexCLIDriver.js';
import { ProviderEventType } from '../types.js';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { Readable } from 'stream';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock killProcessGroup so tests don't call taskkill/process.kill
vi.mock('../../utils/process-utils.js', () => ({
  killProcessGroup: vi.fn(),
}));

// Mock fs for instructions file and MCP config writes
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

// Mock os.homedir for config path
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => '/mock-home'),
  };
});

import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
const mockSpawn = vi.mocked(spawn);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const expectedShellOption = process.platform === 'win32' ? 'powershell.exe' : true;

function createMockProcess(stdoutLines: string[]): ChildProcess {
  const stdout = new Readable({
    read() {
      for (const line of stdoutLines) {
        this.push(line + '\n');
      }
      this.push(null);
    },
  });

  const stderr = new Readable({ read() { this.push(null); } });
  const proc = new EventEmitter() as ChildProcess;
  (proc as unknown as { stdout: Readable }).stdout = stdout;
  (proc as unknown as { stderr: Readable }).stderr = stderr;
  (proc as unknown as Record<string, unknown>).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as unknown as { pid: number }).pid = 12345;
  (proc as unknown as { exitCode: number | null }).exitCode = 0;
  proc.kill = vi.fn();

  // Emit exit after a tick
  setTimeout(() => proc.emit('exit', 0), 10);

  return proc;
}

describe('CodexCLIDriver', () => {
  const driverConfig = {
    model: 'gpt-5.3-codex',
    cwd: '/tmp/test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should capture thread_id from thread.started event', async () => {
    const threadMsg = JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-abc-123',
    });
    const turnMsg = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    mockSpawn.mockReturnValue(createMockProcess([threadMsg, turnMsg]));

    const driver = new CodexCLIDriver(driverConfig);
    const controller = new AbortController();

    for await (const _ of driver.sendMessage('hello', controller.signal)) {
      // consume
    }

    expect(driver.getSessionId()).toBe('thread-abc-123');
  });

  it('should emit Content from agent_message item.updated with text deltas', async () => {
    const update1 = JSON.stringify({
      type: 'item.updated',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
    });
    const update2 = JSON.stringify({
      type: 'item.updated',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello world' },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Hello world!' },
    });

    mockSpawn.mockReturnValue(createMockProcess([update1, update2, completed]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('greet', controller.signal)) {
      events.push(event);
    }

    const contentEvents = events.filter(e => e.type === ProviderEventType.Content);
    expect(contentEvents).toHaveLength(3);
    expect((contentEvents[0] as { text: string }).text).toBe('Hello');
    expect((contentEvents[1] as { text: string }).text).toBe(' world');
    expect((contentEvents[2] as { text: string }).text).toBe('!');
  });

  it('should emit Thinking from reasoning item events', async () => {
    const update = JSON.stringify({
      type: 'item.updated',
      item: { id: 'reason-1', type: 'reasoning', text: 'Let me think...' },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: { id: 'reason-1', type: 'reasoning', text: 'Let me think... about this.' },
    });

    mockSpawn.mockReturnValue(createMockProcess([update, completed]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('reason', controller.signal)) {
      events.push(event);
    }

    const thinkingEvents = events.filter(e => e.type === ProviderEventType.Thinking);
    expect(thinkingEvents).toHaveLength(2);
    expect((thinkingEvents[0] as { text: string }).text).toBe('Let me think...');
    expect((thinkingEvents[1] as { text: string }).text).toBe(' about this.');
  });

  it('should emit ToolUse and ToolResult from command_execution items', async () => {
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'ls -la', status: 'running' },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'ls -la',
        status: 'completed',
        aggregated_output: 'file1.txt\nfile2.txt',
        exit_code: 0,
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([started, completed]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('list files', controller.signal)) {
      events.push(event);
    }

    const toolUse = events.find(e => e.type === ProviderEventType.ToolUse);
    expect(toolUse).toBeDefined();
    expect((toolUse as { toolName: string }).toolName).toBe('command_execution');
    expect((toolUse as { toolId: string }).toolId).toBe('codex-cmd-1');
    expect((toolUse as { input: Record<string, unknown> }).input).toEqual({ command: 'ls -la' });

    const toolResult = events.find(e => e.type === ProviderEventType.ToolResult);
    expect(toolResult).toBeDefined();
    expect((toolResult as { toolId: string }).toolId).toBe('codex-cmd-1');
    expect((toolResult as { output: string }).output).toContain('file1.txt');
    expect((toolResult as { isError?: boolean }).isError).toBe(false);
  });

  it('should mark tool result as error when exit code is non-zero', async () => {
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'cmd-2', type: 'command_execution', command: 'false', status: 'running' },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'cmd-2',
        type: 'command_execution',
        command: 'false',
        status: 'completed',
        aggregated_output: '',
        exit_code: 1,
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([started, completed]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('fail', controller.signal)) {
      events.push(event);
    }

    const toolResult = events.find(e => e.type === ProviderEventType.ToolResult);
    expect(toolResult).toBeDefined();
    expect((toolResult as { isError?: boolean }).isError).toBe(true);
  });

  it('should emit ToolUse and ToolResult from mcp_tool_call items', async () => {
    const started = JSON.stringify({
      type: 'item.started',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'auditaria-tools',
        tool: 'knowledge_search',
        status: 'running',
        arguments: { query: 'test' },
      },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'auditaria-tools',
        tool: 'knowledge_search',
        status: 'completed',
        arguments: { query: 'test' },
        result: 'Found 3 results.',
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([started, completed]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('search', controller.signal)) {
      events.push(event);
    }

    const toolUse = events.find(e => e.type === ProviderEventType.ToolUse);
    expect(toolUse).toBeDefined();
    expect((toolUse as { toolName: string }).toolName).toBe('mcp__auditaria-tools__knowledge_search');
    expect((toolUse as { toolId: string }).toolId).toBe('codex-mcp-1');

    const toolResult = events.find(e => e.type === ProviderEventType.ToolResult);
    expect(toolResult).toBeDefined();
    expect((toolResult as { output: string }).output).toBe('Found 3 results.');
    expect((toolResult as { isError?: boolean }).isError).toBe(false);
  });

  it('should emit ToolUse and ToolResult from file_change items', async () => {
    const started = JSON.stringify({
      type: 'item.started',
      item: {
        id: 'fc-1',
        type: 'file_change',
        changes: [{ path: 'src/index.ts', action: 'modify' }],
        status: 'pending',
      },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'fc-1',
        type: 'file_change',
        changes: [{ path: 'src/index.ts', action: 'modify' }],
        status: 'applied',
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([started, completed]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('edit file', controller.signal)) {
      events.push(event);
    }

    const toolUse = events.find(e => e.type === ProviderEventType.ToolUse);
    expect(toolUse).toBeDefined();
    expect((toolUse as { toolName: string }).toolName).toBe('file_change');
    expect((toolUse as { input: Record<string, unknown> }).input).toHaveProperty('paths');

    const toolResult = events.find(e => e.type === ProviderEventType.ToolResult);
    expect(toolResult).toBeDefined();
    expect((toolResult as { output: string }).output).toContain('applied');
  });

  it('should emit Compacted from contextCompaction item', async () => {
    const compaction = JSON.stringify({
      type: 'item.completed',
      item: { id: 'compact-1', type: 'contextCompaction' },
    });

    mockSpawn.mockReturnValue(createMockProcess([compaction]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('test', controller.signal)) {
      events.push(event);
    }

    const compacted = events.find(e => e.type === ProviderEventType.Compacted);
    expect(compacted).toBeDefined();
    expect((compacted as { trigger: string }).trigger).toBe('auto');
  });

  it('should emit CompactionSummary when agent_message follows contextCompaction', async () => {
    const compaction = JSON.stringify({
      type: 'item.completed',
      item: { id: 'compact-1', type: 'contextCompaction' },
    });
    const summary = JSON.stringify({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'Summary of the conversation so far.' },
    });

    mockSpawn.mockReturnValue(createMockProcess([compaction, summary]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('test', controller.signal)) {
      events.push(event);
    }

    const compSummary = events.find(e => e.type === ProviderEventType.CompactionSummary);
    expect(compSummary).toBeDefined();
    expect((compSummary as { summary: string }).summary).toBe('Summary of the conversation so far.');
  });

  it('should emit Finished with usage from turn.completed', async () => {
    const turnMsg = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
    });

    mockSpawn.mockReturnValue(createMockProcess([turnMsg]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('hi', controller.signal)) {
      events.push(event);
    }

    const finished = events.find(
      e => e.type === ProviderEventType.Finished && (e as { usage?: unknown }).usage,
    );
    expect(finished).toBeDefined();
    const usage = (finished as { usage: { inputTokens: number; outputTokens: number } }).usage;
    expect(usage.inputTokens).toBe(500);
    expect(usage.outputTokens).toBe(200);
  });

  it('should emit Error from turn.failed event', async () => {
    const failMsg = JSON.stringify({
      type: 'turn.failed',
      error: 'Rate limit exceeded',
    });

    mockSpawn.mockReturnValue(createMockProcess([failMsg]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('test', controller.signal)) {
      events.push(event);
    }

    const error = events.find(e => e.type === ProviderEventType.Error);
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toBe('Rate limit exceeded');
  });

  it('should emit Error from error item', async () => {
    const errorItem = JSON.stringify({
      type: 'item.completed',
      item: { id: 'err-1', type: 'error', message: 'Something went wrong' },
    });

    mockSpawn.mockReturnValue(createMockProcess([errorItem]));

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('test', controller.signal)) {
      events.push(event);
    }

    const error = events.find(e => e.type === ProviderEventType.Error);
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toBe('Something went wrong');
  });

  it('should skip non-JSON lines gracefully', async () => {
    const update = JSON.stringify({
      type: 'item.updated',
      item: { id: 'msg-1', type: 'agent_message', text: 'ok' },
    });

    mockSpawn.mockReturnValue(
      createMockProcess(['not json', '', update, 'also not json']),
    );

    const driver = new CodexCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('test', controller.signal)) {
      events.push(event);
    }

    const content = events.find(e => e.type === ProviderEventType.Content);
    expect(content).toBeDefined();
    expect((content as { text: string }).text).toBe('ok');
  });

  it('should pass correct args to spawn and pipe prompt via stdin', async () => {
    const mockProc = createMockProcess([]);
    mockSpawn.mockReturnValue(mockProc);

    const driver = new CodexCLIDriver(driverConfig);
    const controller = new AbortController();

    for await (const _ of driver.sendMessage('hello', controller.signal)) {
      // consume
    }

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['exec', '--json', '-m', 'gpt-5.3-codex', '-s', 'danger-full-access', '--skip-git-repo-check'],
      expect.objectContaining({
        cwd: '/tmp/test',
        shell: expectedShellOption,
      }),
    );

    expect(mockProc.stdin!.write).toHaveBeenCalledWith('hello');
    expect(mockProc.stdin!.end).toHaveBeenCalled();
  });

  it('should pass model_reasoning_effort override when configured', async () => {
    const mockProc = createMockProcess([]);
    mockSpawn.mockReturnValue(mockProc);

    const driver = new CodexCLIDriver({
      ...driverConfig,
      reasoningEffort: 'xhigh',
    });
    const controller = new AbortController();

    for await (const _ of driver.sendMessage('hello', controller.signal)) {
      // consume
    }

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['-c', 'model_reasoning_effort=xhigh']),
      expect.objectContaining({
        cwd: '/tmp/test',
        shell: expectedShellOption,
      }),
    );
  });

  it('should use resume args when thread_id is captured', async () => {
    const threadMsg = JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-xyz',
    });

    const mockProc1 = createMockProcess([threadMsg]);
    const mockProc2 = createMockProcess([]);
    mockSpawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

    const driver = new CodexCLIDriver(driverConfig);
    const controller = new AbortController();

    // First call captures thread_id
    for await (const _ of driver.sendMessage('first', controller.signal)) {
      // consume
    }

    expect(driver.getSessionId()).toBe('thread-xyz');

    // Second call should use resume
    for await (const _ of driver.sendMessage('second', controller.signal)) {
      // consume
    }

    expect(mockSpawn).toHaveBeenLastCalledWith(
      'codex',
      ['exec', '--json', '-m', 'gpt-5.3-codex', '-s', 'danger-full-access', 'resume', '--skip-git-repo-check', 'thread-xyz'],
      expect.objectContaining({ cwd: '/tmp/test' }),
    );
  });

  it('should write system context to instructions file and pass -c flag', async () => {
    const mockProc = createMockProcess([]);
    mockSpawn.mockReturnValue(mockProc);

    const driver = new CodexCLIDriver(driverConfig);
    const controller = new AbortController();

    for await (const _ of driver.sendMessage('hello', controller.signal, 'audit context')) {
      // consume
    }

    // Instructions written to .auditaria/.codex-instructions
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.codex-instructions'),
      'audit context',
      'utf-8',
    );

    // -c flag should be in the args
    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['-c', expect.stringContaining('model_instructions_file=')]),
      expect.objectContaining({ shell: expectedShellOption }),
    );
  });

  it('should inject MCP config into ~/.codex/config.toml when toolBridge is configured', async () => {
    const existingConfig = '[features]\nelevated_windows_sandbox = true\n';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(existingConfig);

    const mockProc = createMockProcess([]);
    mockSpawn.mockReturnValue(mockProc);

    const driverWithMcp = new CodexCLIDriver({
      ...driverConfig,
      toolBridgePort: 19751,
      toolBridgeScript: '/path/to/mcp-bridge.js',
    });
    const controller = new AbortController();

    for await (const _ of driverWithMcp.sendMessage('hello', controller.signal)) {
      // consume
    }

    // Should have written config.toml with MCP block
    const configWrites = mockWriteFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('config.toml'),
    );
    expect(configWrites.length).toBeGreaterThan(0);
    const writtenContent = configWrites[0][1] as string;
    expect(writtenContent).toContain('AUDITARIA_MCP_START');
    expect(writtenContent).toContain('[mcp_servers.auditaria-tools]');
    expect(writtenContent).toContain('mcp-bridge.js');
    expect(writtenContent).toContain('AUDITARIA_MCP_END');
    // Original content preserved
    expect(writtenContent).toContain('elevated_windows_sandbox');
  });

  it('should remove MCP config from ~/.codex/config.toml on dispose', async () => {
    const configWithMcp = '[features]\ntest = true\n\n# AUDITARIA_MCP_START\n[mcp_servers.auditaria-tools]\ncommand = "node"\n# AUDITARIA_MCP_END\n';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(configWithMcp);

    const mockProc = createMockProcess([]);
    mockSpawn.mockReturnValue(mockProc);

    const driverWithMcp = new CodexCLIDriver({
      ...driverConfig,
      toolBridgePort: 19751,
      toolBridgeScript: '/path/to/mcp-bridge.js',
    });
    const controller = new AbortController();

    for await (const _ of driverWithMcp.sendMessage('hello', controller.signal)) {
      // consume
    }

    // Reset mocks to track dispose writes
    mockWriteFileSync.mockClear();
    mockReadFileSync.mockReturnValue(configWithMcp);
    driverWithMcp.dispose();

    // Should have written cleaned config (without AUDITARIA block)
    const configWrites = mockWriteFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('config.toml'),
    );
    expect(configWrites.length).toBeGreaterThan(0);
    const writtenContent = configWrites[0][1] as string;
    expect(writtenContent).not.toContain('AUDITARIA_MCP_START');
    expect(writtenContent).toContain('test = true');
  });

  it('should reset session and clear thread_id', async () => {
    const threadMsg = JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-to-clear',
    });

    mockSpawn.mockReturnValue(createMockProcess([threadMsg]));

    const driver = new CodexCLIDriver(driverConfig);
    const controller = new AbortController();

    for await (const _ of driver.sendMessage('test', controller.signal)) {
      // consume
    }

    expect(driver.getSessionId()).toBe('thread-to-clear');

    driver.resetSession();
    expect(driver.getSessionId()).toBeUndefined();
  });
});
