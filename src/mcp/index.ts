import http from 'node:http';
import util from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const useHttp = process.argv.includes('--http');
const stdioVerbose = process.env.REPO_CONTEXT_VERBOSE === '1';
const stdioShowLogs = typeof process.stderr?.isTTY === 'boolean' ? process.stderr.isTTY : false;

const ts = () => new Date().toISOString().slice(11, 23);
const originalLog = console.log;
const originalError = console.error;
if (!useHttp) {
  console.log = (...args: unknown[]) => {
    if (stdioShowLogs || stdioVerbose) process.stderr.write(`[${ts()}] ${util.format(...args)}\n`);
  };
  console.error = (...args: unknown[]) => {
    process.stderr.write(`[${ts()}] ${util.format(...args)}\n`);
  };
} else {
  console.log = (...args: unknown[]) => { originalLog(`[${ts()}]`, ...args); };
  console.error = (...args: unknown[]) => { originalError(`[${ts()}]`, ...args); };
}
import { graphStats } from '../graph/index.js';
import { repoRoot, packageRoot, artifactsDir } from '../paths.js';
import { toolHandlers } from './handlers.js';
import { toolDefs, toHttpToolSchema, getRequiredArgs } from './tool-defs.js';
import { AppContext } from './context.js';
import { loadConfig, type ResolvedConfig } from '../config.js';

// ── Tool definitions derived from single source of truth (tool-defs.ts) ──

const httpTools = toolDefs.map(toHttpToolSchema);

// ── Tool execution ──

function isToolError(result: unknown): result is { error: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof (result as { error: unknown }).error === 'string'
  );
}

function logToolError(toolName: string, message: string): void {
  console.error(`  [${toolName}] error: ${message}`);
}

function executeTool(ctx: AppContext, name: string, args: Record<string, unknown>): unknown {
  const def = toolDefs.find(d => d.name === name);
  if (def) {
    const required = getRequiredArgs(def);
    const missing = required.filter(k => args[k] == null || args[k] === '');
    if (missing.length > 0) {
      return {
        error: `Missing required argument(s): ${missing.join(', ')}. `
          + `You MUST pass the "arguments" parameter to CallMcpTool — it IS supported. `
          + `Do NOT call without arguments. Read .cursor/rules/repo-context.mdc for examples.`,
        fix: `CallMcpTool(server: "<serverIdentifier from mcp_file_system_servers>", toolName: "${name}", arguments: { ${required.map(k => `"${k}": "..."`).join(', ')} })`,
      };
    }
    const parsed = def.schema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { error: `Invalid arguments: ${issues}` };
    }
    args = parsed.data as Record<string, unknown>;
  }

  const handler = toolHandlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }

  const toolCtx = {
    getState: () => ctx.getState(),
    refreshContext: () => { ctx.refresh(); },
  };
  return handler(toolCtx, args);
}

// ── MCP JSON-RPC server ──

interface MCPRequest { jsonrpc: string; id: unknown; method: string; params?: Record<string, unknown> }
interface MCPResponse { jsonrpc: string; id: unknown; result?: unknown; error?: { code: number; message: string } }

// ── Usage tracking ──

const usage = {
  startedAt: new Date().toISOString(),
  totalCalls: 0,
  totalResponseChars: 0,
  byTool: {} as Record<string, { calls: number; chars: number }>,
};

function trackCall(toolName: string, responseText: string): void {
  const chars = responseText.length;
  usage.totalCalls++;
  usage.totalResponseChars += chars;

  if (!usage.byTool[toolName]) usage.byTool[toolName] = { calls: 0, chars: 0 };
  usage.byTool[toolName].calls++;
  usage.byTool[toolName].chars += chars;

  const approxTokens = Math.ceil(chars / 4);
  console.log(`    → ${chars} chars (~${approxTokens} tokens) | total: ${usage.totalCalls} calls, ~${Math.ceil(usage.totalResponseChars / 4)} tokens`);
}

function getUsageStats() {
  const approxTotalTokens = Math.ceil(usage.totalResponseChars / 4);
  const byTool = Object.entries(usage.byTool).map(([name, data]) => ({
    tool: name,
    calls: data.calls,
    chars: data.chars,
    approxTokens: Math.ceil(data.chars / 4),
  })).sort((a, b) => b.calls - a.calls);

  return {
    startedAt: usage.startedAt,
    totalCalls: usage.totalCalls,
    totalResponseChars: usage.totalResponseChars,
    approxTotalTokens,
    byTool,
  };
}

// ── HTTP server ──

function startServer(ctx: AppContext, cfg: ResolvedConfig): void {
  const { port, host } = cfg.server;
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (req.url === '/health') {
      const stats = graphStats(ctx.getState().graph);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', builtAt: ctx.getState().builtAt, ...stats }));
      return;
    }

    if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getUsageStats(), null, 2));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const request: MCPRequest = JSON.parse(body);
        const response = await handleRequest(ctx, request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        console.error('  [MCP] request parse error:', (e as Error).message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`Repo context MCP server ready`);
    console.log(`  Host:    ${host} (localhost only)`);
    console.log(`  Port:    ${port}`);
    console.log(`  Health:  http://localhost:${port}/health`);
    console.log(`  Stats:   http://localhost:${port}/stats`);
    console.log(`  MCP:     POST http://localhost:${port}/`);
  });
}

async function handleRequest(ctx: AppContext, req: MCPRequest): Promise<MCPResponse> {
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'repo-context-mcp', version: '0.1.0' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id: req.id, result: { tools: httpTools } };

    case 'tools/call': {
      const params = req.params ?? {};
      const name = params.name as string | undefined;
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      if (typeof name !== 'string') {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Missing tool name' } };
      }
      console.log(`  tool: ${name}(${JSON.stringify(args)})`);
      try {
        const result = await Promise.resolve(executeTool(ctx, name, args));
        if (isToolError(result)) {
          logToolError(name, result.error);
        }
        const text = JSON.stringify(result, null, 2);
        trackCall(name, text);
        return {
          jsonrpc: '2.0', id: req.id,
          result: { content: [{ type: 'text', text }] },
        };
      } catch (e) {
        const message = (e as Error).message;
        logToolError(name, message);
        return {
          jsonrpc: '2.0', id: req.id,
          error: { code: -32603, message },
        };
      }
    }

    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
}

// ── Stdio mode (MCP SDK) ──

async function runStdio(ctx: AppContext): Promise<void> {
  const mcpServer = new McpServer({ name: 'repo-context-mcp', version: '0.1.0' });

  for (const def of toolDefs) {
    const name = def.name;
    mcpServer.registerTool(name, {
      description: def.description,
      inputSchema: def.schema,
    }, async (args: unknown, _extra: unknown) => {
      const safeArgs = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
      if (stdioShowLogs || stdioVerbose) console.error(`  tool: ${name}(${JSON.stringify(safeArgs)})`);
      try {
        const result = await Promise.resolve(executeTool(ctx, name, safeArgs));
        if (isToolError(result)) logToolError(name, result.error);
        const text = JSON.stringify(result, null, 2);
        trackCall(name, text);
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        const message = (e as Error).message;
        logToolError(name, message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }] };
      }
    });
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  if (stdioShowLogs || stdioVerbose) console.error('\nRepo context MCP server (stdio) ready');
}

// ── Graceful shutdown ──

function setupGracefulShutdown(ctx: AppContext): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  Received ${signal}, flushing annotations and shutting down...`);
    try {
      ctx.getState().annotations.flush();
    } catch (e) {
      console.error('  [ALERT] Failed to flush annotations on shutdown:', (e as Error).message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ── Main ──

async function main(): Promise<void> {
  const cfg = loadConfig(packageRoot);
  console.log(`Building repo context for: ${repoRoot}`);
  const ctx = await AppContext.create(repoRoot, artifactsDir, cfg);
  setupGracefulShutdown(ctx);

  if (useHttp) {
    startServer(ctx, cfg);
  } else {
    await runStdio(ctx);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
