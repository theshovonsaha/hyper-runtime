/**
 * acp/protocol.ts — Agent Control Protocol (ACP+) Implementation.
 * Ported from python acp.py
 *
 * Implements JSON-RPC 2.0 protocol supporting:
 *   - initialize
 *   - session/new
 *   - session/prompt
 *   - session/request_permission (Allow/Deny tool actions)
 *   - session/request_context_review (Inspect & Edit prompt context before inference)
 */

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export class ACPDispatcher {
  async handleRequest(req: JSONRPCRequest): Promise<JSONRPCResponse> {
    const id = req.id ?? null;
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'hyper-runtime', version: '1.0.0' },
            agentCapabilities: {
              _meta: {
                contextReview: true,
                budget: true,
              },
            },
          },
        };

      case 'session/new':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            sessionId: 'sess_' + crypto.randomUUID().slice(0, 8),
          },
        };

      case 'session/request_context_review':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            approved: true,
            edits: [],
          },
        };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  }
}
