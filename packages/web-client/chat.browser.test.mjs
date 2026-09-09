/** Browser regression coverage for conversation disclosure and streaming updates.
 * Run: node --test packages/web-client/chat.browser.test.mjs
 * Set PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome browser.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { dirname, resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

/* global window, document, manager, tools, blocks, originalItem */

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'src');
let server, browser, page, baseUrl;
const errors = [];

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const path = resolve(
        root,
        '.' + (pathname === '/' ? '/index.html' : pathname),
      );
      if (!path.startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
      }
      let content = await readFile(path);
      if (pathname === '/') {
        // Use the real app shell and CSS with deterministic local conversation data.
        content = content
          .toString()
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        content += `<script src="/marked.min.js"></script><script type="module">
          import { MessageManager } from '/managers/MessageManager.js';
          window.manager = new MessageManager();
        </script>`;
      }
      response.setHeader(
        'Content-Type',
        { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[
          extname(path)
        ] || 'application/octet-stream',
      );
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL,
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    route.request().url().startsWith(baseUrl)
      ? route.continue()
      : route.abort(),
  );
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.manager);
  await page.evaluate(
    () => (document.documentElement.dataset.theme = 'calm-light'),
  );
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function seed() {
  await page.evaluate(() => {
    manager.clearAllMessages();
    manager.addHistoryItem({
      type: 'user',
      text: 'Review the access policy and highlight the controls we should test first.',
    });
    manager.addHistoryItem({
      type: 'gemini',
      text: 'I’ll review the policy, then map the key controls to the evidence we need.',
    });
    window.tools = [
      {
        callId: 'read-1',
        name: 'read_file',
        status: 'Success',
        description: 'policies/access-control.md',
        resultDisplay:
          'Access control policy\n\nAll privileged access requires approval.\nAccess reviews must be completed quarterly.',
        llmOutput: 'Full policy output for inspection',
      },
      {
        callId: 'search-1',
        name: 'knowledge_search',
        status: 'Executing',
        description: 'Finding supporting control evidence',
        liveOutput: 'Searching the knowledge base…',
      },
    ];
    window.blocks = [{ type: 'tool_group', tools: window.tools }];
    manager.renderResponseState(window.blocks);
  });
}

test('tool activity is compact by default and keyboard expandable', async () => {
  await seed();
  const summary = page.locator('.response-active summary');
  assert.match(await summary.innerText(), /Working.*2 steps/s);
  assert.equal(
    await page.locator('.response-active .tool-disclosure').first().isVisible(),
    false,
  );
  await summary.focus();
  await page.keyboard.press('Enter');
  const disclosure = page.locator('[data-call-id="read-1"] .tool-disclosure');
  await disclosure.focus();
  await page.keyboard.press('Space');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(
    await page.locator('[data-call-id="read-1"] .tool-output').isVisible(),
    true,
  );
});

test('streaming retains open, raw and focused state when blocks append or tools change', async () => {
  await seed();
  await page.locator('.response-active summary').click();
  await page.locator('[data-call-id="read-1"] .tool-disclosure').click();
  const raw = page.locator('[data-call-id="read-1"] .tool-toggle-llm-btn');
  await raw.click();
  await page.evaluate(() => {
    window.originalItem = document.querySelector('[data-call-id="read-1"]');
    blocks.push({
      type: 'text',
      text: 'The key controls are approval and periodic review.',
    });
    manager.renderResponseState(blocks);
  });
  assert.equal(
    await page.evaluate(
      () => originalItem === document.querySelector('[data-call-id="read-1"]'),
    ),
    true,
  );
  assert.equal(await raw.getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => {
    tools[0] = { ...tools[0], llmOutput: 'Updated raw policy output' };
    manager.renderResponseState(blocks);
  });
  assert.equal(await raw.getAttribute('aria-pressed'), 'true');
  assert.equal(await raw.evaluate((el) => document.activeElement === el), true);
  assert.match(
    await page.locator('[data-call-id="read-1"] .tool-output').innerText(),
    /Updated raw/,
  );
  await page.evaluate(() => {
    manager.addHistoryItem({ type: 'tool_group', tools });
    manager.renderResponseState(null);
  });
  assert.equal(
    await page.locator('.message-tool_group details').getAttribute('open'),
    '',
  );
  assert.equal(await raw.getAttribute('aria-pressed'), 'true');
});

test('fifteen adjacent history batches become one activity, including after reload', async () => {
  await page.evaluate(() => {
    manager.clearAllMessages();
    const history = Array.from({ length: 15 }, (_, index) => ({
      type: 'tool_group',
      tools: [
        {
          callId: `batch-${index}`,
          name: 'read_file',
          status: index === 14 ? 'Error' : 'Success',
          description: `policy-${index}.md`,
          resultDisplay: `Evidence ${index}`,
        },
      ],
    }));
    window.activityHistory = history;
    history.forEach((item) => manager.addHistoryItem(item));
  });
  assert.equal(await page.locator('.tool-activity').count(), 1);
  assert.equal(await page.locator('.tool-item').count(), 15);
  assert.match(
    await page.locator('summary').innerText(),
    /15 steps.*1 failed/s,
  );
  await page.locator('.tool-activity summary').click();
  await page.locator('[data-call-id="batch-0"] .tool-disclosure').click();
  await page.evaluate(() => {
    manager.addHistoryItem({
      type: 'tool_group',
      tools: [
        {
          callId: 'extra',
          name: 'read_file',
          status: 'Success',
          resultDisplay: 'More evidence',
        },
      ],
    });
  });
  assert.equal(
    await page
      .locator('[data-call-id="batch-0"] .tool-disclosure')
      .getAttribute('aria-expanded'),
    'true',
  );
  await page.evaluate(() => manager.loadHistoryItems(window.activityHistory));
  assert.equal(await page.locator('.tool-activity').count(), 1);
  assert.equal(await page.locator('.tool-item').count(), 15);
  assert.equal(
    await page.evaluate(() =>
      window.activityHistory.every((item) => item.tools.length === 1),
    ),
    true,
  );
});

test('adjacent streaming batches merge without closing inspected calls or changing source data', async () => {
  await seed();
  await page.locator('.response-active summary').click();
  await page.locator('[data-call-id="read-1"] .tool-disclosure').click();
  await page.locator('[data-call-id="read-1"] .tool-toggle-llm-btn').click();
  await page.evaluate(() => {
    for (let index = 0; index < 14; index++) {
      blocks.push({ type: 'text', text: '  ' });
      blocks.push({
        type: 'tool_group',
        tools: [
          {
            callId: `stream-${index}`,
            name: 'read_file',
            status: 'Success',
            resultDisplay: `Evidence ${index}`,
          },
        ],
      });
    }
    manager.renderResponseState(blocks);
  });
  assert.equal(
    await page.locator('.response-active .tool-activity').count(),
    1,
  );
  assert.equal(await page.locator('.response-active .tool-item').count(), 16);
  assert.equal(
    await page
      .locator('[data-call-id="read-1"] .tool-toggle-llm-btn')
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await page.evaluate(() => blocks[0].tools.length), 2);
  await page.evaluate(() => manager.renderResponseState(blocks));
  assert.equal(await page.locator('.response-active .tool-item').count(), 16);
});

test('assistant and user messages separate activity runs in history and streaming', async () => {
  await page.evaluate(() => {
    const batch = {
      type: 'tool_group',
      tools: [
        { name: 'read_file', status: 'Success', resultDisplay: 'Evidence' },
      ],
    };
    const history = [
      batch,
      batch,
      { type: 'gemini', text: 'Now checking the exceptions.' },
      batch,
      { type: 'user', text: 'Also check last quarter.' },
      batch,
    ];
    manager.loadHistoryItems(history);
  });
  assert.equal(await page.locator('.message-tool_group').count(), 3);
  assert.equal(await page.locator('.message-gemini').count(), 1);
  assert.equal(await page.locator('.message-user').count(), 1);
  await page.evaluate(() => {
    manager.clearAllMessages();
    const batch = {
      type: 'tool_group',
      tools: [{ name: 'read_file', status: 'Success' }],
    };
    manager.renderResponseState([
      batch,
      batch,
      { type: 'text', text: 'Now checking the exceptions.' },
      batch,
    ]);
  });
  assert.equal(
    await page.locator('.response-active .tool-activity').count(),
    2,
  );
  assert.equal(
    await page.locator('.response-block-text').innerText(),
    'Now checking the exceptions.',
  );
});

test('edit and write calls show accurate line counts and collapsed activity totals', async () => {
  await page.evaluate(() => {
    manager.clearAllMessages();
    const edit = {
      fileName: 'policy.md',
      fileDiff:
        '--- a/policy.md\r\n+++ b/policy.md\r\n@@ -1,2 +1,3 @@\r\n keep\r\n---old\r\n+++new\r\n+extra\r\n\\ No newline at end of file\r\n@@ -10 +11 @@\r\n-before\r\n+after\r\n',
      diffStat: { model_added_lines: 99, model_removed_lines: 99 },
    };
    const write = {
      fileName: 'new.md',
      fileDiff:
        '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+first\n+second\n',
    };
    manager.addHistoryItem({
      type: 'tool_group',
      tools: [
        {
          callId: 'edit',
          name: 'replace',
          status: 'Success',
          description: 'policy.md',
          resultDisplay: edit,
        },
      ],
    });
    manager.addHistoryItem({
      type: 'tool_group',
      tools: [
        {
          callId: 'write',
          name: 'write_file',
          status: 'Success',
          description: 'new.md',
          resultDisplay: write,
        },
      ],
    });
  });
  const summaryStats = page.locator('.tool-activity-summary .tool-diff-stats');
  assert.equal(
    await summaryStats.getAttribute('aria-label'),
    '5 lines added, 2 lines removed',
  );
  assert.equal(await summaryStats.isVisible(), true);
  await page.locator('.tool-activity-summary').click();
  assert.equal(
    await page
      .locator('[data-call-id="edit"] .tool-diff-stats')
      .getAttribute('aria-label'),
    '3 lines added, 2 lines removed',
  );
  assert.equal(
    await page.locator('[data-call-id="write"] .tool-diff-added').innerText(),
    '+2',
  );
  assert.equal(
    await page.locator('[data-call-id="write"] .tool-diff-removed').innerText(),
    '−0',
  );
  assert.equal(
    await page.locator('[data-call-id="edit"] .tool-output').isVisible(),
    false,
  );
  await page.locator('[data-call-id="edit"] .tool-disclosure').click();
  assert.match(
    await page.locator('[data-call-id="edit"] .diff-content').innerText(),
    /---old/,
  );
  await page.setViewportSize({ width: 390, height: 1000 });
  assert.equal(
    await page
      .locator('#messages')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  );
  await page.setViewportSize({ width: 1365, height: 1000 });
});

test('proposed changes stay separate from saved totals and update after success', async () => {
  await page.evaluate(() => {
    manager.clearAllMessages();
    const proposal = {
      type: 'edit',
      fileDiff: '--- old\n+++ new\n@@ -1 +1 @@\n-old\n+new\n',
    };
    window.blocks = [
      {
        type: 'tool_group',
        tools: [
          {
            callId: 'pending-edit',
            name: 'replace',
            status: 'Confirming',
            confirmationDetails: proposal,
          },
          {
            callId: 'failed-edit',
            name: 'write_file',
            status: 'Error',
            resultDisplay: proposal,
          },
          {
            callId: 'canceled-edit',
            name: 'replace',
            status: 'Canceled',
            confirmationDetails: proposal,
          },
          {
            callId: 'plain-tool',
            name: 'run_shell_command',
            status: 'Success',
            resultDisplay: '+not a diff\n-neither is this',
          },
        ],
      },
    ];
    manager.renderResponseState(blocks);
  });
  assert.equal(
    await page.locator('.tool-activity-summary .tool-diff-stats').count(),
    0,
  );
  assert.equal(
    await page
      .locator('[data-call-id="pending-edit"] .tool-diff-stats')
      .getAttribute('aria-label'),
    'Proposed: 1 lines added, 1 lines removed',
  );
  assert.equal(await page.locator('.tool-diff-stats').count(), 1);
  await page.evaluate(() => {
    blocks[0].tools[0] = {
      ...blocks[0].tools[0],
      status: 'Success',
      resultDisplay: {
        diffStat: { model_added_lines: 7, model_removed_lines: 2 },
      },
    };
    manager.renderResponseState(blocks);
    manager.renderResponseState(blocks);
  });
  assert.equal(
    await page
      .locator('.tool-activity-summary .tool-diff-stats')
      .getAttribute('aria-label'),
    '7 lines added, 2 lines removed',
  );
  assert.equal(await page.locator('.tool-diff-proposed').count(), 0);
  assert.equal(await page.locator('.tool-diff-stats').count(), 2);
});

test('failures remain visible while collapsed and approval opens the relevant call', async () => {
  await seed();
  await page.evaluate(() => {
    tools[1] = {
      ...tools[1],
      status: 'Error',
      resultDisplay: 'Index unavailable',
    };
    manager.renderResponseState(blocks);
  });
  assert.match(
    await page.locator('.response-active summary').innerText(),
    /1 failed/,
  );
  await page.evaluate(() => {
    tools.push({
      callId: 'approval',
      name: 'run_shell_command',
      status: 'Confirming',
      description: 'npm run check',
    });
    manager.renderResponseState(blocks);
  });
  assert.match(
    await page.locator('.response-active summary').innerText(),
    /Approval needed/,
  );
  assert.equal(
    await page
      .locator('[data-call-id="approval"] .tool-disclosure')
      .getAttribute('aria-expanded'),
    'true',
  );
});

test('reader can scroll away during streaming and resume following at the bottom', async () => {
  await seed();
  await page.evaluate(() => {
    blocks.push({
      type: 'text',
      text: 'A paragraph of audit evidence.\n\n'.repeat(90),
    });
    manager.renderResponseState(blocks);
  });
  await page.locator('#messages').evaluate((el) => (el.scrollTop = 0));
  await page.waitForFunction(() => !manager._followingLatest);
  await page.evaluate(() => {
    blocks[1].text += 'More evidence.';
    manager.renderResponseState(blocks);
  });
  assert.equal(
    await page.locator('#messages').evaluate((el) => el.scrollTop),
    0,
  );
  await page
    .locator('#messages')
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForFunction(() => manager._followingLatest);
});

test('conversation renders across themes and narrow layouts without horizontal overflow', async () => {
  await seed();
  await page.evaluate(() => {
    tools[1].status = 'Success';
    tools[1].resultDisplay = 'Found 4 relevant documents.';
    manager.addHistoryItem({ type: 'tool_group', tools });
    manager.renderResponseState(null);
    manager.addHistoryItem({
      type: 'gemini',
      text: 'Start with **privileged access** and **quarterly access reviews**. These have the clearest evidence requirements.\n\n### Priority controls\n\n| Control | Evidence to request |\n| --- | --- |\n| Access approval | Approved requests and role assignments |\n| Periodic review | Latest review and follow-up records |\n\nCompare a sample of active accounts against the approved access list. Record any exceptions and confirm how they were resolved.\n\n```sql\nSELECT account_id, role, approved_by\nFROM access_register\nWHERE privileged = true;\n```',
    });
    document.querySelector('#messages').scrollTop = 0;
  });
  const screenshotDir = process.env.CHAT_SCREENSHOT_DIR;
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const theme of [
    'calm-light',
    'calm-dark',
    'studio-light',
    'studio-dark',
    'neon-light',
    'neon-dark',
    'forest-light',
    'forest-dark',
  ]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const width of [1365, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page
          .locator('#messages')
          .evaluate(
            (el) => el.getBoundingClientRect().right <= window.innerWidth,
          ),
        true,
        `conversation fits viewport: ${theme} at ${width}px`,
      );
      assert.equal(
        await page
          .locator('#messages')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
        `${theme} at ${width}px`,
      );
      if (screenshotDir)
        await page.screenshot({
          path: resolve(screenshotDir, `${theme}-${width}.png`),
        });
      if (screenshotDir && width === 1365 && theme.startsWith('calm-')) {
        await page.locator('.message-tool_group summary').click();
        await page.locator('[data-call-id="read-1"] .tool-disclosure').click();
        await page.screenshot({
          path: resolve(screenshotDir, `${theme}-expanded.png`),
        });
        await page.locator('[data-call-id="read-1"] .tool-disclosure').click();
        await page.locator('.message-tool_group summary').click();
      }
    }
  }
  assert.deepEqual(errors, []);
});
