import {
  ContextDriftHealer,
  BranchManager,
  computeAttribution,
  evaluateScorecard,
  MockProvider,
} from '../src/modules';

async function verifyModularExports() {
  console.log('===========================================================');
  console.log('--- HYPER-RUNTIME STANDALONE MODULE EXPORTS VERIFICATION ---');
  console.log('===========================================================');

  // 1. Test Standalone Context Drift Healer Module
  console.log('\n[Module 1: Drift Healer] Testing standalone ContextDriftHealer...');
  const healer = new ContextDriftHealer();
  const healRes = healer.healContext([], 'Invalid tool argument schema: JSON parse error');
  console.log('  Heal Action:', healRes.actionTaken);
  console.log('  Log Summary:', healRes.logSummary);

  // 2. Test Standalone Branch Manager Module
  console.log('\n[Module 2: Branch Manager] Testing standalone BranchManager...');
  const branchMgr = new BranchManager();
  const branch = branchMgr.createBranch('parent-run-100', 2, 'Forking for alternative prompt experiment');
  console.log('  Created Branch ID:', branch.branchId);
  console.log('  Parent Run ID:', branch.parentRunId);

  // 3. Test Standalone Attribution Engine Module
  console.log('\n[Module 3: Attribution Engine] Testing standalone computeAttribution...');
  const attribution = computeAttribution('run-999', 'The total calculation resulted in 100.', [
    { id: 'ctx-1', kind: 'user', title: 'User Input', text: 'Calculate 25 * 4', source_ref: 'msg-1', reason: 'input', included: true, pinned: true, edited: false, partial: false, chars: 15 }
  ] as any);
  console.log('  Attribution Report Items Evaluated:', attribution.totalItemsEvaluated);

  // 4. Test Standalone Scorecard Evaluator Module
  console.log('\n[Module 4: Scorecard Evaluator] Testing standalone evaluateScorecard...');
  const scorecard = evaluateScorecard({
    runId: 'run-888',
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 50,
    toolCalls: [{ name: 'calculator', success: true }],
  });
  console.log('  Scorecard Rating:', scorecard.rating, `(${scorecard.score}/100)`);

  // 5. Test Standalone MockProvider Module
  console.log('\n[Module 5: Provider Router] Testing standalone MockProvider...');
  const provider = new MockProvider('mock-standalone');
  const turn = await provider.complete([{ role: 'user', content: 'Hello world' }]);
  console.log('  Provider Response:', turn.text);

  console.log('\n===========================================================');
  console.log('--- ALL STANDALONE MODULE EXPORT VERIFICATION TESTS PASSED ---');
  console.log('===========================================================');
}

verifyModularExports().catch(console.error);
