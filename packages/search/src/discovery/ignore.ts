/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import ignoreFactory, { type Ignore } from 'ignore';

/** Handle the package's CommonJS and ESM export shapes in both runtimes. */
export function createIgnore(): Ignore {
  const imported: unknown = ignoreFactory;
  const factory =
    imported !== null && typeof imported === 'object' && 'default' in imported
      ? imported.default
      : imported;
  if (typeof factory !== 'function')
    throw new Error('ignore module not properly loaded');
  const instance: unknown = factory();
  if (!isIgnore(instance)) throw new Error('Invalid ignore implementation');
  return instance;
}

function isIgnore(value: unknown): value is Ignore {
  return (
    value !== null &&
    typeof value === 'object' &&
    'add' in value &&
    typeof value.add === 'function' &&
    'filter' in value &&
    typeof value.filter === 'function' &&
    'createFilter' in value &&
    typeof value.createFilter === 'function' &&
    'ignores' in value &&
    typeof value.ignores === 'function' &&
    'test' in value &&
    typeof value.test === 'function'
  );
}
