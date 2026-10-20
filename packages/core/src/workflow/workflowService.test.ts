/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { InjectionService } from '../config/injectionService.js';
import { Storage } from '../config/storage.js';
import { ProviderEventType, type ProviderDriver } from '../providers/types.js';
import { parseWorkflowScript } from './scriptParser.js';
import { WorkflowService, WorkflowLaunchError } from './workflowService.js';
import { readJournalLines } from './journal.js';
import { readRunState } from './stateFile.js';

/**
 * A Config double with exactly the members the service and the external
 * leaf runner touch. Leaves run through a scripted fake driver.
 */
function makeConfig(tempRoot: string, model = 'claude-code:haiku') {
  const injectionService = new InjectionService(() => false);
  const storage = new Storage(tempRoot, 'session-a');
  // Keep every run under the temp root instead of the real project temp dir.
  storage.getProjectTempWorkflowsDir = () => path.join(tempRoot, 'workflows');
  const fake = {
    storage,
    injectionService,
    getModel: () => model,
    getWorkingDir: () => tempRoot,
    getTargetDir: () => tempRoot,
    getProjectRoot: () => tempRoot,
    buildExternalProviderContext: () => 'BASE',
    getAgentSessionManager: () => ({
      getToolBridge: async () => undefined,
    }),
  };
  return { config: fake as unknown as Config, injectionService };
}

function scriptedDriver(reply: (prompt: string) => string): ProviderDriver {
  return {
    async *sendMessage(prompt) {
      await new Promise((r) => setTimeout(r, 2));
      yield { type: ProviderEventType.Content, text: reply(prompt) };
      yield {
        type: ProviderEventType.Finished,
        usage: { inputTokens: 5, outputTokens: 7 },
      };
    },
    async interrupt() {},
    getSessionId: () => undefined,
    dispose() {},
    canResume: false,
  };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-service-'));
}

const SCRIPT = `export const meta = { name: 'svc', description: 'service test', phases: [{ title: 'A' }] }
phase('A')
log('start')
const a = await agent('one', { label: 'one', model: 'haiku' })
const [b, c] = await parallel([() => agent('two'), () => agent('three')])
return { a, b, c, spent: budget.spent() }`;

describe('WorkflowService', () => {
  it('loads prior runs and resumes from the saved source when the script was removed', async () => {
    const { config } = makeConfig(tempRoot());
    const first = new WorkflowService(config);
    const launched = first.launch({
      parsed: parseWorkflowScript(
        `export const meta = { name: 'saved', description: 'persist' }; return args.count;`,
      ),
      scriptPath: 'missing-saved-script.js',
      args: { count: 42 },
    });
    await first.waitFor(launched.runId);
    const restored = new WorkflowService(config);
    expect(restored.registry.get(launched.runId)).toMatchObject({
      status: 'completed',
      result: 42,
    });
    await restored.resume(launched.runId);
    expect((await restored.waitFor(launched.runId))?.result).toBe(42);
  });

  it('retries a silent agent with a fresh driver', async () => {
    const { config } = makeConfig(tempRoot());
    const service = new WorkflowService(config);
    let attempts = 0;
    const launched = service.launch({
      parsed:
        parseWorkflowScript(`export const meta = { name: 'stall', description: 'stall' };
return await agent('work', {stallMs: 20});`),
      scriptPath: 'stall.js',
      createDriver: async () => {
        const attempt = ++attempts;
        return {
          ...scriptedDriver(() => 'unused'),
          async *sendMessage(_prompt, signal) {
            if (attempt === 1) {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else
                  signal.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
              });
            } else yield { type: ProviderEventType.Content, text: 'recovered' };
          },
        };
      },
    });
    const run = await service.waitFor(launched.runId);
    expect(run?.result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('restarts a selected agent and counts usage across attempts', async () => {
    const { config } = makeConfig(tempRoot());
    const service = new WorkflowService(config);
    let attempts = 0;
    const launched = service.launch({
      parsed:
        parseWorkflowScript(`export const meta = { name: 'retry', description: 'retry' }
return await agent('work')`),
      scriptPath: 'retry.js',
      createDriver: async () => {
        const current = ++attempts;
        return {
          ...scriptedDriver(() => 'unused'),
          async *sendMessage(_prompt, signal) {
            if (current === 1) {
              yield {
                type: ProviderEventType.Finished,
                usage: { outputTokens: 3, inputTokens: 0 },
              };
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else
                  signal.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
              });
              return;
            }
            yield { type: ProviderEventType.Content, text: 'restarted' };
            yield {
              type: ProviderEventType.Finished,
              usage: { outputTokens: 7, inputTokens: 0 },
            };
          },
        };
      },
    });
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(service.retryAgent(launched.runId, 1)).toBe(true);
    const run = await service.waitFor(launched.runId);
    expect(attempts).toBe(2);
    expect(run?.result).toBe('restarted');
    expect(
      run?.workflowProgress.find((e) => e.type === 'workflow_agent'),
    ).toMatchObject({
      state: 'done',
      attempt: 2,
      tokens: 10,
    });
    expect(
      readJournalLines(service.paths.journalPath(launched.runId)).filter(
        (e) => e.type === 'result',
      ),
    ).toHaveLength(1);
  });

  it('cancels queued agents and retains the lease until active leaves exit', async () => {
    const { config } = makeConfig(tempRoot());
    const service = new WorkflowService(config);
    let started = 0;
    let finishCleanup: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const launched = service.launch({
      parsed:
        parseWorkflowScript(`export const meta = { name: 'stop', description: 'stop' }
return await parallel(Array.from({length: 24}, (_, i) => () => agent('work ' + i)))`),
      scriptPath: 'stop.js',
      createDriver: async () => ({
        ...scriptedDriver(() => 'unused'),
        async *sendMessage(_prompt, signal) {
          started++;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener('abort', () => resolve(), { once: true });
          });
          await cleanup;
          yield {
            type: ProviderEventType.Finished,
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      }),
    });
    await vi.waitFor(() => expect(started).toBeGreaterThan(0));
    service.stop(launched.runId);
    const atStop = started;
    let settled = false;
    const waiting = service.waitFor(launched.runId).then((run) => {
      settled = true;
      return run;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(fs.existsSync(service.paths.leasePath(launched.runId))).toBe(true);
    finishCleanup();
    const run = await waiting;
    expect(run?.status).toBe('killed');
    expect(started).toBe(atStop);
    expect(started).toBeLessThan(24);
    expect(fs.existsSync(service.paths.leasePath(launched.runId))).toBe(false);
  });

  it('releases ownership after initialization fails', async () => {
    const { config } = makeConfig(tempRoot());
    const service = new WorkflowService(config);
    const runId = 'wf_startup-failure';
    fs.mkdirSync(service.paths.runDir(runId), { recursive: true });
    fs.writeFileSync(service.paths.agentsDir(runId), 'blocks mkdir');
    const request = {
      parsed: parseWorkflowScript(
        `export const meta = { name: 'init', description: 'init' }; return 1;`,
      ),
      scriptPath: 'init.js',
      resumeFromRunId: runId,
    };
    service.launch(request);
    expect((await service.waitFor(runId))?.status).toBe('failed');
    expect(fs.existsSync(service.paths.leasePath(runId))).toBe(false);
    fs.unlinkSync(service.paths.agentsDir(runId));
    expect(() => service.launch(request)).not.toThrow();
    expect((await service.waitFor(runId))?.result).toBe(1);
  });

  it('launches in the background, journals, writes state.json/.output and queues a notification', async () => {
    const root = tempRoot();
    const { config, injectionService } = makeConfig(root);
    const service = new WorkflowService(config);
    const injected: Array<{ text: string; source: string }> = [];
    injectionService.onInjection((text, source) =>
      injected.push({ text, source }),
    );
    const notices: string[] = [];
    service.on('notice', (n) => notices.push(n.text));
    const parsed = parseWorkflowScript(SCRIPT);
    const launched = service.launch({
      parsed,
      scriptPath: path.join(root, 'svc.js'),
      args: { k: 1 },
      createDriver: async () =>
        scriptedDriver((p) => `echo:${p.split('\n')[0]}`),
    });
    expect(launched.runId).toMatch(/^wf_/);
    expect(launched.taskId).toMatch(/^w[a-z0-9]{8}$/);
    const run = service.registry.get(launched.taskId);
    expect(run?.status).toBe('running');

    const settled = await service.waitFor(launched.runId);
    expect(settled?.status).toBe('completed');
    expect(settled?.result).toEqual({
      a: 'echo:one',
      b: 'echo:two',
      c: 'echo:three',
      spent: 21, // three leaves × 7 output tokens, counted before agent() resolves
    });
    expect(settled?.providerAtLaunch).toEqual({
      family: 'claude',
      model: 'haiku',
    });

    const lines = readJournalLines(service.paths.journalPath(launched.runId));
    expect(lines.filter((l) => l.type === 'result')).toHaveLength(3);
    const state = readRunState(service.paths.statePath(launched.runId));
    expect(state?.status).toBe('completed');
    expect(state?.workflowName).toBe('svc');
    expect(state?.agentCount).toBe(3);
    expect(state?.totalTokens).toBe(21);
    expect(state?.logs).toEqual(['start']);
    expect(fs.existsSync(service.paths.outputPath(launched.taskId))).toBe(true);
    expect(fs.existsSync(service.paths.leasePath(launched.runId))).toBe(false);

    expect(injected).toHaveLength(1);
    expect(injected[0].source).toBe('workflow_notification');
    expect(injected[0].text).toContain('<task-notification>');
    expect(injected[0].text).toContain(`<task-id>${launched.taskId}</task-id>`);
    expect(injected[0].text).toContain(
      'Dynamic workflow "service test" completed',
    );
    expect(injected[0].text).toContain('<agent_count>3</agent_count>');
    expect(notices[0]).toContain('completed');
    expect(service.statusBlock(launched.taskId)).toContain(
      '<status>completed</status>',
    );
  });

  it('resumes from the same journal, serving cached agents, and refuses a second concurrent resume', async () => {
    const root = tempRoot();
    const { config } = makeConfig(root);
    const service = new WorkflowService(config);
    const parsed = parseWorkflowScript(SCRIPT);
    let calls = 0;
    const driverFactory = async () =>
      scriptedDriver((p) => {
        calls++;
        return `echo:${p.split('\n')[0]}`;
      });
    const first = service.launch({
      parsed,
      scriptPath: path.join(root, 'svc.js'),
      createDriver: driverFactory,
    });
    await service.waitFor(first.runId);
    expect(calls).toBe(3);

    const resumed = service.launch({
      parsed,
      scriptPath: path.join(root, 'svc.js'),
      resumeFromRunId: first.runId,
      createDriver: driverFactory,
    });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.resumed).toBe(true);
    expect(() =>
      service.launch({
        parsed,
        scriptPath: 'x',
        resumeFromRunId: first.runId,
        createDriver: driverFactory,
      }),
    ).toThrow(WorkflowLaunchError);
    const settled = await service.waitFor(first.runId);
    expect(settled?.status).toBe('completed');
    expect(calls).toBe(3); // nothing re-ran
    const cached = settled?.workflowProgress.filter(
      (e) => e.type === 'workflow_agent' && e.cached,
    );
    expect(cached).toHaveLength(3);
  });

  it('stop() kills a running workflow, leaves an unmatched started line, sends a notice but no notification', async () => {
    const root = tempRoot();
    const { config, injectionService } = makeConfig(root);
    const service = new WorkflowService(config);
    const injected: string[] = [];
    injectionService.onInjection((text) => injected.push(text));
    const notices: string[] = [];
    service.on('notice', (n) => notices.push(n.text));
    const slow: ProviderDriver = {
      async *sendMessage(_p, signal) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        yield { type: ProviderEventType.Content, text: 'late' };
      },
      async interrupt() {},
      getSessionId: () => undefined,
      dispose() {},
      canResume: false,
    };
    const parsed = parseWorkflowScript(
      `export const meta = { name: 'slow', description: 'slow' }\nreturn await agent('x')`,
    );
    const launched = service.launch({
      parsed,
      scriptPath: path.join(root, 'slow.js'),
      createDriver: async () => slow,
    });
    await new Promise((r) => setTimeout(r, 30));
    const stopped = service.stop(launched.taskId);
    expect(stopped.ok).toBe(true);
    const settled = await service.waitFor(launched.runId);
    expect(settled?.status).toBe('killed');
    const lines = readJournalLines(service.paths.journalPath(launched.runId));
    expect(lines.map((l) => l.type)).toEqual(['started']);
    expect(injected).toHaveLength(0);
    expect(notices[0]).toContain('killed');
    expect(service.stop(launched.taskId).ok).toBe(false);
  });

  it('reports an uncaught script error as failed with a recovery block', async () => {
    const root = tempRoot();
    const { config, injectionService } = makeConfig(root);
    const service = new WorkflowService(config);
    const injected: string[] = [];
    injectionService.onInjection((text) => injected.push(text));
    const parsed = parseWorkflowScript(
      `export const meta = { name: 'boom', description: 'boom' }\nthrow new Error('blew up')`,
    );
    const launched = service.launch({
      parsed,
      scriptPath: path.join(root, 'boom.js'),
    });
    const settled = await service.waitFor(launched.runId);
    expect(settled?.status).toBe('failed');
    expect(settled?.error).toBe('Error: blew up');
    expect(injected[0]).toContain('<status>failed</status>');
    expect(injected[0]).toContain('failed: Error: blew up');
    expect(injected[0]).toContain('<recovery>');
  });
});
