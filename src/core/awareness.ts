/**
 * core/awareness.ts — Environment & System Awareness Engine.
 *
 * Provides real-time system metrics, working directory context, platform info,
 * and time awareness for injection into ContextAssembler lane 3.
 */

import { hostname, platform, arch } from 'os';

export interface SystemAwarenessContext {
  timestamp: string;
  osPlatform: string;
  architecture: string;
  hostname: string;
  workingDir: string;
  timezone: string;
  uptimeSeconds: number;
}

export class AwarenessEngine {
  captureAwareness(): SystemAwarenessContext {
    return {
      timestamp: new Date().toISOString(),
      osPlatform: platform(),
      architecture: arch(),
      hostname: hostname(),
      workingDir: process.cwd(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  renderAwarenessPrompt(): string {
    const a = this.captureAwareness();
    return `[ENVIRONMENT AWARENESS]\nTimestamp: ${a.timestamp}\nOS: ${a.osPlatform} (${a.architecture})\nHost: ${a.hostname}\nCWD: ${a.workingDir}\nTimezone: ${a.timezone}`;
  }
}
