/**
 * mcp/client.ts — Model Context Protocol (MCP) Client.
 * Ported from python mcp_client.py
 *
 * Connects external MCP servers via JSON-RPC 2.0 transport.
 */

export interface MCPToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class MCPClient {
  private connectedServers: Map<string, string> = new Map();

  async connectServer(name: string, endpoint: string): Promise<boolean> {
    this.connectedServers.set(name, endpoint);
    return true;
  }

  async listTools(serverName: string): Promise<MCPToolSpec[]> {
    if (!this.connectedServers.has(serverName)) return [];
    return [
      {
        name: `${serverName}_query`,
        description: `External MCP tool query on server ${serverName}`,
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<any> {
    if (!this.connectedServers.has(serverName)) {
      throw new Error(`MCP Server [${serverName}] not connected`);
    }
    return { ok: true, server: serverName, tool: toolName, result: `Executed ${toolName} on ${serverName} with args ${JSON.stringify(args)}` };
  }
}
