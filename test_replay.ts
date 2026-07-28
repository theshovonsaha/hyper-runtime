import { EventStore } from './src/store/events';
import { rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

async function testReplay() {
  console.log("==== STARTING EVENT LOG REPLAY TEST ====\n");
  const testDir = join(import.meta.dir, '.test_data');
  const store = new EventStore(testDir);
  const runId = 'test-run-' + Date.now();

  const log = store.openLog(runId);

  // Generate 50 synthetic events
  for (let i = 0; i < 50; i++) {
    log.emit('model.request' as any, { payload_index: i, str: "hello" }, { summary: `test event ${i}` });
  }

  // Load events
  const loaded = store.loadEvents(runId);
  const active = log.getEvents();

  let pass = true;

  if (loaded.length !== 50) {
    console.error(`[FAIL] Expected 50 events loaded, got ${loaded.length}`);
    pass = false;
  }

  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(loaded[i]) !== JSON.stringify(active[i])) {
      console.error(`[FAIL] Event mismatch at index ${i}`);
      pass = false;
      break;
    }
  }

  if (pass) {
    console.log("[PASS] 50 events written to .jsonl and read back with exact structural parity.");
  }

  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
  console.log("\n==== TEST COMPLETE ====");
}

testReplay().catch(console.error);
