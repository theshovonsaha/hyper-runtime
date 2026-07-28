/**
 * core/scheduler.ts — Background Recurring Task Scheduler.
 * Ported from python scheduler.py
 */

export interface ScheduledTask {
  id: string;
  sessionId: string;
  message: string;
  everySeconds: number;
  lastRunAt: number;
  provider?: string;
}

export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private onFire: (task: ScheduledTask) => Promise<void>) {}

  addTask(task: ScheduledTask): void {
    this.tasks.set(task.id, task);
  }

  removeTask(id: string): boolean {
    return this.tasks.delete(id);
  }

  start(tickMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (now - task.lastRunAt >= task.everySeconds * 1000) {
        task.lastRunAt = now;
        this.onFire(task).catch(err => {
          console.error(`[Scheduler Error] Task ${task.id} failed:`, err);
        });
      }
    }
  }
}
