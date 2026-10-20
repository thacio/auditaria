/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRecord } from '../guards.js';
import {
  WorkflowHostApi,
  type AgentCall,
  type SubagentResult,
} from '../hostApi.js';
import { WorkflowJournal } from '../journal.js';
import { createWorkflowSandbox } from '../sandbox.js';
import { parseWorkflowScript } from '../scriptParser.js';
import { DEEP_RESEARCH_SCRIPT } from './deepResearch.js';

const tempPrefix = path.join(os.tmpdir(), 'wf-research-test-');
const tempDirs: string[] = [];
const claim = 'The archived project report contains three findings.';
const sourceUrl = 'https://example.test/report';
const quote = 'The report contains three findings.';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (!path.resolve(dir).startsWith(path.resolve(tempPrefix))) {
      throw new Error('Unexpected research test directory');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function runResearch(
  votes: Array<boolean | null>,
  synthesisFails = false,
): Promise<{ result: Record<string, unknown>; synthesisPrompt: string }> {
  const dir = fs.mkdtempSync(tempPrefix);
  tempDirs.push(dir);
  const journal = await WorkflowJournal.open(path.join(dir, 'journal.jsonl'));
  const { meta, wrapped } = parseWorkflowScript(DEEP_RESEARCH_SCRIPT);
  const controller = new AbortController();
  let synthesisPrompt = '';
  const complete = (call: AgentCall, value: unknown): SubagentResult => ({
    kind: 'ok',
    outcome: {
      value,
      agentId: call.agentId,
      model: 'fixture',
      tokens: 1,
      toolCalls: 0,
      usageUnavailable: false,
      durationMs: 0,
    },
  });
  const host = new WorkflowHostApi({
    meta,
    args: 'What does the archived project report say?',
    journal,
    budget: { total: null, spent: () => 0 },
    signal: controller.signal,
    runAgent: async (call) => {
      if (call.label === 'scope') {
        return complete(call, {
          question: 'What does the archived project report say?',
          summary: 'Check the archive and independent references.',
          angles: ['primary', 'historical', 'independent'].map((label) => ({
            label,
            query: `${label} project report`,
          })),
        });
      }
      if (call.label.startsWith('search:')) {
        return complete(call, {
          results:
            call.label === 'search:primary'
              ? [{ url: sourceUrl, title: 'Project report', relevance: 'high' }]
              : [],
        });
      }
      if (call.label.startsWith('fetch:')) {
        return complete(call, {
          sourceQuality: 'primary',
          claims: [{ claim, quote, importance: 'central' }],
        });
      }
      if (call.label.startsWith('verify:')) {
        const voteIndex = Number(call.label.split('/')[1]) - 1;
        const refuted = votes[voteIndex];
        if (refuted === null) {
          return { kind: 'failed', error: 'Verifier unavailable' };
        }
        if (refuted === undefined) throw new Error('Missing verification vote');
        return complete(call, {
          refuted,
          evidence: `Independent evidence ${voteIndex + 1}`,
          confidence: 'high',
        });
      }
      if (call.label === 'synthesize') {
        synthesisPrompt = call.prompt;
        return synthesisFails
          ? { kind: 'failed', error: 'Synthesis unavailable' }
          : complete(call, {
              summary: 'Fixture report',
              findings: [],
              caveats: '',
            });
      }
      throw new Error(`Unexpected research agent: ${call.label}`);
    },
    resolveChildWorkflow: async () => {
      throw new Error('Research must not launch a child workflow');
    },
    onProgress: () => undefined,
    onLog: () => undefined,
    onFailure: () => undefined,
  });
  const sandbox = createWorkflowSandbox(host.hooks, {
    signal: controller.signal,
  });
  host.attachSandbox(sandbox);
  try {
    const result = await sandbox.run(wrapped);
    if (!isRecord(result)) throw new Error('Research did not return a result');
    return { result, synthesisPrompt };
  } finally {
    await host.waitForAgents();
    await journal.flush();
    sandbox.dispose();
  }
}

describe('deep research verification', () => {
  it.each([
    {
      label: 'no valid votes',
      votes: [null, null, null],
      confirmed: 0,
      reason: 'insufficient verification votes',
    },
    {
      label: 'one supporting vote and two failures',
      votes: [false, null, null],
      confirmed: 0,
      reason: 'insufficient verification votes',
    },
    {
      label: 'one refuting vote and two failures',
      votes: [true, null, null],
      confirmed: 0,
      reason: 'insufficient verification votes',
    },
    {
      label: 'two supporting votes and one failure',
      votes: [false, false, null],
      confirmed: 1,
      reason: undefined,
    },
    {
      label: 'a valid split quorum and one failure',
      votes: [false, true, null],
      confirmed: 1,
      reason: undefined,
    },
    {
      label: 'two refuting votes',
      votes: [true, true, false],
      confirmed: 0,
      reason: 'refuted',
    },
  ])(
    'classifies $label without treating failed agents as evidence',
    async ({ votes, confirmed, reason }) => {
      const { result, synthesisPrompt } = await runResearch(votes);
      expect(result['claimsExtracted']).toBe(1);
      expect(result['claimsVerified']).toBe(confirmed);
      if (reason) {
        expect(synthesisPrompt).toContain('Verified claims (JSON):\n[]');
        expect(synthesisPrompt).toContain(
          JSON.stringify({ claim, url: sourceUrl, reason }),
        );
      } else {
        expect(synthesisPrompt).toContain(JSON.stringify(claim));
        expect(synthesisPrompt).toContain(
          'Claims not verified (for the caveats section):\n[]',
        );
      }
    },
  );

  it('returns verified source evidence when synthesis fails', async () => {
    const { result } = await runResearch([false, false, null], true);
    expect(result['report']).toBeNull();
    expect(result['claimsVerified']).toBe(1);
    expect(result['error']).toContain('Synthesis did not finish');
    expect(result['verifiedClaims']).toEqual([
      expect.objectContaining({
        claim,
        quote,
        url: sourceUrl,
        sourceQuality: 'primary',
        votes: [
          expect.objectContaining({ evidence: 'Independent evidence 1' }),
          expect.objectContaining({ evidence: 'Independent evidence 2' }),
        ],
      }),
    ]);
  });

  it('does not manufacture fallback evidence when verification and synthesis fail', async () => {
    const { result } = await runResearch([null, null, null], true);
    expect(result['report']).toBeNull();
    expect(result['claimsVerified']).toBe(0);
    expect(result['verifiedClaims']).toEqual([]);
  });
});
