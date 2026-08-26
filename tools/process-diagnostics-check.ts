import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedProcessCapability, type ProcessArgs } from '@hyper/capabilities';
import type { ActionProposal, CapabilityGrant } from '@hyper/contracts';

const root = mkdtempSync(join(tmpdir(), 'hyper-process-diagnostics-'));
try {
  const capability = new BoundedProcessCapability(root, {
    allowedExecutables: [process.execPath],
    environment: { PATH: process.env.PATH ?? '' },
    maxOutputBytes: 64,
  });
  const proposal: ActionProposal<ProcessArgs> = {
    id: 'proposal:release-process-diagnostic', intentId: 'intent:release-check',
    principalId: 'agent:release-check', conditionIds: [], capabilityId: capability.manifest.id,
    target: 'workspace/', declaredEffects: ['process.execute', 'state.read'], risk: 2,
    expectedEvidence: ['process_diagnostic'], idempotencyKey: 'release:process-diagnostic',
    args: {
      executable: process.execPath,
      arguments: ['-e', `process.stderr.write('DIAGNOSTIC_PROCESS_FAILURE:${'X'.repeat(120)}\\n'); process.exit(7)`],
      expectedExitCode: 0,
    },
  };
  const grant: CapabilityGrant = {
    id: 'grant:release-process-diagnostic', proposalId: proposal.id, decisionId: 'decision:release-check',
    principalId: proposal.principalId, capabilityId: proposal.capabilityId, target: proposal.target,
    effects: proposal.declaredEffects, maxRisk: 2, expiresAt: '2999-01-01T00:00:00.000Z',
  };

  const execution = await capability.execute(proposal, grant);
  const observation = await capability.observe(proposal);
  const value = observation.value as {
    exitCode: number; stderr: string; timedOut: boolean;
    stderrBytesCaptured: number; stderrTruncated: boolean;
  };
  if (execution.success || execution.errorCode !== 'UNEXPECTED_EXIT_CODE') {
    throw new Error(`Expected a known nonzero exit, received ${JSON.stringify(execution)}`);
  }
  if (!execution.failureObservationAvailable || value.exitCode !== 7 || value.timedOut) {
    throw new Error(`Failed process result was not observable: ${JSON.stringify(observation)}`);
  }
  if (
    !value.stderr.startsWith('DIAGNOSTIC_PROCESS_FAILURE:')
    || value.stderrBytesCaptured > 64
    || !value.stderrTruncated
  ) {
    throw new Error(`Process diagnostics were missing or unbounded: ${JSON.stringify(value)}`);
  }
  const executableSchema = capability.manifest.inputSchema?.properties?.executable;
  if (JSON.stringify(executableSchema?.enum) !== JSON.stringify([process.execPath])) {
    throw new Error('The model-facing executable schema does not match the runtime allowlist.');
  }
  console.log('process diagnostics check passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
