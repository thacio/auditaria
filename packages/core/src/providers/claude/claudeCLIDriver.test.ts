import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCLIDriver } from './claudeCLIDriver.js';
import { ProviderEventType } from '../types.js';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { Readable } from 'stream';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

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

describe('ClaudeCLIDriver', () => {
  const driverConfig = {
    model: 'sonnet',
    cwd: '/tmp/test',
    permissionMode: 'bypassPermissions',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should parse system message and capture session ID', async () => {
    const systemMsg = JSON.stringify({
      type: 'system',
      session_id: 'test-session-123',
      tools: ['Bash', 'Read'],
    });
    const assistantMsg = JSON.stringify({
      type: 'assistant',
      message: {
        type: 'message',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'Hello!' }],
      },
      session_id: 'test-session-123',
    });
    const resultMsg = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'test-session-123',
    });

    mockSpawn.mockReturnValue(createMockProcess([systemMsg, assistantMsg, resultMsg]));

    const driver = new ClaudeCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('say hi', controller.signal)) {
      events.push(event);
    }

    expect(driver.getSessionId()).toBe('test-session-123');
  });

  it('should emit ModelInfo and Content from assistant message', async () => {
    const systemMsg = JSON.stringify({
      type: 'system',
      session_id: 'sess-1',
    });
    const assistantMsg = JSON.stringify({
      type: 'assistant',
      message: {
        type: 'message',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'The answer is 42.' }],
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([systemMsg, assistantMsg]));

    const driver = new ClaudeCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('what is 6*7?', controller.signal)) {
      events.push(event);
    }

    const modelInfo = events.find(e => e.type === ProviderEventType.ModelInfo);
    expect(modelInfo).toBeDefined();
    expect((modelInfo as { model: string }).model).toBe('claude-sonnet-4-5-20250929');

    const content = events.find(e => e.type === ProviderEventType.Content);
    expect(content).toBeDefined();
    expect((content as { text: string }).text).toBe('The answer is 42.');
  });

  it('should emit Thinking event from thinking blocks', async () => {
    const assistantMsg = JSON.stringify({
      type: 'assistant',
      message: {
        type: 'message',
        content: [{ type: 'thinking', thinking: 'Let me consider...' }],
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([assistantMsg]));

    const driver = new ClaudeCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('think', controller.signal)) {
      events.push(event);
    }

    const thinking = events.find(e => e.type === ProviderEventType.Thinking);
    expect(thinking).toBeDefined();
    expect((thinking as { text: string }).text).toBe('Let me consider...');
  });

  it('should emit ToolUse from assistant and ToolResult from user messages', async () => {
    const assistantMsg = JSON.stringify({
      type: 'assistant',
      message: {
        type: 'message',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/tmp/x' } },
        ],
      },
    });
    const userMsg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'file contents', is_error: false },
        ],
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([assistantMsg, userMsg]));

    const driver = new ClaudeCLIDriver(driverConfig);
    const events = [];
    const controller = new AbortController();

    for await (const event of driver.sendMessage('read file', controller.signal)) {
      events.push(event);
    }

    const toolUse = events.find(e => e.type === ProviderEventType.ToolUse);
    expect(toolUse).toBeDefined();
    expect((toolUse as { toolName: string }).toolName).toBe('Read');
    expect((toolUse as { toolId: string }).toolId).toBe('tool_1');

    const toolResult = events.find(e => e.type === ProviderEventType.ToolResult);
    expect(toolResult).toBeDefined();
    expect((toolResult as { output: string }).output).toBe('file contents');
    expect((toolResult as { isError: boolean }).isError).toBe(false);
  });

  it('should emit Finished with usage from result message', async () => {
    const resultMsg = JSON.stringify({
      type: 'result',
      subtype: 'success',
      modelUsage: {
        'claude-sonnet-4-5-20250929': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
          cumulativeInputTokens: 200,
          cumulativeOutputTokens: 100,
        },
      },
    });

    mockSpawn.mockReturnValue(createMockProcess([resultMsg]));

    const driver = new ClaudeCLIDriver(driverConfig);
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
    expect(usage.inputTokens).toBe(200); // cumulative preferred
    expect(usage.outputTokens).toBe(100);
  });

  it('should skip non-JSON lines gracefully', async () => {
    const assistantMsg = JSON.stringify({
      type: 'assistant',
      message: { type: 'message', content: [{ type: 'text', text: 'ok' }] },
    });

    mockSpawn.mockReturnValue(
      createMockProcess(['not json', '', assistantMsg, 'also not json']),
    );

    const driver = new ClaudeCLIDriver(driverConfig);
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

    const driver = new ClaudeCLIDriver(driverConfig);
    const controller = new AbortController();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of driver.sendMessage('hello', controller.signal)) {
      // consume
    }

    // Prompt is piped via stdin, not passed as -p arg (avoids Windows cmd.exe quoting issues)
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      ['--output-format', 'stream-json', '--model', 'sonnet', '--permission-mode', 'bypassPermissions'],
      expect.objectContaining({
        cwd: '/tmp/test',
        shell: true,
      }),
    );

    // Prompt written to stdin
    expect(mockProc.stdin!.write).toHaveBeenCalledWith('hello');
    expect(mockProc.stdin!.end).toHaveBeenCalled();
  });
});
