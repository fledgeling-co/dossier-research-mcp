import { access, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config.js';
import { GeminiRequestError, MissingCredentialsError } from '../gemini/client.js';

/**
 * Private-corpus grounding via File Search stores.
 *
 * The most valuable output of a research run over a team's own material is not
 * what the web says — it is *where the web disagrees with what the team already
 * believes*. That needs the run to read both, which means the private documents
 * have to be somewhere the researcher can search. File Search stores are that
 * place, and `research_start` attaches them as a `file_search` tool.
 *
 * Uploading a document to Google is an outbound disclosure of that document.
 * The tools that call this are annotated non-read-only and say so in their
 * descriptions, so an agent cannot ship a workspace's private files to a third
 * party while believing it made a local call.
 */

export interface CorpusStore {
  /** Full resource name, e.g. `fileSearchStores/my-store-123a456b789c`. */
  readonly name: string;
  readonly displayName?: string;
  readonly activeDocuments?: number;
  readonly pendingDocuments?: number;
  readonly createTime?: string;
}

export interface CorpusClient {
  createStore(displayName: string): Promise<CorpusStore>;
  listStores(): Promise<CorpusStore[]>;
  deleteStore(name: string): Promise<void>;
  uploadFile(args: {
    readonly storeName: string;
    readonly filePath: string;
    readonly displayName?: string;
    readonly mimeType?: string;
  }): Promise<{ readonly displayName: string }>;
}

/** Store resource names are used in API paths — constrain them. */
const STORE_NAME = /^fileSearchStores\/[A-Za-z0-9_-]{1,120}$/;

export function assertStoreName(name: string): string {
  if (!STORE_NAME.test(name)) {
    throw new Error(
      `Invalid file search store name: "${name.slice(0, 60)}". Expected the form fileSearchStores/<id>.`,
    );
  }
  return name;
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** The API caps `pageSize` at 20; asking for more is a 400, not a clamp. */
const STORE_PAGE_SIZE = 20;

/**
 * The SDK infers mimeType from the file extension and throws outright when it
 * cannot — which it does for `.md`, the single most likely thing anyone wants
 * to put in a research corpus. Infer the common documentation types ourselves
 * and fall back to `text/plain`, so a corpus upload does not fail on a README.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'text/xml',
  '.rtf': 'application/rtf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

export function inferMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'text/plain';
  return MIME_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? 'text/plain';
}

export function createCorpusClient(config: Config): CorpusClient {
  if (config.auth.mode === 'none') throw new MissingCredentialsError();
  if (config.auth.mode === 'vertex') {
    throw new Error(
      'File Search stores are a Gemini Developer API feature and are not available on Vertex. Set GEMINI_API_KEY to use corpus grounding.',
    );
  }

  const genai = new GoogleGenAI({ apiKey: config.auth.apiKey });
  const stores = genai.fileSearchStores;

  return {
    async createStore(displayName) {
      try {
        const created = await stores.create({ config: { displayName } });
        return {
          name: created.name ?? '',
          ...(created.displayName ? { displayName: created.displayName } : {}),
        };
      } catch (e: unknown) {
        throw new GeminiRequestError('fileSearchStores.create', e);
      }
    },

    async listStores() {
      try {
        const pager = await stores.list({ config: { pageSize: STORE_PAGE_SIZE } });
        const out: CorpusStore[] = [];
        for await (const store of pager) {
          out.push({
            name: store.name ?? '',
            ...(store.displayName ? { displayName: store.displayName } : {}),
            ...(store.activeDocumentsCount
              ? { activeDocuments: Number(store.activeDocumentsCount) }
              : {}),
            ...(store.pendingDocumentsCount
              ? { pendingDocuments: Number(store.pendingDocumentsCount) }
              : {}),
            ...(store.createTime ? { createTime: store.createTime } : {}),
          });
        }
        return out;
      } catch (e: unknown) {
        throw new GeminiRequestError('fileSearchStores.list', e);
      }
    },

    async deleteStore(name) {
      try {
        await stores.delete({ name: assertStoreName(name), config: { force: true } });
      } catch (e: unknown) {
        throw new GeminiRequestError('fileSearchStores.delete', e);
      }
    },

    async uploadFile(args) {
      const storeName = assertStoreName(args.storeName);
      const path = isAbsolute(args.filePath) ? args.filePath : resolve(args.filePath);
      await access(path).catch(() => {
        throw new Error(`File not found: ${path}`);
      });
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`Not a file: ${path}`);
      if (info.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `File is ${(info.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB cap.`,
        );
      }
      const displayName = args.displayName ?? basename(path);
      try {
        await stores.uploadToFileSearchStore({
          fileSearchStoreName: storeName,
          file: path,
          config: {
            displayName,
            mimeType: args.mimeType ?? inferMimeType(path),
          },
        });
      } catch (e: unknown) {
        throw new GeminiRequestError('fileSearchStores.uploadToFileSearchStore', e);
      }
      return { displayName };
    },
  };
}

export function resolveCorpusClient(config: Config): CorpusClient | null {
  if (config.hermetic || config.auth.mode !== 'api-key') return null;
  return createCorpusClient(config);
}
