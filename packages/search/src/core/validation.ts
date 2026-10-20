/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/** Validation at JSON, IPC and database boundaries. */
export type Guard<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString = (value: unknown): value is string =>
  typeof value === 'string';
export const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
export const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';
export const isUnknown = (_value: unknown): _value is unknown => true;

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

export function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value);
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

export function allOf<A, B>(a: Guard<A>, b: Guard<B>): Guard<A & B> {
  return (value): value is A & B => a(value) && b(value);
}

export function anyOf<T extends ReadonlyArray<Guard<unknown>>>(
  ...guards: T
): Guard<T[number] extends Guard<infer U> ? U : never> {
  return (value): value is T[number] extends Guard<infer U> ? U : never =>
    guards.some((guard) => guard(value));
}

export const isDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

export function oneOf<const T extends string>(...values: T[]): Guard<T> {
  const allowed = new Set<string>(values);
  return (value): value is T => typeof value === 'string' && allowed.has(value);
}

export function objectOf<T extends object>(shape: {
  [K in keyof T]-?: Guard<T[K]>;
}): Guard<T> {
  const fields: Record<string, Guard<unknown>> = shape;
  return (value): value is T =>
    isRecord(value) &&
    Object.entries(fields).every(([key, guard]) => guard(value[key]));
}

export function read<T>(value: unknown, guard: Guard<T>, context = 'value'): T {
  if (!guard(value)) throw new TypeError(`Invalid ${context}`);
  return value;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function readJsonRecord(text: string): Record<string, unknown> {
  return read(parseJson(text), isRecord, 'JSON object');
}

export function readJsonStrings(text: string): string[] {
  return read(parseJson(text), arrayOf(isString), 'JSON string array');
}

export function getProperty(value: unknown, key: PropertyKey): unknown {
  return isRecord(value) && typeof key === 'string' ? value[key] : undefined;
}

export const isDocumentStatus = oneOf(
  'pending',
  'parsing',
  'chunking',
  'embedding',
  'indexed',
  'failed',
);
export const isOcrStatus = oneOf(
  'not_needed',
  'pending',
  'processing',
  'completed',
  'failed',
  'skipped',
);
export const isQueuePriority = oneOf(
  'text',
  'markup',
  'pdf',
  'image',
  'ocr',
  'deferred',
);
export const isQueueStatus = oneOf(
  'pending',
  'processing',
  'completed',
  'failed',
);
export const isMatchType = oneOf('semantic', 'keyword', 'hybrid');
