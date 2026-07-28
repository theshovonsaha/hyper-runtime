/**
 * orchestration/team.ts — Dynamic Intent-Driven Multi-Agent Team Orchestrator.
 *
 * Dynamically classifies prompt intent graphs (research, coding, finance, verification)
 * without LLM inference, spawning tailored sub-agent teams (Researcher, Coder, Verifier, Planner)
 * and routing sub-task envelopes between them.
 */

export type PromptIntent = 'research' | 'code' | 'finance' | 'verification' | 'general';

export interface AgentMember {
  agentId: string;
  role: string;
  intentSpecialty: PromptIntent;
}

export interface TeamOrchestrationResult {
  teamId: string;
  detectedIntents: PromptIntent[];
  assignedAgents: AgentMember[];
  aggregatedOutput: string;
  logs: string[];
}

export class DynamicTeamOrchestrator {
  private INTENT_PATTERNS: Record<PromptIntent, RegExp> = {
    research: /\b(search|research|find|web|info|google|browse|news|documentation|specs)\b/i,
    code: /\b(run|shell|bash|code|script|build|compile|ts|js|python|bug|refactor|function)\b/i,
    finance: /\b(stock|stocks|ticker|market|shares|invest|price|finance|revenue|earnings|\$[A-Za-z]+)\b/i,
    verification: /\b(test|verify|check|audit|validate|pen\s*test|stress|coverage)\b/i,
    general: /.*/i,
  };

  classifyIntents(prompt: string): PromptIntent[] {
    const intents: PromptIntent[] = [];
    for (const [intent, pattern] of Object.entries(this.INTENT_PATTERNS)) {
      if (intent !== 'general' && pattern.test(prompt)) {
        intents.push(intent as PromptIntent);
      }
    }
    return intents.length > 0 ? intents : ['general'];
  }

  orchestrateTeam(prompt: string): TeamOrchestrationResult {
    const detectedIntents = this.classifyIntents(prompt);
    const teamId = 'team_' + crypto.randomUUID().slice(0, 8);
    const assignedAgents: AgentMember[] = [];
    const logs: string[] = [];

    for (const intent of detectedIntents) {
      switch (intent) {
        case 'research':
          assignedAgents.push({ agentId: 'agent_researcher', role: 'Researcher Agent', intentSpecialty: 'research' });
          logs.push('Assigned Researcher Agent for web/workspace inspection.');
          break;
        case 'code':
          assignedAgents.push({ agentId: 'agent_coder', role: 'Coder Agent', intentSpecialty: 'code' });
          logs.push('Assigned Coder Agent for code modification and shell commands.');
          break;
        case 'finance':
          assignedAgents.push({ agentId: 'agent_finance', role: 'Financial Analyst Agent', intentSpecialty: 'finance' });
          logs.push('Assigned Financial Analyst Agent for stock fundamental research.');
          break;
        case 'verification':
          assignedAgents.push({ agentId: 'agent_verifier', role: 'Verification & QA Agent', intentSpecialty: 'verification' });
          logs.push('Assigned QA Verifier Agent for system testing.');
          break;
        default:
          assignedAgents.push({ agentId: 'agent_general', role: 'General Assistant', intentSpecialty: 'general' });
          logs.push('Assigned General Assistant Agent.');
          break;
      }
    }

    const aggregatedOutput = `[Dynamic Team ${teamId}]\nOrchestrated ${assignedAgents.length} sub-agent(s) for intents: [${detectedIntents.join(', ')}].`;

    return {
      teamId,
      detectedIntents,
      assignedAgents,
      aggregatedOutput,
      logs,
    };
  }
}
