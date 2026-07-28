import { UnderstandingLayer, AwarenessEngine } from '../src/modules';

async function testUnderstandingAndAwareness() {
  console.log('========================================================================');
  console.log('--- SYSTEM UNDERSTANDING & ENVIRONMENT AWARENESS VERIFICATION ---');
  console.log('========================================================================');

  // 1. Test System Understanding Layer
  console.log('\n[Part 1] Testing Semantic Understanding Layer...');
  const understanding = new UnderstandingLayer();
  const analysis1 = understanding.analyzePrompt('Fetch stock quote for $NVDA and write summary');
  console.log('  Prompt 1 Intent Category:', analysis1.intentCategory);
  console.log('  Extracted Entities:', analysis1.extractedEntities);

  const analysis2 = understanding.analyzePrompt('Orchestrate multi-agent team to audit security');
  console.log('  Prompt 2 Recommended Path:', analysis2.recommendedExecutionPath);

  // 2. Test Environment Awareness Engine
  console.log('\n[Part 2] Testing Real-Time Environment Awareness Engine...');
  const awareness = new AwarenessEngine();
  const promptText = awareness.renderAwarenessPrompt();
  console.log('  Rendered Awareness Prompt:\n' + promptText);

  if (analysis1.extractedEntities.ticker === 'NVDA' && promptText.includes('[ENVIRONMENT AWARENESS]')) {
    console.log('\n========================================================================');
    console.log('--- ALL UNDERSTANDING & AWARENESS VERIFICATION TESTS PASSED ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Understanding and awareness tests did not pass expectations.');
  }
}

testUnderstandingAndAwareness().catch(console.error);
