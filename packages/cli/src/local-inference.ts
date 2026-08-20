import { cpus, freemem, loadavg, totalmem } from 'node:os';

export interface LocalInferenceLimits {
  maxConcurrent: number;
  minimumFreeMemoryBytes: number;
  maximumLoadPerCpu: number;
  gpuMemoryBytes?: number;
}

export interface LocalResourceSnapshot {
  cpuCount: number;
  load1: number;
  loadPerCpu: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  memoryPressure: number;
  active: number;
  gpuMemoryBytes?: number;
}

export interface QuantizedModelCandidate {
  id: string;
  bytes: number;
  quantization?: string;
  tier?: 'small' | 'strong';
}

export function selectQuantizedModel(
  candidates: QuantizedModelCandidate[],
  availableBytes: number,
  tier: 'small' | 'strong',
): QuantizedModelCandidate | undefined {
  const budget = Math.max(0, availableBytes * 0.8);
  return candidates.filter(candidate => candidate.bytes > 0 && candidate.bytes <= budget)
    .sort((left, right) =>
      Number(right.tier === tier) - Number(left.tier === tier)
      || right.bytes - left.bytes
      || left.id.localeCompare(right.id),
    )[0];
}

export class LocalInferenceAdmissionController {
  private active = 0;

  constructor(private readonly limits: LocalInferenceLimits) {}

  snapshot(): LocalResourceSnapshot {
    const cpuCount = Math.max(1, cpus().length);
    const freeMemoryBytes = freemem();
    const totalMemoryBytes = totalmem();
    const load1 = loadavg()[0] ?? 0;
    return {
      cpuCount,
      load1,
      loadPerCpu: load1 / cpuCount,
      totalMemoryBytes,
      freeMemoryBytes,
      memoryPressure: totalMemoryBytes > 0 ? 1 - freeMemoryBytes / totalMemoryBytes : 1,
      active: this.active,
      gpuMemoryBytes: this.limits.gpuMemoryBytes,
    };
  }

  tryAcquire(): { accepted: true; snapshot: LocalResourceSnapshot; release(): void } | {
    accepted: false;
    reason: 'concurrency' | 'memory_pressure' | 'cpu_pressure';
    snapshot: LocalResourceSnapshot;
  } {
    const snapshot = this.snapshot();
    if (snapshot.active >= this.limits.maxConcurrent) return { accepted: false, reason: 'concurrency', snapshot };
    if (snapshot.freeMemoryBytes < this.limits.minimumFreeMemoryBytes) return { accepted: false, reason: 'memory_pressure', snapshot };
    if (snapshot.loadPerCpu > this.limits.maximumLoadPerCpu) return { accepted: false, reason: 'cpu_pressure', snapshot };
    this.active += 1;
    let released = false;
    return {
      accepted: true,
      snapshot: { ...snapshot, active: this.active },
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}
