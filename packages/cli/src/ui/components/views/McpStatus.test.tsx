/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '../../../test-utils/render.js';
import { describe, it, expect, vi } from 'vitest';
import { McpStatus } from './McpStatus.js';
import { MCPServerStatus } from '@thacio/auditaria-cli-core';
import { MessageType } from '../../types.js';

describe('McpStatus', () => {
  const baseProps = {
    type: MessageType.MCP_STATUS,
    servers: {
      'server-1': {
        url: 'http://localhost:8080',
        name: 'server-1',
        description: 'A test server',
      },
    },
    tools: [
      {
        serverName: 'server-1',
        name: 'tool-1',
        description: 'A test tool',
        schema: {
          parameters: {
            type: 'object',
            properties: {
              param1: { type: 'string' },
            },
          },
        },
      },
    ],
    prompts: [],
    blockedServers: [],
    serverStatus: () => MCPServerStatus.CONNECTED,
    authStatus: {},
    discoveryInProgress: false,
    connectingServers: [],
    showDescriptions: true,
    showSchema: false,
  };

  it('renders correctly with a connected server', () => {
    const { lastFrame, unmount } = render(<McpStatus {...baseProps} />);
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with authenticated OAuth status', () => {
    const { lastFrame, unmount } = render(
      <McpStatus {...baseProps} authStatus={{ 'server-1': 'authenticated' }} />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with expired OAuth status', () => {
    const { lastFrame, unmount } = render(
      <McpStatus {...baseProps} authStatus={{ 'server-1': 'expired' }} />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with unauthenticated OAuth status', () => {
    const { lastFrame, unmount } = render(
      <McpStatus
        {...baseProps}
        authStatus={{ 'server-1': 'unauthenticated' }}
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with a disconnected server', async () => {
    vi.spyOn(
      await import('@thacio/auditaria-cli-core'),
      'getMCPServerStatus',
    ).mockReturnValue(MCPServerStatus.DISCONNECTED);
    const { lastFrame, unmount } = render(<McpStatus {...baseProps} />);
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly when discovery is in progress', () => {
    const { lastFrame, unmount } = render(
      <McpStatus {...baseProps} discoveryInProgress={true} />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with schema enabled', () => {
    const { lastFrame, unmount } = render(
      <McpStatus {...baseProps} showSchema={true} />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with parametersJsonSchema', () => {
    const { lastFrame, unmount } = render(
      <McpStatus
        {...baseProps}
        tools={[
          {
            serverName: 'server-1',
            name: 'tool-1',
            description: 'A test tool',
            schema: {
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  param1: { type: 'string' },
                },
              },
            },
          },
        ]}
        showSchema={true}
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with prompts', () => {
    const { lastFrame, unmount } = render(
      <McpStatus
        {...baseProps}
        prompts={[
          {
            serverName: 'server-1',
            name: 'prompt-1',
            description: 'A test prompt',
          },
        ]}
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with a blocked server', () => {
    const { lastFrame, unmount } = render(
      <McpStatus
        {...baseProps}
        blockedServers={[{ name: 'server-1', extensionName: 'test-extension' }]}
      />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  it('renders correctly with a connecting server', () => {
    const { lastFrame, unmount } = render(
      <McpStatus {...baseProps} connectingServers={['server-1']} />,
    );
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });
});
