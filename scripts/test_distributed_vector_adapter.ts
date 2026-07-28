import { DistributedStateAdapter } from '../src/modules';

async function testDistributedVectorAdapter() {
  console.log('========================================================================');
  console.log('--- DISTRIBUTED LOCK & HNSW VECTOR EMBEDDING ADAPTER VERIFICATION ---');
  console.log('========================================================================');

  const adapter = new DistributedStateAdapter();

  // 1. Test Distributed Lock
  console.log('\n[Part 1] Testing Multi-Node Distributed Lock Acquisition...');
  const acquired1 = await adapter.acquireLock('session_lock_100', 2000);
  const acquired2 = await adapter.acquireLock('session_lock_100', 2000);
  console.log('  Lock 1 Acquisition Result:', acquired1);
  console.log('  Lock 2 Contention Result:', acquired2);

  // 2. Test Dense Vector Cosine Similarity Search
  console.log('\n[Part 2] Testing Dense Vector Cosine Similarity Indexing & Search...');
  adapter.indexVectorNode('v1', [0.1, 0.8, 0.9], 'Hypersonic AI Engine Spec', { category: 'arch' });
  adapter.indexVectorNode('v2', [0.9, 0.1, 0.1], 'Recipe for French Toast', { category: 'food' });

  const queryVec = [0.1, 0.7, 0.85];
  const results = adapter.searchVectorIndex(queryVec, 2);

  console.log(`  Query Vector Search returned ${results.length} node(s):`);
  for (const r of results) {
    console.log(`    - Node [${r.node.id}] "${r.node.text}" (Cosine Score: ${r.score.toFixed(4)})`);
  }

  if (acquired1 && !acquired2 && results[0].node.id === 'v1' && results[0].score > 0.95) {
    console.log('\n========================================================================');
    console.log('--- DISTRIBUTED LOCK & VECTOR MEMORY ADAPTER VERIFIED (100% SUCCESS) ---');
    console.log('========================================================================');
  } else {
    console.error('FAIL: Distributed vector adapter test did not pass requirements.');
  }
}

testDistributedVectorAdapter().catch(console.error);
