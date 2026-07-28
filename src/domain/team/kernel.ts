/**
 * domain/team/kernel.ts — Multi-Agent Team Orchestration Subsystem.
 * Ported from deterministic-ai-kernel-main/src/lib/team/kernel.ts
 */

export interface TeamMember {
  id: string;
  role: string;
  capabilities: string[];
  assignedTasks: string[];
}

export interface TeamOrchestrationState {
  teamId: string;
  objective: string;
  members: TeamMember[];
  status: 'planning' | 'executing' | 'complete';
}

export class TeamKernel {
  createTeam(objective: string, roles: string[]): TeamOrchestrationState {
    const members: TeamMember[] = roles.map((role, idx) => ({
      id: `member_${idx + 1}`,
      role,
      capabilities: ['reasoning', 'tool_use'],
      assignedTasks: [],
    }));

    return {
      teamId: 'team_' + crypto.randomUUID().slice(0, 8),
      objective,
      members,
      status: 'planning',
    };
  }

  assignTask(state: TeamOrchestrationState, memberId: string, task: string): boolean {
    const member = state.members.find(m => m.id === memberId);
    if (!member) return false;
    member.assignedTasks.push(task);
    return true;
  }
}
