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

app.use((req, res) => {
  proxy.web(req, res, { target: MCP_BASE_URL });
});

const server = app.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`Auth proxy listening on 0.0.0.0:${PUBLIC_PORT}`);
});

server.headersTimeout = 120_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 75_000;