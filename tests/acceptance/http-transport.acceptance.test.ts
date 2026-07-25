import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * HTTP-01: the HTTP transport and its bearer auth.
 *
 * Previously verified only by hand, which meant a refactor could silently
 * remove the auth gate. It is automatable: pick a free port, start the server,
 * and drive it with fetch.
 *
 * The port is claimed by binding and immediately releasing rather than picking
 * a number. A hardcoded port collides with whatever else is on the machine,
 * and this suite already lost an hour to exactly that: another process held
 * IPv4 while the server bound IPv6, so curl reached the wrong server entirely.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const TOKEN = randomBytes(16).toString('hex');
let child: ChildProcess | null = null;
let base = '';
let storeDir = '';

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'acceptance-http', version: '1.0.0' },
  },
});

/** Both headers are required by the streamable-HTTP transport. */
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function post(auth?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS, ...(auth ? { authorization: auth } : {}) },
    body: INIT,
  });
}

beforeAll(async () => {
  const port = await freePort();
  // `localhost`, not `127.0.0.1`. FastMCP binds the hostname, which resolves
  // to IPv6 `::1` on this platform, so a v4 literal does not reach it. This
  // exact mismatch already cost an hour once when another process held v4 on
  // the same port and requests silently went to the wrong server.
  base = `http://localhost:${port}`;
  storeDir = await mkdtemp(join(tmpdir(), 'dossier-http-'));

  child = spawn('npx', ['tsx', 'src/index.ts', '--transport', 'http', '--port', String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOSSIER_HERMETIC: '1',
      GEMINI_API_KEY: '',
      VERTEX_PROJECT: '',
      DOSSIER_STORE_DIR: storeDir,
      DOSSIER_HTTP_TOKENS: TOKEN,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // Wait for the port to actually answer rather than sleeping a fixed time.
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('HTTP server did not start in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}, 60_000);

afterAll(async () => {
  child?.kill();
  await rm(storeDir, { recursive: true, force: true });
});

describe('HTTP-01: bearer auth on the HTTP transport', () => {
  it('serves health without auth, because a probe cannot hold a token', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it('rejects a request with no token', async () => {
    expect((await post()).status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    expect((await post('Bearer deadbeefdeadbeefdeadbeefdeadbeef')).status).toBe(401);
  });

  it('rejects a wrong token of the same length as the real one', async () => {
    // Length-equal is the case a naive comparison can leak on, and the case a
    // short-circuiting compare would pass. Both must be 401.
    const sameLength = randomBytes(16).toString('hex');
    expect(sameLength).toHaveLength(TOKEN.length);
    expect((await post(`Bearer ${sameLength}`)).status).toBe(401);
  });

  it('rejects the token without the Bearer scheme', async () => {
    expect((await post(TOKEN)).status).toBe(401);
  });

  it('accepts the correct token and completes a real MCP handshake', async () => {
    const res = await post(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Assert the handshake actually happened, not merely that it was a 200.
    expect(body).toContain('protocolVersion');
    expect(body).toContain('dossier');
  });

  it('rejects a malformed body with a client error, not a crash', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${TOKEN}` },
      body: 'not json at all',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // Still alive afterwards.
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
