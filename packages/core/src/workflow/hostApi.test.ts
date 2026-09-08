/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_CAP_ERROR,
  NESTING_ERROR,
  PARALLEL_NOT_FUNCTIONS_ERROR,
  WorkflowHostApi,
  type AgentCall,
  type HostApiDeps,
  type SubagentResult,
} from './hostApi.js';
import { WorkflowJournal, readJournalLines } from './journal.js';
import { createWorkflowSandbox } from './sandbox.js';
import { parseWorkflowScript } from './scriptParser.js';
import type { WorkflowProgressEvent } from './types.js';

const META = `export const meta = { name: 'host', description: 'host test', phases: [{ title: 'P0' }] }`;

interface Harness {
  run: (
    body: string,
    opts?: { args?: unknown; journalPath?: string; meta?: string },
  ) => Promise<unknown>;
  calls: AgentCall[];
  progress: WorkflowProgressEvent[];
  logs: string[];
  failures: string[];
  journalPath: string;
  keys: () => string[];
}

function makeHarness(
  fakeRunner: (call: AgentCall) => Promise<SubagentResult> | SubagentResult,
  extra: Partial<HostApiDeps> = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-host-'));
  const journalPath = path.join(dir, 'journal.jsonl');
  const calls: AgentCall[] = [];
  const progress: WorkflowProgressEvent[] = [];
  const logs: string[] = [];
  const failures: string[] = [];
  const run: Harness['run'] = async (body, opts = {}) => {
    const { meta, wrapped } = parseWorkflowScript(
      `${opts.meta ?? META}\n${body}`,
    );
    const journal = await WorkflowJournal.open(opts.journalPath ?? journalPath);
    const ac = new AbortController();
    const host = new WorkflowHostApi({
      meta,
      args: opts.args,
      journal,
      budget: { total: null, spent: () => 0 },
      signal: ac.signal,
      runAgent: async (call) => {
        calls.push(call);
        return fakeRunner(call);
      },
      resolveChildWorkflow: async () => {
        throw new Error(
          "workflow('x'): no workflow with that name. Available: (none)",
        );
      },
      onProgress: (e) => progress.push(e),
      onLog: (m) => logs.push(m),
      onFailure: (m) => failures.push(m),
      concurrency: 4,
      ...extra,
    });
    const sandbox = createWorkflowSandbox(host.hooks, { signal: ac.signal });
    host.attachSandbox(sandbox);
    try {
      return await sandbox.run(wrapped);
    } finally {
      await journal.flush();
      sandbox.dispose();
    }
  };
  return {
    run,
    calls,
    progress,
    logs,
    failures,
    journalPath,
    keys: () => calls.map((c) => c.key),
  };
}

const echoRunner = async (call: AgentCall): Promise<SubagentResult> => {
  await new Promise((r) => setTimeout(r, 5));
  return {
    kind: 'ok',
    outcome: {
      value: `echo:${call.prompt}`,
      agentId: call.agentId,
      model: 'fake-model',
      tokens: 10,
      toolCalls: 0,
      usageUnavailable: false,
      durationMs: 5,
    },
  };
};

describe('agent()', () => {
  it('returns the runner value, journals started/result and emits start/done progress', async () => {
    const h = makeHarness(echoRunner);
    const out = await h.run(
      "phase('A')\nconst a = await agent('hi', { label: 'one', model: 'haiku' })\nreturn a",
    );
    expect(out).toBe('echo:hi');
    expect(h.calls[0].label).toBe('one');
    expect(h.calls[0].opts.model).toBe('haiku');
    expect(h.calls[0].phaseTitle).toBe('A');
    const lines = readJournalLines(h.journalPath);
    expect(lines.map((l) => l.type)).toEqual(['started', 'result']);
    const agentEvents = h.progress.filter((e) => e.type === 'workflow_agent');
    expect(
      agentEvents.map((e) => (e.type === 'workflow_agent' ? e.state : '')),
    ).toEqual(['start', 'done']);
    const done = agentEvents[1];
    if (done.type !== 'workflow_agent') throw new Error('unreachable');
    expect(done.model).toBe('fake-model');
    expect(done.tokens).toBe(10);
    expect(done.phaseTitle).toBe('A');
    // meta.phases pre-registered as index 1, 'A' as 2
    expect(
      h.progress.filter((e) => e.type === 'workflow_phase').map((e) => e.title),
    ).toEqual(['P0', 'A']);
  });

  it('coerces prompts and labels like Claude Code', async () => {
    const h = makeHarness(echoRunner);
    await h.run(
      "await agent('')\nawait agent(12345)\nawait agent({ o: 1 })\nawait agent('  spaced   label  ', { label: ' my   label ' })",
    );
    expect(h.calls.map((c) => c.prompt)).toEqual([
      '',
      '12345',
      '[object]',
      '  spaced   label  ',
    ]);
    expect(h.calls.map((c) => c.label)).toEqual([
      '',
      '12345',
      '[object]',
      'my label',
    ]);
  });

  it('resolves null on a terminal provider failure (logged, journaled failed) and throws on a schema failure', async () => {
    const h = makeHarness(async (call) => {
      if (call.prompt === 'bad')
        return { kind: 'failed', error: 'model not found' };
      if (call.prompt === 'schema')
        throw new Error(
          'agent({schema}): subagent completed without calling StructuredOutput.',
        );
      return echoRunner(call);
    });
    const out = await h.run(
      "const a = await agent('bad', { label: 'bad-model' })\nlet s = 'n/a'\ntry { await agent('schema') } catch (e) { s = (e instanceof Error) + ':' + e.message }\nreturn { a, s }",
    );
    expect(out).toEqual({
      a: null,
      s: 'true:agent({schema}): subagent completed without calling StructuredOutput.',
    });
    expect(h.failures).toEqual(['[bad-model] failed: model not found']);
    expect(h.logs).toContain('[bad-model] failed: model not found');
    expect(readJournalLines(h.journalPath).map((l) => l.type)).toEqual([
      'started',
      'failed',
      'started',
      'failed',
    ]);
  });

  it('resolves null when the user skips the agent', async () => {
    const h = makeHarness(async () => ({ kind: 'skipped' }));
    expect(await h.run("return await agent('x')")).toBeNull();
    const ev = h.progress.find(
      (e) => e.type === 'workflow_agent' && e.state === 'error',
    );
    expect(ev && ev.type === 'workflow_agent' && ev.skipped).toBe(true);
  });

  it('rejects the call before journaling an agentId when validateCall throws', async () => {
    const h = makeHarness(echoRunner, {
      validateCall: (_p, opts) => {
        if (opts.schema && opts.schema['type'] !== 'object')
          throw new Error('agent({schema}) received an unusable JSON Schema');
      },
    });
    const out = await h.run(
      "try { await agent('x', { schema: { type: 'string' } }) } catch (e) { return e.message }",
    );
    expect(out).toContain('unusable JSON Schema');
    expect(h.calls).toHaveLength(0);
    expect(readJournalLines(h.journalPath)).toEqual([
      { type: 'failed', key: expect.any(String) },
    ]);
  });

  it('enforces the 1000-call cap with the exact message', async () => {
    const h = makeHarness(echoRunner, { concurrency: 16 });
    const out = await h.run(
      "let n = 0\ntry { while (true) { await agent('x' + n); n++ } } catch (e) { return { n, name: e.name, msg: e.message } }",
    );
    expect(out).toEqual({
      n: 1000,
      name: 'WorkflowAgentCapError',
      msg: AGENT_CAP_ERROR,
    });
  }, 60_000);

  it('enforces a token budget as a hard ceiling on starting new work', async () => {
    let spent = 0;
    const h = makeHarness(
      async (call) => {
        spent += 100;
        return echoRunner(call);
      },
      { budget: { total: 250, spent: () => spent } },
    );
    const out = await h.run(
      "const r = []\ntry { for (let i = 0; i < 10; i++) r.push(await agent('a' + i)) } catch (e) { return { r, name: e.name, msg: e.message, remaining: budget.remaining(), total: budget.total } }",
    );
    expect(out).toEqual({
      r: ['echo:a0', 'echo:a1', 'echo:a2'],
      name: 'WorkflowBudgetExceededError',
      msg: 'Workflow token budget exceeded (300 / 250 output tokens). Stopping further agent() calls. In-flight agents will complete; their results are preserved.',
      remaining: 0,
      total: 250,
    });
  });
});

describe('parallel() and pipeline()', () => {
  it('parallel maps rejections and undefined to null, keeps order, logs failures', async () => {
    const h = makeHarness(echoRunner);
    const out = await h.run(`return await parallel([
      () => Promise.reject(new Error('boom')),
      () => agent('B'),
      () => 'plain',
      () => { throw new Error('sync') },
      () => 42, () => null, () => undefined, () => false])`);
    expect(out).toEqual([null, 'echo:B', 'plain', null, 42, null, null, false]);
    expect(h.failures).toEqual([
      'parallel[0] failed: boom',
      'parallel[3] failed: sync',
    ]);
  });

  it('parallel validates its input like Claude Code', async () => {
    const h = makeHarness(echoRunner);
    const out = await h.run(`
      const notes = {}
      notes.empty = await parallel([])
      try { await parallel(['x']) } catch (e) { notes.nonFn = e.message }
      try { await parallel(new Array(4097).fill(() => 1)) } catch (e) { notes.big = e.message }
      try { await parallel('nope') } catch (e) { notes.notArray = e instanceof TypeError }
      return notes`);
    expect(out).toEqual({
      empty: [],
      nonFn: PARALLEL_NOT_FUNCTIONS_ERROR,
      big: 'array length 4097 exceeds the maximum of 4096 supported across the workflow VM boundary',
      notArray: true,
    });
  });

  it('pipeline passes (prev, item, index), drops on throw or null, no stages → items', async () => {
    const h = makeHarness(echoRunner);
    const out = await h.run(`
      const a = await pipeline([1, 2, 3],
        (x, item, i) => ({ x, item, i }),
        async (prev, item, i) => { if (item === 2) throw new Error('drop 2'); if (item === 3) return null; return { prev, item, i } },
        (prev, item, i) => ({ done: true, prev, item, i }))
      const b = await pipeline([], (x) => x)
      const c = await pipeline([1, 2])
      let d = 'n/a'; try { await pipeline([1], 'notfn') } catch (e) { d = e.message }
      return { a, b, c, d }`);
    expect(out).toEqual({
      a: [
        {
          done: true,
          prev: { prev: { x: 1, item: 1, i: 0 }, item: 1, i: 0 },
          item: 1,
          i: 0,
        },
        null,
        null,
      ],
      b: [],
      c: [1, 2],
      d: 'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)',
    });
    expect(h.failures).toEqual(['pipeline[1] failed: drop 2']);
  });

  it('respects the concurrency slot pool', async () => {
    let active = 0;
    let peak = 0;
    const h = makeHarness(
      async (call) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return echoRunner(call);
      },
      { concurrency: 3 },
    );
    await h.run(
      "await parallel(Array.from({ length: 9 }, (_, i) => () => agent('p' + i)))",
    );
    expect(peak).toBe(3);
    expect(h.calls).toHaveLength(9);
  });
});

describe('journal keys across branches', () => {
  const SCRIPT = `
    const a = await agent('A')
    const [b, c] = await parallel([
      async () => { const x = await agent('B1'); return agent('B2:' + x) },
      () => agent('C'),
    ])
    const p = await pipeline([1, 2], (item) => agent('S1-' + item), (prev, item) => agent('S2-' + item))
    const d = await agent('D')
    return { a, b, c, p, d }`;

  it('are identical across runs regardless of completion order', async () => {
    const delays = [40, 1, 25, 3, 30, 2, 20, 5, 10];
    const slow = makeHarness(async (call) => {
      await new Promise((r) =>
        setTimeout(r, delays[call.index % delays.length]),
      );
      return echoRunner(call);
    });
    const fast = makeHarness(echoRunner);
    await slow.run(SCRIPT);
    await fast.run(SCRIPT);
    const byPrompt = (h: Harness) =>
      Object.fromEntries(h.calls.map((c) => [c.prompt, c.key]));
    expect(byPrompt(slow)).toEqual(byPrompt(fast));
    expect(new Set(slow.keys()).size).toBe(slow.keys().length);
  });

  it('identical prompts at different positions never share a key; editing an early call re-keys later ones', async () => {
    const h1 = makeHarness(echoRunner);
    await h1.run("await agent('P'); await agent('P'); await agent('Q')");
    expect(h1.keys()[0]).not.toBe(h1.keys()[1]);
    const h2 = makeHarness(echoRunner);
    await h2.run("await agent('P'); await agent('P2'); await agent('Q')");
    expect(h2.keys()[0]).toBe(h1.keys()[0]);
    expect(h2.keys()[2]).not.toBe(h1.keys()[2]); // unchanged text, new key
  });

  it('serves cached results on resume and re-runs only after the edit point', async () => {
    const first = makeHarness(echoRunner);
    await first.run(
      "const a = await agent('A'); const b = await agent('B'); const c = await agent('C'); return [a, b, c]",
    );
    const resumed = makeHarness(echoRunner);
    const out = await resumed.run(
      "const a = await agent('A'); const b = await agent('B2'); const c = await agent('C'); return [a, b, c]",
      { journalPath: first.journalPath },
    );
    expect(out).toEqual(['echo:A', 'echo:B2', 'echo:C']);
    expect(resumed.calls.map((c) => c.prompt)).toEqual(['B2', 'C']); // A cached
    const cached = resumed.progress.filter(
      (e) => e.type === 'workflow_agent' && e.cached,
    );
    expect(cached).toHaveLength(1);
    expect(readJournalLines(first.journalPath).map((l) => l.type)).toEqual([
      'started',
      'result',
      'started',
      'result',
      'started',
      'result', // first run
      'started',
      'result',
      'started',
      'result', // B2, C re-run
    ]);
  });

  it('an unchanged script resumes with zero runner calls', async () => {
    const first = makeHarness(echoRunner);
    const body = "return await parallel([() => agent('X'), () => agent('Y')])";
    await first.run(body);
    const resumed = makeHarness(echoRunner);
    expect(await resumed.run(body, { journalPath: first.journalPath })).toEqual(
      ['echo:X', 'echo:Y'],
    );
    expect(resumed.calls).toHaveLength(0);
  });
});

describe('phase(), log(), args, workflow()', () => {
  it('memoizes phases, uses opts.phase without touching the ambient phase, coerces log values', async () => {
    const h = makeHarness(echoRunner);
    await h.run(
      "phase('A'); phase('A'); await agent('x', { phase: 'B' }); await agent('y'); log(12345); log(null); log({ a: 1 })",
    );
    expect(
      h.progress.filter((e) => e.type === 'workflow_phase').map((e) => e.title),
    ).toEqual(['P0', 'A', 'B']);
    expect(h.calls.map((c) => c.phaseTitle)).toEqual(['B', 'A']);
    expect(h.logs).toEqual(['12345', 'null', '[object]']);
  });

  it('args is a JSON snapshot; undefined when omitted', async () => {
    const h = makeHarness(echoRunner);
    expect(
      await h.run('return { t: typeof args, a: args }', {
        args: ['a', { k: 1 }],
      }),
    ).toEqual({ t: 'object', a: ['a', { k: 1 }] });
    expect(await h.run('return typeof args')).toBe('undefined');
  });

  it('runs a child workflow inline: shared journal/counter, child phase group, prefixed logs, nesting error', async () => {
    const child = parseWorkflowScript(
      "export const meta = { name: 'kid', description: 'child' }\nphase('ignored')\nlog('child says hi')\nconst r = await agent('child-' + args.tag)\nlet n = 'n/a'\ntry { await workflow('kid') } catch (e) { n = e.message }\nreturn { r, n }",
    );
    const h = makeHarness(echoRunner, {
      resolveChildWorkflow: async (ref) => {
        if (ref === 'kid') return { meta: child.meta, wrapped: child.wrapped };
        throw new Error(
          `workflow('${String(ref)}'): no workflow with that name. Available: kid`,
        );
      },
    });
    const out = await h.run(
      "const c = await workflow('kid', { tag: 'X' }); const own = await agent('own'); let bad = 'n/a'; try { await workflow('nope') } catch (e) { bad = e.message }; return { c, own, bad }",
    );
    expect(out).toEqual({
      c: { r: 'echo:child-X', n: NESTING_ERROR },
      own: 'echo:own',
      bad: "workflow('nope'): no workflow with that name. Available: kid",
    });
    expect(h.calls.map((c) => c.index)).toEqual([1, 2]);
    expect(h.calls[0].phaseTitle).toBe('▸ kid');
    expect(h.logs).toEqual([
      '▸ running dynamic workflow kid',
      '[kid] child says hi',
      '▸ kid done',
    ]);
    const childPhase = h.progress.find(
      (e) => e.type === 'workflow_phase' && e.kind === 'child',
    );
    expect(
      childPhase && childPhase.type === 'workflow_phase' && childPhase.title,
    ).toBe('▸ kid');
    expect(readJournalLines(h.journalPath).map((l) => l.type)).toEqual([
      'started',
      'result',
      'started',
      'result',
    ]);
  });
});
