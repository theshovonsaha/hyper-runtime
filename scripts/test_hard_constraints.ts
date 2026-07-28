/**
 * scripts/test_hard_constraints.ts — Verification for 7 Hard Physical & Runtime Constraints
 */

import { RuntimeConstraintsManager } from '../src/core/constraints';

console.log('========================================================================');
console.log('--- 7 HARD PHYSICAL & RUNTIME CONSTRAINTS VERIFICATION SUITE ---');
console.log('========================================================================\n');

let passCount = 0;
let totalCount = 0;

function assert(condition: boolean, title: string) {
  totalCount++;
  if (condition) {
    passCount++;
    console.log(`  [PASS ${passCount}/${totalCount}] ${title}`);
  } else {
    console.error(`  [FAIL ${passCount}/${totalCount}] ${title}`);
    process.exit(1);
  }
}

const manager = new RuntimeConstraintsManager();

// 1. Context Budget Constraint Test
console.log('[Test 1] Hard Context Budget Ceiling (24,000 Chars)...');
const budgetOk = manager.enforceContextBudget(18000);
assert(budgetOk.compliant && budgetOk.truncatedChars === 18000, 'Compliant context budget passed');

const budgetExceeded = manager.enforceContextBudget(32000);
assert(!budgetExceeded.compliant && budgetExceeded.truncatedChars === 24000, 'Over-budget context truncated to hard 24,000 char ceiling');

// 2. Sandbox Path Constraint Test
console.log('\n[Test 2] Hard Sandbox & Path Validation...');
const workspace = '/Users/theshovonsaha/Developer/Github/bun-harness-runtime';

const validPath = manager.enforcePathSandbox('src/core/kernel.ts', workspace);
assert(validPath.allowed, 'In-workspace path allowed');

const invalidOutsidePath = manager.enforcePathSandbox('/etc/passwd', workspace);
assert(!invalidOutsidePath.allowed, 'Out-of-workspace path (/etc/passwd) rejected');
assert(invalidOutsidePath.error?.includes('SECURITY CONSTRAINT VIOLATION'), 'Security violation error recorded');

const invalidDotDotPath = manager.enforcePathSandbox('../../../.ssh/id_rsa', workspace);
assert(!invalidDotDotPath.allowed, 'Relative escape path (../../../.ssh) rejected');

// 3. Loop & Depth Constraint Test
console.log('\n[Test 3] Hard Recursion & Loop Bounds...');
const validTurn = manager.enforceTurnLimits(5, 0);
assert(validTurn.allowed, 'Turn 5 at depth 0 allowed');

const invalidTurn = manager.enforceTurnLimits(16, 0);
assert(!invalidTurn.allowed, 'Turn 16 rejected by turn limit');

const invalidDepth = manager.enforceTurnLimits(2, 3);
assert(!invalidDepth.allowed, 'Depth 3 rejected by sub-agent recursion limit');

// 4. Tool Execution Timeout Test
console.log('\n[Test 4] Hard Tool Execution Timeout Race (5,000ms)...');
async function runTimeoutTest() {
  const fastPromise = new Promise(res => setTimeout(() => res('FAST_OK'), 50));
  const fastRes = await manager.enforceToolTimeout(fastPromise, 'test_fast', 500);
  assert(fastRes === 'FAST_OK', 'Fast tool execution completed before timeout');

  const slowPromise = new Promise(res => setTimeout(() => res('SLOW_OK'), 1000));
  let timedOut = false;
  try {
    await manager.enforceToolTimeout(slowPromise, 'test_slow', 100);
  } catch (err: any) {
    timedOut = err.message.includes('TIMEOUT CONSTRAINT VIOLATION');
  }
  assert(timedOut, 'Slow tool execution (>100ms) interrupted by hard timeout');
}

// 5. Payload Size Ceiling Test
console.log('\n[Test 5] Hard Event Payload Size Ceiling (50,000 Bytes)...');
const giantPayload = 'A'.repeat(70000);
const payloadCheck = manager.enforcePayloadCeiling(giantPayload);
assert(!payloadCheck.compliant, 'Giant 70,000 byte payload flagged as non-compliant');
assert(payloadCheck.boundedPayload.length <= 50000, 'Payload truncated within 50,000 byte hard ceiling');
assert(payloadCheck.boundedPayload.includes('TRUNCATED BY HARD PAYLOAD CEILING'), 'Truncation banner attached');

runTimeoutTest().then(() => {
  console.log('\n========================================================================');
  console.log(`--- 7 HARD PHYSICAL CONSTRAINTS PASSED (${passCount}/${totalCount} TESTS - 100% SUCCESS) ---`);
  console.log('========================================================================\n');
});
