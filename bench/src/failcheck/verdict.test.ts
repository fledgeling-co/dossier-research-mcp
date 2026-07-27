import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../tasks/index.js';
import type { BenchTask } from '../tasks/corpus.js';
import { probeTask, summariseProbes } from './verdict.js';

const NOW = new Date('2026-07-27T00:00:00Z');

function taskFrom(yaml: string): BenchTask {
  const corpus = loadCorpus([{ file: 'x.yaml', text: yaml }], { now: NOW });
  const task = corpus.tasks[0];
  if (task === undefined) throw new Error('fixture did not load');
  return task;
}

const TWO_FACTS = `
id: two-facts
category: technical
question: Which version was published, and on what date was it published?
asOf: 2026-07-01
reverifiedAt: 2026-07-20
goldFacts:
  - id: version
    kind: identifier
    value: '8.9.0'
    source: { url: https://example.org/a }
  - id: released
    kind: date
    value: 2026-07-24
    source: { url: https://example.org/a }
`;

const REFUSAL_ONLY = `
id: refusal-only
category: obscure-entity
question: What score does the register publish for this entry, if any at all?
asOf: 2026-07-01
reverifiedAt: 2026-07-20
expectedRefusal:
  kind: no-public-footprint
  acknowledgementTerms: ['publishes no score']
`;

describe('probeTask', () => {
  it('calls a task already-passed when every gold answer is present', () => {
    const probe = probeTask(taskFrom(TWO_FACTS), 'Version 8.9.0, published 2026-07-24.');
    expect(probe.verdict).toBe('already-passed');
    expect(probe.factsPresent).toBe(2);
  });

  it('calls it partial when only some answers are present, which is admissible', () => {
    const probe = probeTask(taskFrom(TWO_FACTS), 'I believe it was 8.9.0 but I cannot date it.');
    expect(probe.verdict).toBe('partial');
    expect(probe.presentFactIds).toEqual(['version']);
  });

  it('calls it fails when none are present', () => {
    const probe = probeTask(taskFrom(TWO_FACTS), 'I do not know.');
    expect(probe.verdict).toBe('fails');
  });

  it('distinguishes an empty response from a wrong one', () => {
    expect(probeTask(taskFrom(TWO_FACTS), '   ').verdict).toBe('no-response');
  });

  it('uses the verifier’s own value matching, so both agree what present means', () => {
    // `8 July 2026` is the long form of the ISO date, and the verifier counts it.
    const probe = probeTask(
      taskFrom(`
id: date-form
category: technical
question: On what date was this particular version published to the registry?
asOf: 2026-07-01
reverifiedAt: 2026-07-20
goldFacts:
  - id: released
    kind: date
    value: 2026-07-08
    source: { url: https://example.org/a }
`),
      'It went out on 8 July 2026.',
    );
    expect(probe.verdict).toBe('already-passed');
  });

  it('counts a refusal task as passed when the acknowledgement is asserted', () => {
    const probe = probeTask(taskFrom(REFUSAL_ONLY), 'The register publishes no score for it.', {
      mode: 'search',
    });
    expect(probe.verdict).toBe('already-passed');
    expect(probe.refusalAcknowledged).toBe(true);
  });

  it('claims nothing about a fact-free refusal task probed closed-book', () => {
    // The load-bearing case. A toolless model cannot know that a publisher
    // records nothing, and its honest "I don't know" is written in the same
    // words as a correct refusal — a real run reasoned aloud about a phrasing
    // it was explicitly declining to assert, and a literal match scored it as
    // a pass. Saying `not-applicable` is what that run actually established.
    const probe = probeTask(
      taskFrom(REFUSAL_ONLY),
      'I do not know. Saying it publishes no score would be a guess.',
      { mode: 'closed-book' },
    );
    expect(probe.verdict).toBe('not-applicable');
  });

  it('still measures a refusal task that carries a corrective gold fact', () => {
    const probe = probeTask(
      taskFrom(`
id: false-premise-with-fact
category: false-premise
question: Which CVE identifier covers the flaw described in the question above?
asOf: 2026-07-01
reverifiedAt: 2026-07-20
expectedRefusal:
  kind: false-premise
  fabricatedTerms: ['CVE-2026-0001']
  acknowledgementTerms: ['no such CVE']
goldFacts:
  - id: real
    kind: identifier
    value: CVE-2026-53488
    source: { url: https://example.org/a }
`),
      'There is no such CVE as CVE-2026-0001; the real one is CVE-2026-53488.',
      { mode: 'closed-book' },
    );
    expect(probe.verdict).toBe('already-passed');
    expect(probe.fabricatedTermsMentioned).toBe(true);
  });

  it('records the response opening so a surprising verdict can be adjudicated', () => {
    const probe = probeTask(taskFrom(TWO_FACTS), 'Version 8.9.0 on 2026-07-24.');
    expect(probe.responseExcerpt).toContain('8.9.0');
  });
});

describe('summariseProbes', () => {
  it('counts every verdict, including the ones that establish nothing', () => {
    const task = taskFrom(TWO_FACTS);
    const refusal = taskFrom(REFUSAL_ONLY);
    const report = summariseProbes(
      [
        probeTask(task, 'Version 8.9.0, published 2026-07-24.'),
        probeTask(task, 'It was 8.9.0.'),
        probeTask(task, 'No idea.'),
        probeTask(task, ''),
        probeTask(refusal, 'I do not know.', { mode: 'closed-book' }),
      ],
      { mode: 'closed-book', backend: 'claude', checkedAt: '2026-07-27' },
    );
    expect(report).toMatchObject({
      alreadyPassed: 1,
      partial: 1,
      fails: 1,
      noResponse: 1,
      notApplicable: 1,
    });
  });
});
