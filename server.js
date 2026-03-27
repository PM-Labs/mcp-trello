import express from 'express';
import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8080');
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim();
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID?.trim();
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET?.trim();

const authCodes = {};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sessions: sessionId -> { proc, pending: Map<id, resolver>, buffer, timer }
const sessions = new Map();
// Remap stale session IDs (from before container restart) to active ones
const sessionMap = new Map();
const SESSION_TTL = 30 * 60 * 1000;

// --- OAuth 2.0 PKCE routes ---
app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const base = `https://${req.headers.host}`;
    res.json({ resource: `${base}/mcp`, authorization_servers: [base] });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = `https://${req.headers.host}`;
    res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/oauth/token`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code']
    });
});

app.get('/authorize', (req, res) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;
    if (client_id !== OAUTH_CLIENT_ID) { res.status(401).json({ error: 'invalid_client' }); return; }
    if (response_type !== 'code') { res.status(400).json({ error: 'unsupported_response_type' }); return; }
    if (!code_challenge) { res.status(400).json({ error: 'code_challenge required' }); return; }
    const code = randomUUID();
    authCodes[code] = { codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method || 'S256', redirectUri: redirect_uri, expiresAt: Date.now() + 5 * 60 * 1000 };
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.toString());
});

app.post('/oauth/token', (req, res) => {
    if (!OAUTH_CLIENT_ID || !AUTH_TOKEN) { res.status(500).json({ error: 'server_misconfigured' }); return; }
    const grant_type = req.body.grant_type;
    if (grant_type === 'authorization_code') {
        const { code, code_verifier, redirect_uri } = req.body;
        const stored = authCodes[code];
        if (!stored || stored.expiresAt < Date.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
        const expected = createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== stored.codeChallenge) { res.status(400).json({ error: 'invalid_grant' }); return; }
        if (redirect_uri && redirect_uri !== stored.redirectUri) { res.status(400).json({ error: 'invalid_grant' }); return; }
        delete authCodes[code];
        res.json({ access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: 86400 });
        return;
    }
    if (!OAUTH_CLIENT_SECRET) { res.status(500).json({ error: 'server_misconfigured' }); return; }
    let client_id, client_secret;
    const basicAuth = req.headers['authorization'];
    if (basicAuth?.startsWith('Basic ')) {
        const decoded = Buffer.from(basicAuth.slice(6), 'base64').toString();
        const colon = decoded.indexOf(':');
        client_id = decoded.slice(0, colon); client_secret = decoded.slice(colon + 1);
    } else { client_id = req.body.client_id; client_secret = req.body.client_secret; }
    if (client_id !== OAUTH_CLIENT_ID || client_secret !== OAUTH_CLIENT_SECRET) { res.status(401).json({ error: 'invalid_client' }); return; }
    res.json({ access_token: AUTH_TOKEN, token_type: 'Bearer', expires_in: 86400 });
});

// --- Bearer token middleware ---
app.use((req, res, next) => {
    if (['/health', '/authorize', '/oauth/token'].includes(req.path) || req.path.startsWith('/.well-known/')) return next();
    if (!AUTH_TOKEN) return next();
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="https://${req.headers.host}/.well-known/oauth-protected-resource"`).json({ error: 'Unauthorized' });
        return;
    }
    if (authHeader.slice(7) !== AUTH_TOKEN) {
        res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'Unauthorized' });
        return;
    }
    next();
});

function createSession(sessionId) {
  const bin = join(__dirname, 'node_modules', '.bin', 'mcp-server-trello');
  const proc = spawn('node', [bin], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const session = { proc, pending: new Map(), buffer: '', timer: null };

  proc.stdout.on('data', (chunk) => {
    session.buffer += chunk.toString();
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const resolver = session.pending.get(String(msg.id));
          if (resolver) {
            session.pending.delete(String(msg.id));
            resolver(msg);
          }
        }
      } catch { /* skip non-JSON stdout */ }
    }
  });

  proc.on('exit', () => {
    sessions.delete(sessionId);
    session.pending.forEach(resolve =>
      resolve({ jsonrpc: '2.0', error: { code: -32603, message: 'Process exited' }, id: null })
    );
  });

  resetTTL(sessionId, session);
  sessions.set(sessionId, session);
  return session;
}

function resetTTL(sessionId, session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    session.proc.kill();
    sessions.delete(sessionId);
  }, SESSION_TTL);
}

function sendRequest(session, message) {
  return new Promise((resolve, reject) => {
    const id = message.id ?? randomUUID();
    const msg = { ...message, id };
    const timeout = setTimeout(() => {
      session.pending.delete(String(id));
      reject(new Error('Request timed out'));
    }, 30_000);
    session.pending.set(String(id), (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    session.proc.stdin.write(JSON.stringify(msg) + '\n');
  });
}

app.post('/mcp', async (req, res) => {
  let sessionId = req.headers['mcp-session-id'];
  let session;

  if (sessionId && sessions.has(sessionId)) {
    // Active session found directly
    session = sessions.get(sessionId);
    resetTTL(sessionId, session);
  } else if (sessionId && sessionMap.has(sessionId)) {
    // Stale session ID — remap to active session
    const activeId = sessionMap.get(sessionId);
    if (sessions.has(activeId)) {
      console.log(`[SESSION] Remapped stale ${sessionId} -> active ${activeId}`);
      session = sessions.get(activeId);
      sessionId = activeId;
      resetTTL(sessionId, session);
    } else {
      // Mapped target is also gone — create fresh
      console.log(`[SESSION] Mapped target ${activeId} expired, creating new session for stale ${sessionId}`);
      sessionMap.delete(sessionId);
      const newId = randomUUID();
      session = createSession(newId);
      sessionMap.set(sessionId, newId);
      // Cap sessionMap at 100 entries
      if (sessionMap.size > 100) {
        const oldest = sessionMap.keys().next().value;
        sessionMap.delete(oldest);
      }
      console.log(`[SESSION] Created ${newId} for stale ${sessionId} (sessionMap size: ${sessionMap.size})`);
      sessionId = newId;
    }
  } else if (sessionId) {
    // Unknown session ID (e.g. after container restart) — create new and map
    const newId = randomUUID();
    session = createSession(newId);
    sessionMap.set(sessionId, newId);
    // Cap sessionMap at 100 entries
    if (sessionMap.size > 100) {
      const oldest = sessionMap.keys().next().value;
      sessionMap.delete(oldest);
    }
    console.log(`[SESSION] New session ${newId} for unknown stale ID ${sessionId} (sessionMap size: ${sessionMap.size})`);
    sessionId = newId;
  } else {
    // No session ID provided — fresh session
    sessionId = randomUUID();
    session = createSession(sessionId);
    console.log(`[SESSION] Brand new session ${sessionId}`);
  }

  res.setHeader('mcp-session-id', sessionId);

  const body = req.body;

  if (body.id == null) {
    session.proc.stdin.write(JSON.stringify(body) + '\n');
    return res.status(202).end();
  }

  try {
    const response = await sendRequest(session, body);
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: body.id ?? null });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.listen(PORT, () => console.log(`Trello MCP proxy on :${PORT}`));
