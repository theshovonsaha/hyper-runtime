import { DynamicIntermediatePacketPipeline } from '../src/modules';

async function testIntermediatePacketReassembly() {
  console.log('========================================================================');
  console.log('--- DYNAMIC INTERMEDIATE PACKET & PHASE REASSEMBLY VERIFICATION ---');
  console.log('========================================================================');

  const pipeline = new DynamicIntermediatePacketPipeline();

  // 1. Step 1: Raw Web Search Tool Output (10,000 words)
  console.log('\n[Step 1] Intercepting Raw Web Search Output & Creating Intermediate Envelope...');
  const rawWebOutput = 'Raw Scraping Output line line line line.\n'.repeat(100);
  const env1 = pipeline.createIntermediateEnvelope(1, 'tool_loop', 'research_workspace', rawWebOutput);

  console.log('  Intermediate Envelope ID:', env1.rawOutputArchivedId);
  console.log('  Succinct Summary:', env1.succinctSummary);

  // 2. Re-assemble Context for 'tool_loop' Pass
  console.log('\n[Step 2] Dynamically Re-assembling Context for TOOL_LOOP Pass...');
  const toolLoopItems = pipeline.reassembleForPhase('tool_loop', []);
  console.log('  Reassembled Items Count:', toolLoopItems.length);
  console.log('  Packet Title:', toolLoopItems[0].title);
  console.log('  Packet Text Content:\n' + toolLoopItems[0].text);

  // 3. Re-assemble Context for 'verify' Pass
  console.log('\n[Step 3] Dynamically Re-assembling Context for VERIFY Pass...');
  const verifyItems = pipeline.reassembleForPhase('verify', []);
  console.log('  Reassembled Items Count:', verifyItems.length);
  console.log('  Packet Title:', verifyItems[0].title);

  if (env1.succinctSummary && toolLoopItems.length === 1 && verifyItems.length === 1) {
    console.log('\n========================================================================');
    console.log('--- DYNAMIC INTERMEDIATE PACKET REASSEMBLY VERIFIED (100% SUCCESS) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Intermediate packet reassembly test failed.');
  }
}

testIntermediatePacketReassembly().catch(console.error);
