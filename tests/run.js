#!/usr/bin/env node
'use strict';

/**
 * Node entry point for the test suite: `node tests/run.js`.
 *
 * The browser equivalent is tests/index.html, which loads the same harness and
 * the same test files. Keep the list below in sync with both.
 */

const harness = require('./harness.js');

const TEST_FILES = ['./contribution-parser.test.js'];

TEST_FILES.forEach((file) => require(file));

const result = harness.run();

result.failures.forEach((failure) => {
  console.error('FAIL  ' + failure.name);
  console.error(
    failure.message
      .split('\n')
      .map((line) => '      ' + line)
      .join('\n')
  );
  console.error('');
});

console.log(result.passed + ' passed, ' + result.failed + ' failed, ' + result.total + ' total');

process.exit(result.failed === 0 ? 0 : 1);
