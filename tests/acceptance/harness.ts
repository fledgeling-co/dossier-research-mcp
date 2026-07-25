import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import type { RunRecord } from '../../src/store/types.js';

/**
 * Acceptance harness: drives the REAL MCP protocol over stdio.
 *
 * The unit tests call the server's functions directly, which is fast and covers
 * the logic but skips the layer where a whole class of defects lives: a Zod
 * schema FastMCP rejects at registration, a tool that never appears in
 * `tools/list`, a response that violates its own `outputSchema`, a resource
 * template whose URI does not match. All of those pass `tsgo` and every unit
 * test, and all of them are total failures for a caller.
 *
 * So this spawns the actual server, speaks JSON-RPC to it, and asserts on what
 * a real MCP client would receive. It is the closest thing this project has to
 * an end-to-end test, and it is hermetic: no credentials, no network, no spend.
 *
 * Seeding runs through `Store` rather than the protocol on purpose. Getting a
 * run into `completed` or `stalled` through the API would cost money and take
 * an hour; seeding the state directly is what makes the whole state matrix
 * testable at all.
 */

interface Pending {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: {
    readonly content?: { readonly type: string; readonly text?: string }[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
    readonly [k: string]: unknown;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

export interface ToolResult {
  /** Concatenated text content, which is what an agent actually reads. */
  readonly text: string;
  /** True when the tool reported a handled failure (a UserError). */
  readonly isError: boolean;
  /** Present when the tool declares an outputSchema. */
  readonly structured: unknown;
  /** Set when the call failed at the protocol layer instead of in the tool. */
  readonly protocolError?: { readonly code: number; readonly message: string };
}

export class McpHarness {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly storeDir: string;
  readonly store: Store;
  /** stderr, kept so a test can assert the server said something on start-up. */
  readonly stderr: string[] = [];

  private constructor(storeDir: string) {
    this.storeDir = storeDir;
    this.store = new Store(storeDir);
  }

  static async create(env: Record<string, string> = {}): Promise<McpHarness> {
    const dir = await mkdtemp(join(tmpdir(), 'dossier-acc-'));
    const harness = new McpHarness(dir);
    await harness.store.init();
    await harness.start(env);
    return harness;
  }

  private async start(env: Record<string, string>): Promise<void> {
    // tsx over src rather than dist: the suite must test the current source,
    // and the gate runs build last so dist may be stale or absent.
    this.child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Hermetic by construction: even if a real key is exported in the
        // developer's shell, the server refuses to build a live client.
        DOSSIER_HERMETIC: '1',
        GEMINI_API_KEY: '',
        VERTEX_PROJECT: '',
        DOSSIER_STORE_DIR: this.storeDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString()));

    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'acceptance', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  /**
   * stdout is the protocol. Anything that is not a JSON-RPC line is a bug in
   * the server (a stray console.log corrupts the stream), so unparseable lines
   * are collected rather than ignored.
   */
  readonly stdoutNoise: string[] = [];

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.stdoutNoise.push(line);
        continue;
      }
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(message.id);
          waiter.resolve(message);
        }
      }
    }
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Call a tool and normalise the reply into something assertable. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const reply = await this.request('tools/call', { name, arguments: args });
    if (reply.error) {
      return { text: reply.error.message, isError: true, structured: undefined, protocolError: reply.error };
    }
    const text = (reply.result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return {
      text,
      isError: reply.result?.isError === true,
      structured: reply.result?.structuredContent,
    };
  }

  async listTools(): Promise<{ name: string; description?: string; annotations?: Record<string, unknown> }[]> {
    const reply = await this.request('tools/list', {});
    return (reply.result?.['tools'] ?? []) as { name: string; description?: string; annotations?: Record<string, unknown> }[];
  }

  async listResources(): Promise<{ uri: string; name?: string }[]> {
    const reply = await this.request('resources/list', {});
    return (reply.result?.['resources'] ?? []) as { uri: string; name?: string }[];
  }

  async listResourceTemplates(): Promise<{ uriTemplate: string }[]> {
    const reply = await this.request('resources/templates/list', {});
    return (reply.result?.['resourceTemplates'] ?? []) as { uriTemplate: string }[];
  }

  async readResource(uri: string): Promise<string> {
    const reply = await this.request('resources/read', { uri });
    const contents = (reply.result?.['contents'] ?? []) as { text?: string }[];
    return contents.map((c) => c.text ?? '').join('');
  }

  async listPrompts(): Promise<{ name: string }[]> {
    const reply = await this.request('prompts/list', {});
    return (reply.result?.['prompts'] ?? []) as { name: string }[];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<string> {
    const reply = await this.request('prompts/get', { name, arguments: args });
    const messages = (reply.result?.['messages'] ?? []) as { content?: { text?: string } }[];
    return messages.map((m) => m.content?.text ?? '').join('\n');
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    this.child?.kill();
    this.child = null;
    await rm(this.storeDir, { recursive: true, force: true });
  }
}

/**
 * Seed a run in any state. Named fields default to a realistic run so a test
 * states only the axis it is exercising.
 */
export function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  return {
    id: `dr_${Math.abs(hash(JSON.stringify(over))).toString(16).padStart(12, '0').slice(0, 12)}`,
    interactionId: 'int_seed',
    state: 'completed',
    tier: 'fast',
    archetype: 'technical',
    question: 'Which vector database has the lowest p99 latency?',
    prompt: '<core_directive>Answer this decisively: which one?</core_directive>',
    promptWasPreEngineered: false,
    fingerprint: 'seedfingerprint',
    createdAt: now,
    updatedAt: now,
    lastProgressAt: now,
    completedAt: now,
    estimatedCostUsd: 2,
    tags: [],
    planApproved: true,
    reportChars: 0,
    sourceCount: 0,
    imageCount: 0,
    reasoningSteps: 0,
    streamedChars: 0,
    searches: 0,
    urlsFetched: 0,
    corpusQueries: 0,
    codeRuns: 0,
    streamAbandoned: false,
    toolsUsed: ['google_search'],
    corpusStores: [],
    ...over,
  };
}

/** Deterministic id derivation, so a seeded run has a stable handle. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** A report covering the shapes `research_read` has to survive. */
export const REPORT_FIXTURES = {
  realistic: `# Vector Database Latency

## Executive Summary

- (High Confidence) Qdrant leads on p99. [docs](https://qdrant.tech/documentation/)
- (Low Confidence) Milvus may close the gap.

## Detailed Findings

### p99 at scale

Qdrant reports 12ms p99 at 10M vectors [source](https://qdrant.tech/benchmarks/).

## Evidence Table

| Claim | Source | Date | Type | URL |
|---|---|---|---|---|
| 12ms p99 | Qdrant | 2026-01 | Primary | https://qdrant.tech/benchmarks/ |

## Knowledge Gaps

- No independent replication.
`,
  /** No headings at all: the outline must still produce something usable. */
  headingless: 'Just a wall of prose with no structure whatsoever, repeated. '.repeat(20),
  /** Unicode, emoji and RTL, which break naive slicing. */
  unicode: `# 研究レポート 📊

## Executive Summary

- (High Confidence) اختبار النص العربي here.
- Emoji in a heading: 🔬🧪

## 詳細な調査結果

Content with combining characters: é̃ẽ and a zero-width space:\u200Bdone.
`,
  /** Long enough that every read mode has to clamp. */
  huge: `# Huge Report\n\n${Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\n${'Dense prose. '.repeat(60)}\n`).join('\n')}`,
  empty: '',
} as const;
