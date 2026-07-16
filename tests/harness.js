'use strict';

/**
 * A minimal test harness, deliberately dependency-free.
 *
 * The project has no package.json and no build step by design, so the tests
 * follow the same rule: they run under `node tests/run.js` in CI and by opening
 * tests/index.html in a browser, with nothing to install either way.
 *
 * Tests register themselves against this shared singleton; both runners then
 * call run().
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TestHarness = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const tests = [];
  let suite = null;

  function describe(name, fn) {
    const previous = suite;
    suite = previous ? previous + ' > ' + name : name;
    fn();
    suite = previous;
  }

  function it(name, fn) {
    tests.push({ name: suite ? suite + ' > ' + name : name, fn: fn });
  }

  class AssertionError extends Error {
    constructor(message) {
      super(message);
      this.name = 'AssertionError';
    }
  }

  function stringify(value) {
    if (typeof value === 'string') return JSON.stringify(value);
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  const assert = {
    ok: function (value, message) {
      if (!value) throw new AssertionError(message || 'Expected a truthy value, got ' + stringify(value));
    },

    equal: function (actual, expected, message) {
      if (actual !== expected) {
        throw new AssertionError((message || 'Values differ') + '\n  expected: ' + stringify(expected) + '\n  actual:   ' + stringify(actual));
      }
    },

    deepEqual: function (actual, expected, message) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) {
        throw new AssertionError((message || 'Structures differ') + '\n  expected: ' + b + '\n  actual:   ' + a);
      }
    },

    /** Asserts fn() throws, optionally that the message matches a pattern. */
    throws: function (fn, pattern, message) {
      let thrown = null;
      try {
        fn();
      } catch (error) {
        thrown = error;
      }

      if (!thrown) throw new AssertionError(message || 'Expected the call to throw, but it returned normally.');
      if (pattern && !pattern.test(thrown.message)) {
        throw new AssertionError((message || 'Wrong error') + '\n  expected message matching: ' + pattern + '\n  actual message:           ' + stringify(thrown.message));
      }
      return thrown;
    },

    /** Asserts a string does NOT contain any of the given substrings. */
    excludes: function (haystack, needles, message) {
      needles.forEach(function (needle) {
        if (String(haystack).indexOf(needle) !== -1) {
          throw new AssertionError((message || 'Found forbidden substring') + '\n  ' + stringify(needle) + ' must not appear in ' + stringify(haystack));
        }
      });
    },
  };

  /** Runs every registered test. Returns a result summary; never throws. */
  function run() {
    const failures = [];
    let passed = 0;

    tests.forEach(function (test) {
      try {
        test.fn();
        passed += 1;
      } catch (error) {
        failures.push({ name: test.name, message: error.message, stack: error.stack });
      }
    });

    return { total: tests.length, passed: passed, failed: failures.length, failures: failures };
  }

  return { AssertionError: AssertionError, assert: assert, describe: describe, it: it, run: run, tests: tests };
});
