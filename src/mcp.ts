// Blyg Atlas MCP server — stdio bridge exposing the atlas tools to Claude Code.
// Hand-rolled JSON-RPC 2.0 over stdio, no SDK. Register (user scope) — see examples/README.md:
//   claude mcp add blyg --scope user -- npx tsx /path/to/blyg-atlas/src/mcp.ts

// Nothing but JSON-RPC may reach stdout — route all console logging to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

import { VERSION } from './config.js';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest { jsonrpc: '2.0'; id: number | string; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string; result?: any; error?: { code: number; message: string } }

const respond = (id: number | string, result: any): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const respondError = (id: number | string, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

async function main() {
  const { toolDefs, executeTool } = await import('./tools.js');
  const TOOL_DEFINITIONS = toolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));

  async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (req.method) {
      case 'initialize':
        return respond(req.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'blyg-atlas', version: VERSION } });
      case 'notifications/initialized':
        return respond(req.id, {});
      case 'tools/list':
        return respond(req.id, { tools: TOOL_DEFINITIONS });
      case 'tools/call': {
        const { name, arguments: args } = req.params;
        try {
          const result = await executeTool(name, args ?? {});
          return respond(req.id, { content: [{ type: 'text', text: result }] });
        } catch (err: any) {
          return respond(req.id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        return respondError(req.id, -32601, `Unknown method: ${req.method}`);
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const req = JSON.parse(line) as JsonRpcRequest;
        handleRequest(req).then((response) => {
          if (req.method.startsWith('notifications/')) return;
          process.stdout.write(JSON.stringify(response) + '\n');
        });
      } catch {
        process.stdout.write(JSON.stringify(respondError(0, -32700, 'Parse error')) + '\n');
      }
    }
  });

  process.stderr.write('Blyg Atlas MCP server started\n');
}

main();
