export interface BranchNode {
  branchId: string;
  parentRunId: string;
  forkAtTurn: number;
  createdAt: number;
  note?: string;
}

export class BranchManager {
  private branches: Map<string, BranchNode> = new Map();

  createBranch(parentRunId: string, forkAtTurn = 0, note?: string, store?: any): BranchNode {
    const branchId = 'br_' + crypto.randomUUID().slice(0, 8);
    const node: BranchNode = {
      branchId,
      parentRunId,
      forkAtTurn,
      createdAt: Date.now(),
      note,
    };
    this.branches.set(branchId, node);
    if (store && typeof store.saveBranch === 'function') {
      try {
        store.saveBranch(node);
      } catch {
        // Ignored if store is in-memory
      }
    }
    return node;
  }

  getBranch(branchId: string): BranchNode | undefined {
    return this.branches.get(branchId);
  }

  listBranchesForRun(parentRunId: string): BranchNode[] {
    return Array.from(this.branches.values()).filter(b => b.parentRunId === parentRunId);
  }
}