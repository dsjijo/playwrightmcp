// server.js
import express from 'express';
import http from 'node:http';
import httpProxy from 'http-proxy';
import { spawn } from 'node:child_process';

const app = express();

app.disable('etag');
app.set('x-powered-by', false);

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

/**
 * WS proxy only.
 * HTTP proxying is handled manually below to better preserve streamable HTTP behavior.
 */
const wsProxy = httpProxy.createProxyServer({
  target: MCP_BASE_URL,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  proxyTimeout: 0,
  timeout: 0,
});

wsProxy.on('error', (err, req, socketOrRes) => {
  console.error('WS proxy error:', err);

  if (socketOrRes?.writable) {
    try {
      socketOrRes.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch {}
    try {
      socketOrRes.destroy();
    } catch {}
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
  if (text.includes('/mcp') || text.toLowerCase().includes('listening')) {
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

function copyUpstreamHeaders(req, bodyLength = null) {
  const headers = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();

    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'authorization' ||
      lower === 'x-api-key'
    ) {
      continue;
    }

    if (value !== undefined) {
      headers[key] = value;
    }
  }

  if (bodyLength !== null) {
    headers['content-length'] = String(bodyLength);
  }

  return headers;
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

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

const PROMPT_LIST_METHODS = new Set([
  'prompts/list',
  'list_prompts',
]);

const PROMPT_GET_METHODS = new Set([
  'prompts/get',
  'get_prompt',
]);

function getShimmedResponse(message) {
  const method = message?.method;

  if (PROMPT_LIST_METHODS.has(method)) {
    return buildJsonRpcSuccess(message.id ?? null, { prompts: [] });
  }

  if (PROMPT_GET_METHODS.has(method)) {
    return buildJsonRpcError(message.id ?? null, -32602, 'Prompt not found');
  }

  return null;
}

function proxyHttpToMcp(req, res, rawBody = null) {
  const headers = copyUpstreamHeaders(req, rawBody ? rawBody.length : null);

  // Avoid compressed streaming; easier to keep alive
  headers['accept-encoding'] = 'identity';

  const upstreamReq = http.request(
    {
      hostname: MCP_HOST,
      port: INTERNAL_MCP_PORT,
      method: req.method,
      path: req.originalUrl || req.url,
      headers,
    },
    (upstreamRes) => {
      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isEventStream =
        String(req.originalUrl || req.url || '').startsWith('/mcp') &&
        contentType.includes('text/event-stream');

      res.status(upstreamRes.statusCode || 502);

      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        const lower = key.toLowerCase();

        // Manage these ourselves for streaming safety
        if (lower === 'connection') continue;
        if (isEventStream && lower === 'content-length') continue;

        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }

      if (isEventStream) {
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
      }

      if (req.socket) {
        req.socket.setKeepAlive(true, 10000);
        req.socket.setNoDelay(true);
      }

      if (res.socket) {
        res.socket.setKeepAlive(true, 10000);
        res.socket.setNoDelay(true);
      }

      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      let heartbeat = null;

      const stopHeartbeat = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };

      if (isEventStream) {
        // Initial harmless SSE comment
        try {
          res.write(': connected\n\n');
        } catch {}

        // Keep downstream GET stream alive
        heartbeat = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(': keepalive\n\n');
            } catch {}
          }
        }, 2000);
      }

      if (isEventStream) {
        upstreamRes.on('data', (chunk) => {
          if (!res.writableEnded && !res.destroyed) {
            res.write(chunk);
          }
        });

        upstreamRes.on('end', () => {
          stopHeartbeat();
          if (!res.writableEnded) {
            res.end();
          }
        });

        upstreamRes.on('close', () => {
          stopHeartbeat();
          if (!res.writableEnded) {
            res.end();
          }
        });
      } else {
        upstreamRes.pipe(res);
        upstreamRes.on('end', stopHeartbeat);
        upstreamRes.on('close', stopHeartbeat);
      }

      upstreamRes.on('error', (err) => {
        stopHeartbeat();
        console.error('Upstream response error:', err);
        if (!res.headersSent) {
          writeJson(res, 502, { error: 'upstream_mcp_unavailable' });
        } else {
          try {
            res.end();
          } catch {}
        }
      });
    }
  );

  upstreamReq.setTimeout(0);

  upstreamReq.on('error', (err) => {
    console.error('Upstream request error:', err);
    if (!res.headersSent) {
      writeJson(res, 502, {
        error: 'upstream_mcp_unavailable',
        details: String(err?.message || err),
      });
    } else {
      try {
        res.end();
      } catch {}
    }
  });

  const teardown = () => {
    try {
      upstreamReq.destroy();
    } catch {}
  };

  req.on('aborted', teardown);
  req.on('close', () => {
    if (!req.complete) {
      teardown();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      teardown();
    }
  });

  if (rawBody) {
    upstreamReq.end(rawBody);
  } else {
    req.pipe(upstreamReq);
  }
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
    return writeJson(res, 401, { error: 'unauthorized' });
  }

  return next();
});

// Prompt compatibility shim for POST /mcp only.
// Non-shimmed requests pass through unchanged.
app.post('/mcp', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return proxyHttpToMcp(req, res, rawBody);
    }

    if (!Array.isArray(parsed)) {
      const shimmed = getShimmedResponse(parsed);
      if (shimmed) {
        return writeJson(res, 200, shimmed);
      }

      return proxyHttpToMcp(req, res, rawBody);
    }

    const shimmedResponses = parsed
      .map((item) => getShimmedResponse(item))
      .filter(Boolean);

    // Only directly answer if all items are prompt shim methods
    if (shimmedResponses.length === parsed.length) {
      return writeJson(res, 200, shimmedResponses);
    }

    return proxyHttpToMcp(req, res, rawBody);
  } catch (err) {
    console.error('POST /mcp shim error:', err);
    return writeJson(res, 502, {
      error: 'mcp_proxy_failure',
      details: String(err?.message || err),
    });
  }
});

// All other /mcp traffic, including long-lived GET stream
app.all('/mcp', (req, res) => {
  proxyHttpToMcp(req, res);
});

// Any other HTTP path also proxies through
app.use((req, res) => {
  proxyHttpToMcp(req, res);
});

const server = app.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`Auth proxy listening on 0.0.0.0:${PUBLIC_PORT}`);
});

server.headersTimeout = 120_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 75_000;
server.timeout = 0;

server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wsProxy.ws(req, socket, head, { target: MCP_BASE_URL });
});