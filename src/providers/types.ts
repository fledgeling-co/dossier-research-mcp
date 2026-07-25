import type { DeepResearchClient } from '../gemini/client.js';
import type { CostBand, DurationEstimate, DurationOptions } from '../gemini/cost.js';

/**
 * The provider layer.
 *
 * Dossier's durable runs, worst-case spend reservation, outline-first reads and
 * citation verification were always provider-neutral infrastructure with
 * exactly one provider bolted to it. This is the seam that lets a second one in.
 *
 * A provider is deliberately built *on* `DeepResearchClient` rather than
 * replacing it: the runner already speaks that language, so adding a backend
 * must not require touching the lifecycle code that took the longest to get
 * right. A provider is therefore a client plus three things the runner cannot
 * infer: what it can do, whether it is usable, and what it will cost.
 */

export const PROVIDER_IDS = ['gemini', 'perplexity', 'openai', 'xai', 'local'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The four artefact shapes a research request can want. */
export const SHAPES = ['deep', 'wide', 'recent', 'corpus'] as const;
export type Shape = (typeof SHAPES)[number];

export type DateFilterKind = 'none' | 'recency-bucket' | 'range';
export type CorpusKind = 'none' | 'file-search' | 'vector-store' | 'collections' | 'local';

/**
 * What a backend can actually do.
 *
 * This is routing input, not documentation. Two entries carry most of the
 * weight: only Gemini offers an editable plan before spending, and only xAI
 * reaches X. Neither is a matter of degree, so no budget on another provider
 * substitutes for them.
 *
 * Capabilities attach to a provider **and its configured model**, never to a
 * provider name alone. `o3-deep-research` could not be schema-forced and
 * `gpt-5.6-sol` can, so a matrix keyed on "openai" was wrong within months.
 */
export interface Capabilities {
  readonly shapes: readonly Shape[];
  /** Survives the client disconnecting. */
  readonly background: boolean;
  /** An editable research plan before any money is spent. */
  readonly planReview: boolean;
  /** Question a finished report without paying for a second run. */
  readonly followUp: boolean;
  readonly dateFilter: DateFilterKind;
  /** 0 when unsupported, else the maximum number of domains. */
  readonly domainFilter: number;
  readonly corpus: CorpusKind;
  /** Social corpora reachable, e.g. 'x'. */
  readonly socialSources: readonly string[];
  /** Can the answer be forced into a schema. */
  readonly structuredOutput: boolean;
  /** Can it write results to a file we can download. */
  readonly fileOutput: boolean;
  readonly maxWallClockMinutes: number;
  /** Anything a caller would be annoyed to discover later. */
  readonly limitations: readonly string[];
}

export type CredentialState = 'ready' | 'configured-unverified' | 'not-configured' | 'broken';

export interface CredentialStatus {
  readonly state: CredentialState;
  /** Human-readable, never containing the credential itself. */
  readonly detail: string;
  /** The one command or variable that would move this to `ready`. */
  readonly fix?: string;
}

export interface ProviderEstimate {
  readonly cost: CostBand;
  readonly duration: DurationEstimate;
}

export interface ResearchProvider {
  readonly id: ProviderId;
  /** Shown to users; the provider's own name for itself. */
  readonly label: string;
  readonly capabilities: Capabilities;

  /**
   * Credential check. Pure and offline by contract: a slow or failing provider
   * must never delay the server coming up, and `research_doctor` promotes
   * `configured-unverified` to `ready` with an explicit opt-in call.
   */
  detect(): CredentialStatus;

  /** Cheap, offline, always a band. Feeds the spend gate. */
  estimate(input: DurationOptions): ProviderEstimate;

  /**
   * The run client. Throws when credentials are absent, rather than returning
   * null, so a caller that reached here without checking `detect()` gets a
   * message naming the missing variable instead of a null dereference.
   */
  client(): DeepResearchClient;
}

/**
 * Drop keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and Zod emits the latter for an optional field that was not
 * supplied. Without this, a validated options object will not satisfy the
 * interface it was validated against.
 */
export function compact<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
