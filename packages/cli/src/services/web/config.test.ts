/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createTestLogger } from '../../test-utils/webTestSupport.js';
import {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  WEB_HOST_ENV_VAR,
  isValidPort,
  resolveListenTarget,
} from './config.js';

describe('resolveListenTarget', () => {
  it('falls back to the defaults', () => {
    expect(resolveListenTarget({}, {})).toEqual({
      port: DEFAULT_WEB_PORT,
      host: DEFAULT_WEB_HOST,
    });
  });

  it('prefers explicit config over the environment', () => {
    const env = { [WEB_HOST_ENV_VAR]: '0.0.0.0' };
    expect(resolveListenTarget({ port: 9000, host: 'localhost' }, env)).toEqual(
      { port: 9000, host: 'localhost' },
    );
    expect(resolveListenTarget({}, env).host).toBe('0.0.0.0');
  });

  it('treats port 0 as "use the default"', () => {
    expect(resolveListenTarget({ port: 0 }, {}).port).toBe(DEFAULT_WEB_PORT);
  });

  it('replaces an invalid port with the default and warns', () => {
    const logger = createTestLogger();
    expect(resolveListenTarget({ port: 70000 }, {}, logger).port).toBe(
      DEFAULT_WEB_PORT,
    );
    expect(resolveListenTarget({ port: Number.NaN }, {}, logger).port).toBe(
      DEFAULT_WEB_PORT,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('isValidPort', () => {
  it('accepts integers within the TCP range only', () => {
    expect(isValidPort(8629)).toBe(true);
    expect(isValidPort(0)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(80.5)).toBe(false);
    expect(isValidPort('80')).toBe(false);
  });
});
