import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ExecutableWorkflowPlan,
  PlanCondition,
} from '@hyper/contracts';
import {
  analyzeWorkflowLanguage,
  compileNaturalLanguageWorkflow,
  type PrimitiveWorkflowOperation,
} from '@hyper/planning';

interface Scenario {
  id: string;
  message: string;
  expectedSource: ExecutableWorkflowPlan['source'];
  expectedOperations: PrimitiveWorkflowOperation[];
  expectedSearchQuery?: string;
  expectedConditionalArtifact: boolean;
  expectedConditionPredicates: PlanCondition['predicate'][];
}

interface Fixture {
  fixedNow: string;
  scenarios: Scenario[];
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'evals/workflow-language.v1.json'), 'utf8'),
) as Fixture;

describe('deterministic workflow language compiler', () => {
  for (const scenario of fixture.scenarios) {
    test(scenario.id, () => {
      const analysis = analyzeWorkflowLanguage(scenario.message);
      expect(analysis.source).toBe(scenario.expectedSource);
      expect(analysis.operations).toEqual(scenario.expectedOperations);
      expect(analysis.searchQuery).toBe(scenario.expectedSearchQuery);
      expect(analysis.conditionalArtifact).toBe(
        scenario.expectedConditionalArtifact,
      );

      const plan = compileNaturalLanguageWorkflow({
        message: scenario.message,
        sessionId: 'session:fixture',
        intentId: 'intent:fixture',
        now: fixture.fixedNow,
        idFactory: () => scenario.id,
      });
      expect(plan.steps.map(step => step.capabilityId)).toEqual(
        scenario.expectedOperations,
      );
      expect(plan.conditions.map(condition => condition.predicate)).toEqual(
        scenario.expectedConditionPredicates,
      );
      expect(plan.steps.every(step =>
        step.declaredEffects.length > 0
        && step.target.length > 0
        && step.idempotencyKey.length > 0
        && step.status === 'pending',
      )).toBe(true);
      expect(plan.steps.slice(1).every((step, index) =>
        step.dependsOn.includes(plan.steps[index]!.id),
      )).toBe(true);
      expect(plan.status).toBe('ready');
    });
  }

  test('compiler output remains inert until an authority boundary consumes it', () => {
    const plan = compileNaturalLanguageWorkflow({
      message: 'Search the web for runtime evidence then write a report.',
      sessionId: 'session:fixture',
      intentId: 'intent:fixture',
      now: fixture.fixedNow,
      idFactory: () => 'inert',
    });
    expect(plan.steps.every(step => step.attempts === 0)).toBe(true);
    expect(plan.steps.every(step => step.evidenceRefs.length === 0)).toBe(true);
    expect(plan.steps.every(step => step.output === undefined)).toBe(true);
  });
});
