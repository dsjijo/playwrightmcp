// server.js
import express from 'express';
import httpProxy from 'http-proxy';
import { spawn } from 'node:child_process';

const app = express();

const PUBLIC_PORT = Number(process.env.PORT || 10000);
const INTERNAL_MCP_PORT = Number(process.env.INTERNAL_MCP_PORT || 8931);
const API_KEY = process.env.API_KEY;
const ALLOW_X_API_KEY = (process.env.ALLOW_X_API_KEY || 'true').toLowerCase() === 'true';
const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';
const MCP_BASE_URL = `http://${MCP_HOST}:${INTERNAL_MCP_PORT}`;

if (!API_KEY) {
  console.error('Missing required environment variable: API_KEY');
  process.exit(1);
}

let mcpReady = false;
let mcpExited = false;

const proxy = httpProxy.createProxyServer({
  target: MCP_BASE_URL,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  proxyTimeout: 0,
  timeout: 0,
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err);

  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
  }

  if (res) {
    res.end(JSON.stringify({ error: 'upstream_mcp_unavailable' }));
  }
});

// Important: re-send raw body for proxied POST requests after express.raw() consumes it
proxy.on('proxyReq', (proxyReq, req) => {
  if (req.method === 'POST' && req.rawBody) {
    proxyReq.setHeader('Content-Length', Buffer.byteLength(req.rawBody));
    proxyReq.write(req.rawBody);
  }
});

const mcpArgs = [
  'cli.js',
  '--headless',
  '--browser',
  process.env.PLAYWRIGHT_BROWSER || 'chromium',
  '--no-sandbox',
  '--isolated',
  '--port',
  String(INTERNAL_MCP_PORT),
  '--host',
  MCP_HOST,
  '--allowed-hosts',
  '*',
];

if (process.env.PLAYWRIGHT_ALLOWED_ORIGINS) {
  mcpArgs.push('--allowed-origins', process.env.PLAYWRIGHT_ALLOWED_ORIGINS);
}
if (process.env.PLAYWRIGHT_BLOCKED_ORIGINS) {
  mcpArgs.push('--blocked-origins', process.env.PLAYWRIGHT_BLOCKED_ORIGINS);
}
if (process.env.PLAYWRIGHT_TIMEOUT_ACTION) {
  mcpArgs.push('--timeout-action', process.env.PLAYWRIGHT_TIMEOUT_ACTION);
}
if (process.env.PLAYWRIGHT_TIMEOUT_NAVIGATION) {
  mcpArgs.push('--timeout-navigation', process.env.PLAYWRIGHT_TIMEOUT_NAVIGATION);
}
if (process.env.PLAYWRIGHT_USER_AGENT) {
  mcpArgs.push('--user-agent', process.env.PLAYWRIGHT_USER_AGENT);
}
if ((process.env.PLAYWRIGHT_SHARED_BROWSER_CONTEXT || 'false').toLowerCase() === 'true') {
  mcpArgs.push('--shared-browser-context');
}
if ((process.env.PLAYWRIGHT_SAVE_SESSION || 'false').toLowerCase() === 'true') {
  mcpArgs.push('--save-session');
}
if (process.env.PLAYWRIGHT_OUTPUT_DIR) {
  mcpArgs.push('--output-dir', process.env.PLAYWRIGHT_OUTPUT_DIR);
}

console.log('Starting Playwright MCP:', mcpArgs.join(' '));
const mcp = spawn('node', mcpArgs, {
  cwd: '/app',
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

mcp.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[mcp] ${text}`);
  if (text.includes('/mcp') || text.toLowerCase().includes('listening')) {
    mcpReady = true;
  }
});

mcp.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  process.stderr.write(`[mcp] ${text}`);
  if (text.toLowerCase().includes('listening') || text.includes('/mcp')) {
    mcpReady = true;
  }
});

mcp.on('exit', (code, signal) => {
  mcpExited = true;
  console.error(`Playwright MCP exited. code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

function authorized(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length) === API_KEY;
  }

  if (ALLOW_X_API_KEY) {
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey === API_KEY) {
      return true;
    }
  }

  return false;
}

app.get('/healthz', (_req, res) => {
  const status = !mcpExited && mcpReady ? 200 : 503;
  res.status(status).json({
    ok: status === 200,
    mcpReady,
    mcpExited,
  });
});

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();

  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  return next();
});

/**
 * MCP prompt compatibility shim:
 * Some MCP clients/frameworks call prompts/list during setup.
 * Playwright MCP may not implement that method.
 * We return a valid empty prompt list so the client can continue.
 */
const PROMPT_LIST_METHODS = new Set([
  'prompts/list',
  'list_prompts',
]);

const PROMPT_GET_METHODS = new Set([
  'prompts/get',
  'get_prompt',
]);

function buildJsonRpcSuccess(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function buildJsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

function getShimmedResponse(message) {
  const method = message?.method;

  if (PROMPT_LIST_METHODS.has(method)) {
    return buildJsonRpcSuccess(message.id ?? null, {
      prompts: [],
    });
  }

  if (PROMPT_GET_METHODS.has(method)) {
    return buildJsonRpcError(message.id ?? null, -32602, 'Prompt not found');
  }

  return null;
}

/**
 * Only intercept POST /mcp for prompt shim.
 * For non-shimmed requests, proxy them directly so streamable HTTP remains intact.
 */
app.post('/mcp', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  try {
    const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    req.rawBody = rawBodyBuffer;

    let parsed;
    try {
      parsed = JSON.parse(rawBodyBuffer.toString('utf8'));
    } catch {
      return proxy.web(req, res, { target: MCP_BASE_URL });
    }

    // Single JSON-RPC request
    if (!Array.isArray(parsed)) {
      const shimmed = getShimmedResponse(parsed);
      if (shimmed) {
        return res.status(200).json(shimmed);
      }

      return proxy.web(req, res, { target: MCP_BASE_URL });
    }

    // Batch JSON-RPC request
    const shimmedResponses = parsed
      .map((item) => getShimmedResponse(item))
      .filter(Boolean);

    // If the full batch is only shimmed prompt methods, respond directly
    if (shimmedResponses.length === parsed.length) {
      return res.status(200).json(shimmedResponses);
    }

    // Otherwise, pass through unchanged to preserve MCP streaming behavior
    return proxy.web(req, res, { target: MCP_BASE_URL });
  } catch (err) {
    console.error('Shim POST /mcp error:', err);
    return res.status(502).json({
      error: 'mcp_proxy_failure',
      details: String(err?.message || err),
    });
  }
});

// Everything else proxies normally
app.use((req, res) => {
  proxy.web(req, res, { target: MCP_BASE_URL });
});

const server = app.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`Auth proxy listening on 0.0.0.0:${PUBLIC_PORT}`);
});

server.headersTimeout = 120_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 75_000;
server.timeout = 0;

// WebSocket upgrade support
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  proxy.ws(req, socket, head, { target: MCP_BASE_URL });
});