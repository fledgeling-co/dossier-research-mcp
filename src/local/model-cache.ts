import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CLI_IDS, normaliseModelName, modelFamily, type CliId } from './cli.js';

/**
 * What each CLI answered when it was asked which model it serves.
 *
 * The probe in `cli.ts` costs a model round trip against a subscription quota,
 * so asking on every detection would turn a free, sync, offline check into a
 * paid one. This is the memory that makes it a one-off: probe once, read the
 * answer from disk for ever after, and show how old the answer is so nobody
 * mistakes a reading from six weeks ago for a fact about today.
 *
 * ## Read sync, write async, deliberately
 *
 * Routing is sync, and panel assembly is what reads this, so the read is
 * `readFileSync` on a small file next to the checks that already resolve PATH
 * and stat sign-in files synchronously. The write only ever happens inside
 * `research_doctor`, which is async and in no hurry, so it gets the atomic
 * tmp-plus-rename treatment the store uses.
 *
 * ## Unreadable means unprobed, and that is the safe direction
 *
 * A corrupt file yields an empty map rather than an error. This is not the
 * fail-closed rule that governs the spend gate, and the difference is which way
 * the failure points: an empty cache makes the panel keep every CLI and say the
 * lane may hold duplicate models. Losing the file costs a warning. Trusting a
 * malformed one could drop a backend the user pays for.
 */

/** One CLI's answer, as stored. */
const EntrySchema = z.object({
  /** The model as the CLI named it, verbatim. */
  model: z.string().min(1).max(120),
  /** Epoch ms. What makes the age reportable rather than guessed at. */
  probedAt: z.number().int().positive(),
});

/**
 * The envelope. `entries` is loose on purpose: an unknown key is a CLI this
 * build does not know about, and skipping it beats failing the whole file.
 */
const CacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.unknown()),
});

/**
 * How long a probed model reading is trusted for dedupe.
 *
 * A CLI can change the model it serves in a release, and dropping a backend on
 * a reading from months ago means acting on a fact nobody has checked since.
 * Past this horizon the reading is still shown, with its age, but it no longer
 * removes anything from a panel: showing a stale label costs a confusing line
 * of text, while a stale dedupe costs a backend that silently never runs.
 */
export const MODEL_READING_TRUSTED_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a reading is recent enough to remove a backend from a panel. */
export function isFreshEnoughToDedupe(probedAt: number, now: number = Date.now()): boolean {
  return now - probedAt <= MODEL_READING_TRUSTED_MS;
}

export interface ProbedModel {
  /** The model as the CLI named it. */
  readonly model: string;
  /** Epoch ms of the probe. */
  readonly probedAt: number;
  /**
   * Punctuation-flattened, lower-cased. What the dedupe compares.
   *
   * Derived on read rather than persisted: a value on disk is a value that can
   * be edited to disagree with the name beside it, and a comparison key that
   * disagrees with its own model name is how a backend goes missing for a
   * reason nobody can reconstruct.
   */
  readonly normalised: string;
  /**
   * The model underneath the vendor's product id, for asking whether two
   * members share priors. `normalised` stays the display form.
   */
  readonly family: string;
}

const FILE = 'cli-models.json';

export function modelCachePath(storeDir: string): string {
  return join(storeDir, FILE);
}

/**
 * Every cached model answer, keyed by CLI id.
 *
 * Malformed *items* are skipped and a malformed *envelope* yields nothing, the
 * same split the run store uses: one bad record must not hide the rest, and a
 * file that is not this file at all must not be half-believed.
 */
export function readModelCache(storeDir: string): ReadonlyMap<CliId, ProbedModel> {
  const out = new Map<CliId, ProbedModel>();
  let raw: string;
  try {
    raw = readFileSync(modelCachePath(storeDir), 'utf8');
  } catch {
    return out;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return out;
  }

  const envelope = CacheSchema.safeParse(parsed);
  if (!envelope.success) return out;

  for (const [key, value] of Object.entries(envelope.data.entries)) {
    if (!(CLI_IDS as readonly string[]).includes(key)) continue;
    const entry = EntrySchema.safeParse(value);
    if (!entry.success) continue;
    out.set(key as CliId, {
      model: entry.data.model,
      probedAt: entry.data.probedAt,
      normalised: normaliseModelName(entry.data.model),
      family: modelFamily(entry.data.model),
    });
  }
  return out;
}

/**
 * Record what a probe found, merging into whatever is already there.
 *
 * Merge rather than replace: probing one CLI must not erase the answers for the
 * others, or a targeted re-probe would quietly un-probe the rest of the machine
 * and take the free-lane dedupe down with it.
 *
 * Only successful probes are written. A refusal or a timeout says nothing about
 * which model the CLI serves, so it leaves the previous answer alone rather
 * than replacing knowledge with a blank.
 */
export async function writeModelCache(
  storeDir: string,
  probed: ReadonlyMap<CliId, string>,
  now: number = Date.now(),
): Promise<void> {
  if (probed.size === 0) return;

  const merged: Record<string, { model: string; probedAt: number }> = {};
  for (const [id, entry] of readModelCache(storeDir)) {
    merged[id] = { model: entry.model, probedAt: entry.probedAt };
  }
  for (const [id, model] of probed) {
    merged[id] = { model: model.slice(0, 120), probedAt: now };
  }

  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const path = modelCachePath(storeDir);
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, entries: merged }, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * How old a probe is, in words.
 *
 * Every place a probed model is reported prints this beside it. A model
 * identity is a fact about a configuration the user can change at any time, so
 * an answer with no age on it is an answer that invites being trusted longer
 * than it deserves.
 */
export function describeProbeAge(probedAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - probedAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}
