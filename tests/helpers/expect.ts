/**
 * The slice of vitest's `expect` that the telemetry-platform tests use, on
 * top of node:test and node:assert, so they run under `npm test` with the
 * rest of the suite instead of needing vitest installed.
 */
import assert from 'node:assert/strict';

export { describe, it } from 'node:test';

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, message: string) => {
    if (pass === negate) assert.fail(negate ? `not: ${message}` : message);
  };
  const show = (v: unknown) => {
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const deepEqual = (a: unknown, b: unknown) => {
    try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
  };
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `expected ${show(actual)} to be ${show(expected)}`),
    toEqual: (expected: unknown) => check(deepEqual(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`),
    toBeNull: () => check(actual === null, `expected ${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `expected ${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, 'expected value to be defined'),
    toBeGreaterThan: (n: number) => check((actual as number) > n, `expected ${show(actual)} to be greater than ${n}`),
    toHaveLength: (n: number) => check((actual as { length: number })?.length === n, `expected length ${(actual as { length: number })?.length} to be ${n}`),
    toContain: (item: unknown) => check(
      typeof actual === 'string' ? actual.includes(item as string) : Array.isArray(actual) && actual.includes(item),
      `expected ${show(actual)} to contain ${show(item)}`,
    ),
    // vitest's default: |actual - expected| < 10^-digits / 2
    toBeCloseTo: (expected: number, digits = 2) => check(
      Math.abs((actual as number) - expected) < Math.pow(10, -digits) / 2,
      `expected ${show(actual)} to be close to ${expected} (${digits} digits)`,
    ),
    toThrow: (pattern?: string | RegExp) => {
      let threw = false;
      let message = '';
      try { (actual as () => unknown)(); } catch (e) { threw = true; message = e instanceof Error ? e.message : String(e); }
      const matches = threw && (pattern === undefined || (typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message)));
      check(matches, threw ? `threw "${message}", expected ${String(pattern)}` : 'expected function to throw');
    },
  };
}

export function expect(actual: unknown) {
  return Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
    rejects: {
      toThrow: async (pattern?: string | RegExp) => {
        await assert.rejects(actual as Promise<unknown>, (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          return pattern === undefined || (typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message));
        });
      },
    },
  });
}
