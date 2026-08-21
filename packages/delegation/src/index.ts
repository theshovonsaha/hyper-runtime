import type {
  ContextSource,
  DelegationBudget,
  DelegationContract,
  DelegationDecision,
  DelegationReceipt,
  DelegationResult,
  IntentContract,
  JsonSchema,
  ReceiptAttestation,
  StructuredFailure,
} from '@hyper/contracts';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export interface DelegationPolicyInput {
  parentIntent: IntentContract;
  contract: DelegationContract;
  availableContextIds: string[];
  remainingBudget: DelegationBudget;
}

export interface ChildRuntimeRequest {
  contract: DelegationContract;
  childIntent: IntentContract;
  context: ContextSource[];
  signal: AbortSignal;
}

export interface ChildRuntimeExecutor {
  run(request: ChildRuntimeRequest): Promise<DelegationResult>;
}

export interface DelegationEventSink {
  append(runId: string, type: string, payload: Record<string, unknown>): { hash: string };
}

export interface ExecuteDelegationInput
  extends Omit<DelegationPolicyInput, 'availableContextIds'> {
  parentContext: ContextSource[];
  executor: ChildRuntimeExecutor;
  events?: DelegationEventSink;
  budgetPool?: DelegationBudgetPool;
  receiptKeyring?: Readonly<Record<string, string>>;
}

export interface BudgetReservation {
  id: string;
  budget: DelegationBudget;
}

export class DelegationBudgetPool {
  private available: DelegationBudget;
  private readonly reservations = new Map<string, DelegationBudget>();

  constructor(total: DelegationBudget) {
    if (!budgetValid(total)) throw new Error('Delegation budget pool requires a positive integer budget.');
    this.available = structuredClone(total);
  }

  reserve(id: string, budget: DelegationBudget): { accepted: boolean; reasonCodes: string[] } {
    if (!id || this.reservations.has(id)) return { accepted: false, reasonCodes: ['BUDGET_RESERVATION_ID_CONFLICT'] };
    if (!budgetValid(budget)) return { accepted: false, reasonCodes: ['DELEGATION_BUDGET_INVALID'] };
    const reasons = [
      ...(budget.tokenBudget > this.available.tokenBudget ? ['TOKEN_BUDGET_NOT_AVAILABLE'] : []),
      ...(budget.actionBudget > this.available.actionBudget ? ['ACTION_BUDGET_NOT_AVAILABLE'] : []),
      ...(budget.wallTimeMs > this.available.wallTimeMs ? ['TIME_BUDGET_NOT_AVAILABLE'] : []),
    ];
    if (reasons.length > 0) return { accepted: false, reasonCodes: reasons };
    this.available.tokenBudget -= budget.tokenBudget;
    this.available.actionBudget -= budget.actionBudget;
    this.available.wallTimeMs -= budget.wallTimeMs;
    this.reservations.set(id, structuredClone(budget));
    return { accepted: true, reasonCodes: ['BUDGET_RESERVED_ATOMICALLY'] };
  }

  settle(id: string, usage: DelegationResult['budgetUsage']): void {
    const reserved = this.reservations.get(id);
    if (!reserved) throw new Error(`Unknown budget reservation ${id}.`);
    const bounded = (value: number, maximum: number) =>
      Number.isFinite(value) && value >= 0 ? Math.min(maximum, Math.floor(value)) : maximum;
    const usedTokens = bounded(usage.inputTokens + usage.outputTokens, reserved.tokenBudget);
    const usedActions = bounded(usage.actions, reserved.actionBudget);
    const usedTime = bounded(usage.wallTimeMs, reserved.wallTimeMs);
    this.available.tokenBudget += reserved.tokenBudget - usedTokens;
    this.available.actionBudget += reserved.actionBudget - usedActions;
    this.available.wallTimeMs += reserved.wallTimeMs - usedTime;
    this.reservations.delete(id);
  }

  release(id: string): void {
    const reserved = this.reservations.get(id);
    if (!reserved) return;
    this.available.tokenBudget += reserved.tokenBudget;
    this.available.actionBudget += reserved.actionBudget;
    this.available.wallTimeMs += reserved.wallTimeMs;
    this.reservations.delete(id);
  }

  remaining(): DelegationBudget {
    return structuredClone(this.available);
  }
}

export interface IsolatedChildWorker {
  result: Promise<DelegationResult>;
  terminate(reason: string): Promise<void>;
}

export interface IsolatedChildWorkerFactory {
  start(request: ChildRuntimeRequest): IsolatedChildWorker;
}

/** Requires a worker with a real termination primitive; abort is not treated
 * as cancellation until terminate() has completed. */
export class CancellableChildWorkerExecutor implements ChildRuntimeExecutor {
  constructor(private readonly factory: IsolatedChildWorkerFactory) {}

  async run(request: ChildRuntimeRequest): Promise<DelegationResult> {
    const worker = this.factory.start(request);
    if (request.signal.aborted) {
      await worker.terminate('aborted-before-start');
      throw new Error('CHILD_WORKER_ABORTED');
    }
    let abortReject: ((reason: Error) => void) | undefined;
    const aborted = new Promise<DelegationResult>((_resolve, reject) => {
      abortReject = reject;
    });
    const onAbort = () => {
      void worker.terminate('wall-time-or-parent-abort').then(() => {
        abortReject?.(new Error('CHILD_WORKER_TERMINATED'));
      }, error => abortReject?.(error instanceof Error ? error : new Error(String(error))));
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([worker.result, aborted]);
    } finally {
      request.signal.removeEventListener('abort', onAbort);
    }
  }
}

function recursivePrefix(pattern: string): string | undefined {
  return pattern.endsWith('/**') ? pattern.slice(0, -2) : undefined;
}

export function resourceScopeContains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = recursivePrefix(parent);
  if (!prefix) return false;
  const childPrefix = recursivePrefix(child);
  return childPrefix ? childPrefix.startsWith(prefix) : child.startsWith(prefix);
}

function budgetValid(budget: DelegationBudget): boolean {
  return Number.isInteger(budget.tokenBudget)
    && Number.isInteger(budget.actionBudget)
    && Number.isInteger(budget.wallTimeMs)
    && budget.tokenBudget > 0
    && budget.actionBudget > 0
    && budget.wallTimeMs > 0;
}

export class DelegationPolicy {
  decide(input: DelegationPolicyInput): DelegationDecision {
    const { parentIntent, contract, remainingBudget } = input;
    const child = contract.childIntent;
    const reasons: string[] = [];

    if (contract.parentRunId.length === 0) reasons.push('PARENT_RUN_ID_REQUIRED');
    if (contract.childRunId.length === 0) reasons.push('CHILD_RUN_ID_REQUIRED');
    if (contract.childRunId === contract.parentRunId) reasons.push('CHILD_RUN_MUST_BE_DISTINCT');
    if (!parentIntent.authorizedCapabilities) {
      reasons.push('PARENT_CAPABILITIES_UNDECLARED');
    } else {
      for (const capability of child.authorizedCapabilities ?? []) {
        if (!parentIntent.authorizedCapabilities.includes(capability)) {
          reasons.push(`CAPABILITY_AUTHORITY_EXPANDED:${capability}`);
        }
      }
    }
    if (!child.authorizedCapabilities) reasons.push('CHILD_CAPABILITIES_UNDECLARED');

    for (const resource of child.authorizedResources) {
      if (!parentIntent.authorizedResources.some(parent =>
        resourceScopeContains(parent, resource),
      )) {
        reasons.push(`RESOURCE_AUTHORITY_EXPANDED:${resource}`);
      }
    }
    for (const effect of parentIntent.prohibitedEffects) {
      if (!child.prohibitedEffects.includes(effect)) {
        reasons.push(`PARENT_PROHIBITION_REMOVED:${effect}`);
      }
    }
    if (child.riskBudget > parentIntent.riskBudget) {
      reasons.push('RISK_BUDGET_EXPANDED');
    }
    if (child.approvalAboveRisk > parentIntent.approvalAboveRisk) {
      reasons.push('APPROVAL_THRESHOLD_WEAKENED');
    }

    const availableContext = new Set(input.availableContextIds);
    if (availableContext.size !== input.availableContextIds.length) {
      reasons.push('AMBIGUOUS_CONTEXT_SOURCE');
    }
    for (const reference of contract.contextRefs) {
      if (!availableContext.has(reference)) reasons.push(`CONTEXT_REFERENCE_UNAVAILABLE:${reference}`);
    }
    if (new Set(contract.contextRefs).size !== contract.contextRefs.length) {
      reasons.push('DUPLICATE_CONTEXT_REFERENCE');
    }

    if (!budgetValid(contract.budget)) reasons.push('DELEGATION_BUDGET_INVALID');
    if (contract.budget.tokenBudget > remainingBudget.tokenBudget) {
      reasons.push('TOKEN_BUDGET_EXCEEDS_PARENT');
    }
    if (contract.budget.actionBudget > remainingBudget.actionBudget) {
      reasons.push('ACTION_BUDGET_EXCEEDS_PARENT');
    }
    if (contract.budget.wallTimeMs > remainingBudget.wallTimeMs) {
      reasons.push('TIME_BUDGET_EXCEEDS_PARENT');
    }
    if (contract.verification.minimumEvidence < 0) {
      reasons.push('MINIMUM_EVIDENCE_INVALID');
    }

    return {
      id: `delegation-decision:${contract.id}`,
      delegationId: contract.id,
      disposition: reasons.length === 0 ? 'allow' : 'deny',
      reasonCodes: reasons.length === 0 ? ['CHILD_AUTHORITY_IS_SUBSET'] : reasons,
    };
  }
}

function schemaErrors(schema: JsonSchema, value: unknown, path = '$'): string[] {
  if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) {
    return [`${path}:VALUE_NOT_IN_ENUM`];
  }
  switch (schema.type) {
    case 'null':
      return value === null ? [] : [`${path}:EXPECTED_NULL`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}:EXPECTED_BOOLEAN`];
    case 'string':
      return typeof value === 'string' ? [] : [`${path}:EXPECTED_STRING`];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? []
        : [`${path}:EXPECTED_NUMBER`];
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? []
        : [`${path}:EXPECTED_INTEGER`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path}:EXPECTED_ARRAY`];
      const errors = schema.minItems !== undefined && value.length < schema.minItems
        ? [`${path}:MIN_ITEMS:${schema.minItems}`]
        : [];
      if (schema.items) {
        value.forEach((item, index) => {
          errors.push(...schemaErrors(schema.items!, item, `${path}[${index}]`));
        });
      }
      return errors;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${path}:EXPECTED_OBJECT`];
      }
      const record = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const required of schema.required ?? []) {
        if (!Object.hasOwn(record, required)) errors.push(`${path}.${required}:REQUIRED`);
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(record, key)) {
          errors.push(...schemaErrors(propertySchema, record[key], `${path}.${key}`));
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(schema.properties, key)) {
            errors.push(`${path}.${key}:ADDITIONAL_PROPERTY`);
          }
        }
      }
      return errors;
    }
  }
}

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
): { valid: boolean; errors: string[] } {
  const errors = schemaErrors(schema, value);
  return { valid: errors.length === 0, errors };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function attestationPayload(result: DelegationResult): string {
  const { attestation: _attestation, ...unsigned } = result;
  return canonical(unsigned);
}

export function signDelegationResult(
  result: DelegationResult,
  input: { keyId: string; privateKeyPem: string },
): DelegationResult {
  const payload = attestationPayload(result);
  const payloadDigest = createHash('sha256').update(payload).digest('hex');
  const signature = sign(null, Buffer.from(payload), createPrivateKey(input.privateKeyPem)).toString('base64url');
  const attestation: ReceiptAttestation = {
    algorithm: 'Ed25519',
    keyId: input.keyId,
    payloadDigest,
    signature,
  };
  return { ...structuredClone(result), attestation };
}

export function verifyDelegationResultAttestation(
  result: DelegationResult,
  keyring: Readonly<Record<string, string>>,
): string[] {
  const attestation = result.attestation;
  if (!attestation) return ['CHILD_RECEIPT_ATTESTATION_MISSING'];
  if (attestation.algorithm !== 'Ed25519') return ['CHILD_RECEIPT_ATTESTATION_ALGORITHM_UNSUPPORTED'];
  const publicKey = keyring[attestation.keyId];
  if (!publicKey) return ['CHILD_RECEIPT_ATTESTATION_KEY_UNTRUSTED'];
  const payload = attestationPayload(result);
  const digest = createHash('sha256').update(payload).digest('hex');
  if (digest !== attestation.payloadDigest) return ['CHILD_RECEIPT_ATTESTATION_DIGEST_MISMATCH'];
  try {
    return verify(
      null,
      Buffer.from(payload),
      createPublicKey(publicKey),
      Buffer.from(attestation.signature, 'base64url'),
    ) ? [] : ['CHILD_RECEIPT_ATTESTATION_INVALID'];
  } catch {
    return ['CHILD_RECEIPT_ATTESTATION_INVALID'];
  }
}

export function validateDelegationResult(
  contract: DelegationContract,
  result: DelegationResult,
  receiptKeyring: Readonly<Record<string, string>> = {},
): string[] {
  const reasons: string[] = [];
  if ([
    result.budgetUsage.inputTokens,
    result.budgetUsage.outputTokens,
    result.budgetUsage.actions,
  ].some(value => !Number.isFinite(value) || value < 0 || !Number.isInteger(value))) {
    reasons.push('CHILD_BUDGET_USAGE_INVALID');
  }
  if (!Number.isFinite(result.budgetUsage.wallTimeMs) || result.budgetUsage.wallTimeMs < 0) {
    reasons.push('CHILD_BUDGET_USAGE_INVALID');
  }
  if (result.delegationId !== contract.id) reasons.push('DELEGATION_ID_MISMATCH');
  if (result.childRunId !== contract.childRunId) reasons.push('CHILD_RUN_ID_MISMATCH');
  if (
    result.budgetUsage.inputTokens + result.budgetUsage.outputTokens
    > contract.budget.tokenBudget
  ) {
    reasons.push('CHILD_TOKEN_BUDGET_EXCEEDED');
  }
  if (result.budgetUsage.actions > contract.budget.actionBudget) {
    reasons.push('CHILD_ACTION_BUDGET_EXCEEDED');
  }
  if (result.budgetUsage.wallTimeMs > contract.budget.wallTimeMs) {
    reasons.push('CHILD_TIME_BUDGET_EXCEEDED');
  }
  if (result.policyViolations.length > 0) reasons.push('CHILD_POLICY_VIOLATION');
  if (result.status !== 'completed') reasons.push(`CHILD_NOT_COMPLETED:${result.status}`);
  if (contract.verification.requireVerifiedCompletion && !result.verificationPassed) {
    reasons.push('CHILD_COMPLETION_NOT_VERIFIED');
  }
  if (result.evidenceRefs.length < contract.verification.minimumEvidence) {
    reasons.push('CHILD_EVIDENCE_INSUFFICIENT');
  }
  if (!result.childReceiptHash) reasons.push('CHILD_RECEIPT_MISSING');
  const attestation = contract.verification.receiptAttestation;
  if (attestation?.required) {
    if (result.attestation && !attestation.trustedKeyIds.includes(result.attestation.keyId)) {
      reasons.push('CHILD_RECEIPT_ATTESTATION_KEY_OUTSIDE_CONTRACT');
    } else {
      reasons.push(...verifyDelegationResultAttestation(result, receiptKeyring));
    }
  }
  if (result.status === 'completed') {
    const schema = validateJsonSchema(contract.expectedOutputSchema, result.output);
    reasons.push(...schema.errors.map(error => `CHILD_OUTPUT_SCHEMA:${error}`));
  }
  return reasons;
}

function invalidDelegationFailure(reasons: string[]): StructuredFailure {
  return {
    type: 'invalid_delegation',
    message: reasons.join(', '),
    recoverableByChild: false,
    recommendedEscalation: 'parent',
    evidenceRefs: [],
  };
}

function failedResult(contract: DelegationContract, failure: StructuredFailure): DelegationResult {
  return {
    delegationId: contract.id,
    childRunId: contract.childRunId,
    status: 'failed',
    evidenceRefs: [...failure.evidenceRefs],
    policyViolations: [],
    verificationPassed: false,
    budgetUsage: {
      inputTokens: 0,
      outputTokens: 0,
      actions: 0,
      wallTimeMs: 0,
    },
    failure,
  };
}

export class DelegationController {
  constructor(private readonly policy = new DelegationPolicy()) {}

  async execute(input: ExecuteDelegationInput): Promise<DelegationReceipt> {
    const { contract, events } = input;
    events?.append(contract.parentRunId, 'delegation.proposed', {
      delegationId: contract.id,
      childRunId: contract.childRunId,
      childIntentId: contract.childIntent.id,
      contextRefs: contract.contextRefs,
      budget: contract.budget,
    });
    const decision = this.policy.decide({
      parentIntent: input.parentIntent,
      contract,
      remainingBudget: input.remainingBudget,
      availableContextIds: input.parentContext.map(source => source.id),
    });
    events?.append(contract.parentRunId, 'delegation.decided', decision as unknown as Record<string, unknown>);

    if (decision.disposition === 'deny') {
      const result = failedResult(contract, invalidDelegationFailure(decision.reasonCodes));
      const receipt = events?.append(contract.parentRunId, 'delegation.receipt', {
        delegationId: contract.id,
        authorized: false,
        accepted: false,
        reasonCodes: decision.reasonCodes,
      });
      return {
        delegationId: contract.id,
        parentRunId: contract.parentRunId,
        childRunId: contract.childRunId,
        authorized: false,
        accepted: false,
        reasonCodes: decision.reasonCodes,
        result,
        parentReceiptHash: receipt?.hash,
      };
    }

    const reservation = input.budgetPool?.reserve(contract.id, contract.budget);
    if (reservation && !reservation.accepted) {
      const result = failedResult(contract, invalidDelegationFailure(reservation.reasonCodes));
      const receipt = events?.append(contract.parentRunId, 'delegation.receipt', {
        delegationId: contract.id,
        authorized: false,
        accepted: false,
        reasonCodes: reservation.reasonCodes,
      });
      return {
        delegationId: contract.id,
        parentRunId: contract.parentRunId,
        childRunId: contract.childRunId,
        authorized: false,
        accepted: false,
        reasonCodes: reservation.reasonCodes,
        result,
        parentReceiptHash: receipt?.hash,
      };
    }
    if (reservation?.accepted) {
      events?.append(contract.parentRunId, 'delegation.budget_reserved', {
        delegationId: contract.id,
        budget: contract.budget,
        remaining: input.budgetPool?.remaining(),
      });
    }

    const references = new Set(contract.contextRefs);
    const context = input.parentContext
      .filter(source => references.has(source.id))
      .map(source => structuredClone(source));
    events?.append(contract.parentRunId, 'delegation.authorized', {
      delegationId: contract.id,
      childRunId: contract.childRunId,
      delegatedCapabilities: contract.childIntent.authorizedCapabilities,
      delegatedResources: contract.childIntent.authorizedResources,
      contextRefs: context.map(source => source.id),
    });
    events?.append(contract.parentRunId, 'child_run.started', {
      delegationId: contract.id,
      childRunId: contract.childRunId,
    });

    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<DelegationResult>((resolve) => {
      timeout = setTimeout(() => {
        abort.abort();
        resolve(failedResult(contract, {
          type: 'budget_exhausted',
          message: `Child runtime exceeded ${contract.budget.wallTimeMs}ms wall-time budget.`,
          failedCondition: 'wall_time_budget',
          recoverableByChild: false,
          recommendedEscalation: 'parent',
          evidenceRefs: [],
        }));
      }, contract.budget.wallTimeMs);
    });

    let result: DelegationResult;
    try {
      result = await Promise.race([
        input.executor.run({
          contract,
          childIntent: structuredClone(contract.childIntent),
          context,
          signal: abort.signal,
        }),
        timeoutResult,
      ]);
    } catch (error) {
      result = failedResult(contract, {
        type: 'runtime_unavailable',
        message: error instanceof Error ? error.message : String(error),
        recoverableByChild: false,
        recommendedEscalation: 'parent',
        evidenceRefs: [],
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (reservation?.accepted) {
      input.budgetPool?.settle(contract.id, result.budgetUsage);
      events?.append(contract.parentRunId, 'delegation.budget_settled', {
        delegationId: contract.id,
        usage: result.budgetUsage,
        remaining: input.budgetPool?.remaining(),
      });
    }

    events?.append(contract.parentRunId, 'child_result.received', {
      delegationId: contract.id,
      childRunId: contract.childRunId,
      status: result.status,
      evidenceRefs: result.evidenceRefs,
      childReceiptHash: result.childReceiptHash,
    });
    const validationReasons = validateDelegationResult(contract, result, input.receiptKeyring);
    const accepted = validationReasons.length === 0;
    events?.append(contract.parentRunId, 'child_evidence.validated', {
      delegationId: contract.id,
      accepted,
      reasonCodes: accepted ? ['CHILD_RESULT_ACCEPTED'] : validationReasons,
    });
    const receipt = events?.append(contract.parentRunId, 'delegation.receipt', {
      delegationId: contract.id,
      authorized: true,
      accepted,
      reasonCodes: accepted ? ['CHILD_RESULT_ACCEPTED'] : validationReasons,
    });

    return {
      delegationId: contract.id,
      parentRunId: contract.parentRunId,
      childRunId: contract.childRunId,
      authorized: true,
      accepted,
      reasonCodes: accepted ? ['CHILD_RESULT_ACCEPTED'] : validationReasons,
      result,
      parentReceiptHash: receipt?.hash,
    };
  }
}
