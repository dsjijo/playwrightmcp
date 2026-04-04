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
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err);
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({ error: 'upstream_mcp_unavailable' }));
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
 * Some clients/frameworks call prompts/list during startup.
 * Playwright MCP may not implement it, so we fake an empty prompt list.
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
    // Usually not needed if prompts/list returns empty.
    // But returning a clean error is safer than "method not found" from upstream.
    return buildJsonRpcError(message.id ?? null, -32602, 'Prompt not found');
  }

  return null;
}

async function forwardPostToMcp(req, res, rawBodyBuffer) {
  const headers = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();

    // Do not forward proxy auth headers to local MCP
    if (lower === 'host' || lower === 'content-length' || lower === 'authorization' || lower === 'x-api-key') {
      continue;
    }

    if (Array.isArray(value)) {
      headers[key] = value.join(', ');
    } else if (value !== undefined) {
      headers[key] = value;
    }
  }

  const upstreamResponse = await fetch(`${MCP_BASE_URL}${req.originalUrl}`, {
    method: 'POST',
    headers,
    body: rawBodyBuffer,
  });

  res.status(upstreamResponse.status);

  upstreamResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });

  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.send(responseBuffer);
}

// Intercept POST /mcp only
app.post('/mcp', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  try {
    const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

    let parsed;
    try {
      parsed = JSON.parse(rawBodyBuffer.toString('utf8'));
    } catch {
      // Not JSON -> just forward as-is
      return await forwardPostToMcp(req, res, rawBodyBuffer);
    }

    // Handle single JSON-RPC request
    if (!Array.isArray(parsed)) {
      const shimmed = getShimmedResponse(parsed);
      if (shimmed) {
        return res.status(200).json(shimmed);
      }

      return await forwardPostToMcp(req, res, rawBodyBuffer);
    }

    // Handle batch JSON-RPC request
    const shimmedResponses = [];
    const forwardItems = [];

    for (const item of parsed) {
      const shimmed = getShimmedResponse(item);
      if (shimmed) {
        shimmedResponses.push(shimmed);
      } else {
        forwardItems.push(item);
      }
    }

    if (forwardItems.length === 0) {
      return res.status(200).json(shimmedResponses);
    }

    // If mixed batch, forward the non-shimmed items and merge results
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'content-length' || lower === 'authorization' || lower === 'x-api-key') {
        continue;
      }

      if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      } else if (value !== undefined) {
        headers[key] = value;
      }
    }

    const upstreamResponse = await fetch(`${MCP_BASE_URL}${req.originalUrl}`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
      },
      body: Buffer.from(JSON.stringify(forwardItems)),
    });

    const upstreamText = await upstreamResponse.text();
    let upstreamJson = [];

    try {
      upstreamJson = JSON.parse(upstreamText);
    } catch {
      upstreamJson = [];
    }

    const combined = Array.isArray(upstreamJson)
      ? [...upstreamJson, ...shimmedResponses]
      : [upstreamJson, ...shimmedResponses];

    return res.status(upstreamResponse.status).json(combined);
  } catch (err) {
    console.error('Shim POST /mcp error:', err);
    return res.status(502).json({
      error: 'mcp_proxy_failure',
      details: String(err?.message || err),
    });
  }
});

// Everything else proxies normally (GET /mcp, DELETE /mcp, websocket, etc.)
app.use((req, res) => {
  proxy.web(req, res, { target: MCP_BASE_URL });
});

const server = app.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`Auth proxy listening on 0.0.0.0:${PUBLIC_PORT}`);
});

server.headersTimeout = 120_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 75_000;