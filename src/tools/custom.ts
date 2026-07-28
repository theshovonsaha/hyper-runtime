/**
 * @module tools/custom
 * Custom HTTP tools: the safe meta layer.
 * 
 * A declarative HTTP recipe with two placeholders:
 *  {cred:NAME} - resolved from environment/store
 *  {arg} - resolved from model-supplied arguments
 */

import type { ToolDefinition } from "./registry";
import type { EncryptedCredentialStore } from "../store/credentials";

export interface CustomToolSpec {
  name: string;
  description: string;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  parameters: Record<string, any>;
}

const ARG_RE = /\{([a-zA-Z0-9_]+)\}/g;
const BLOCKED_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|metadata\.)/i;

function fillArgs(text: string, args: Record<string, any>): string {
  if (!text) return text;
  return text.replace(ARG_RE, (match, name) => {
    return args[name] !== undefined ? String(args[name]) : match;
  });
}

function fillArgsDeep(obj: any, args: Record<string, any>): any {
  if (typeof obj === 'string') return fillArgs(obj, args);
  if (Array.isArray(obj)) return obj.map(v => fillArgsDeep(v, args));
  if (obj !== null && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = fillArgsDeep(v, args);
    }
    return out;
  }
  return obj;
}

function checkHost(url: string): void {
  try {
    const parsed = new URL(url);
    if (BLOCKED_HOST_RE.test(parsed.hostname)) {
      throw new Error(`Custom tools may not call internal/loopback host '${parsed.hostname}'`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Invalid URL: ${url}`);
    }
    throw err;
  }
}

export function buildCustomTool(spec: CustomToolSpec, creds: EncryptedCredentialStore): ToolDefinition {
  return {
    name: spec.name,
      description: spec.description,
      parameters: (spec.parameters || { type: 'object', properties: {} }) as any,
    execute: async (args: Record<string, unknown>, ctx: any) => {
      const method = (spec.method || 'GET').toUpperCase();
      
      // Resolve model arguments FIRST, then credentials, to prevent injection
      let url = fillArgs(spec.url, args);
      url = creds.resolve(url);
      
      checkHost(url);

      const headers: Record<string, string> = {};
      if (spec.headers) {
        for (const [k, v] of Object.entries(spec.headers)) {
          headers[k] = creds.resolve(fillArgs(v, args));
        }
      }

      let body: string | undefined;
      if (spec.body && method !== 'GET' && method !== 'HEAD') {
        body = creds.resolve(fillArgs(spec.body, args));
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
        });

        const text = await response.text();
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
        }

        return { success: true, content: text.slice(0, 4000) }; // Truncate huge responses
      } catch (err) {
        throw new Error(`Custom tool fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}
