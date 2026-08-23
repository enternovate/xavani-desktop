'use strict';

// Semver compare extracted from src/main.js — keep in sync.
function isNewer(remote, local) {
  const parse = (s) => String(s).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b, c] = parse(remote);
  const [x, y, z] = parse(local);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}

const assert = require('node:assert');
assert.equal(isNewer('1.0.0', '0.9.9'), true);
assert.equal(isNewer('0.4.0', '0.4.0'), false);
assert.equal(isNewer('v0.5.0', '0.4.10'), true);
assert.equal(isNewer('0.4.0', '0.5.0'), false);
assert.equal(isNewer('garbage', '0.4.0'), false);
assert.equal(isNewer('0.4.1', '0.4.0'), true);
console.log('semver tests: 6 passed');

// main.js must contain the same compare logic.
const main = require('fs').readFileSync(
  require('path').join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
for (const marker of ['isNewer', 'releases/latest', 'UPDATE_INTERVAL_MS']) {
  assert.ok(main.includes(marker), `main.js missing ${marker}`);
}
console.log('main.js markers: ok');
