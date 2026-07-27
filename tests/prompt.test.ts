import { describe, expect, it } from 'vitest';
import { selectArchetype } from '../src/research/archetypes.js';
import {
  buildPrompt,
  extractCoreDirective,
  isPreEngineered,
  operatorNotes,
} from '../src/research/prompt.js';

describe('selectArchetype', () => {
  it('picks technical for engineering questions', () => {
    expect(
      selectArchetype('Compare the API latency and rate limits of these two SDKs and their architecture'),
    ).toBe('technical');
  });

  it('picks regulatory for compliance questions', () => {
    expect(
      selectArchetype('What disclosure obligations does this regulation impose across each jurisdiction?'),
    ).toBe('regulatory');
  });

  it('picks academic for literature questions', () => {
    expect(
      selectArchetype('Systematic review of peer-reviewed studies: sample size and p-value reporting'),
    ).toBe('academic');
  });

  it('picks forecasting for outlook questions', () => {
    expect(selectArchetype('Five-year demand outlook and capex trend projection scenarios')).toBe(
      'forecasting',
    );
  });

  it('defaults to competitive when nothing matches', () => {
    expect(selectArchetype('Tell me about badgers')).toBe('competitive');
  });
});

describe('buildPrompt', () => {
  it('repeats the core directive exactly twice — the anti-drift anchor', () => {
    const { prompt } = buildPrompt({ question: 'Who leads the market for X?' });
    const opens = prompt.match(/<core_directive>/g) ?? [];
    expect(opens).toHaveLength(2);
    // ...and the last block is the final thing in the prompt.
    expect(prompt.trimEnd().endsWith('</core_directive>')).toBe(true);
  });

  it('applies exactly one archetype override set, never a blend', () => {
    const { prompt } = buildPrompt({ question: 'anything', archetype: 'regulatory' });
    expect(prompt).toContain('REGULATORY_MAPPING_ONLY');
    // The competitive archetype's signature instruction must not leak in.
    expect(prompt).not.toContain('underserved gaps');
  });

  it('threads scope into the brief', () => {
    const { prompt } = buildPrompt({
      question: 'What are the rules?',
      scope: {
        jurisdiction: 'Australia',
        timeHorizon: '2024 to present',
        decisionContext: 'inform a board paper',
        exclude: ['consumer applications'],
        analysisLenses: ['cost to a 10-person team'],
      },
    });
    expect(prompt).toContain('Australia');
    expect(prompt).toContain('2024 to present');
    expect(prompt).toContain('inform a board paper');
    expect(prompt).toContain('consumer applications');
    expect(prompt).toContain('cost to a 10-person team');
  });

  it('mandates inline citation and epistemic bounding', () => {
    const { prompt } = buildPrompt({ question: 'q' });
    expect(prompt).toContain('<citation_protocol>');
    expect(prompt).toContain('MISSING_DATA');
    expect(prompt).toContain('CONFLICTING_EVIDENCE');
  });
});

describe('pre-engineered passthrough', () => {
  const engineered = `<role>
You are a senior research analyst.
</role>

<core_directive>
Answer this decisively: does X beat Y?
</core_directive>

<output_format>
## Executive Summary
</output_format>`;

  it('detects a scaffolded brief', () => {
    expect(isPreEngineered(engineered)).toBe(true);
    expect(isPreEngineered('What is the market size for X?')).toBe(false);
  });

  it('detects on two structural tags even without a core directive', () => {
    expect(
      isPreEngineered('<research_questions>\n1. a\n</research_questions>\n<source_discipline>x</source_discipline>'),
    ).toBe(true);
  });

  it('passes an engineered brief through verbatim rather than re-wrapping it', () => {
    const built = buildPrompt({ question: engineered });
    expect(built.preEngineered).toBe(true);
    expect(built.prompt).toBe(engineered.trim());
    // Crucially: exactly one <role> — no double scaffold.
    expect((built.prompt.match(/<role>/g) ?? []).length).toBe(1);
  });

  it('extracts the core directive for labelling', () => {
    expect(extractCoreDirective(engineered)).toBe('Answer this decisively: does X beat Y?');
    expect(extractCoreDirective('Plain question here')).toBe('Plain question here');
  });
});

describe('operatorNotes', () => {
  it('leads with plan review when collaborative planning is on', () => {
    const notes = operatorNotes({
      archetype: 'competitive',
      tier: 'fast',
      collaborativePlanning: true,
      hasCorpus: false,
      questionLength: 40,
    });
    expect(notes[0]).toContain('Plan Review is ON');
  });

  it('warns that autonomous execution is the wrong default when planning is off', () => {
    const notes = operatorNotes({
      archetype: 'competitive',
      tier: 'fast',
      collaborativePlanning: false,
      hasCorpus: false,
      questionLength: 40,
    });
    expect(notes[0]).toContain('OFF');
  });

  it('adds the hierarchy-of-truth note only when a corpus is attached', () => {
    const withCorpus = operatorNotes({
      archetype: 'technical',
      tier: 'fast',
      collaborativePlanning: false,
      hasCorpus: true,
      questionLength: 40,
    });
    expect(withCorpus.some((n) => n.includes('Hierarchy of truth'))).toBe(true);

    const without = operatorNotes({
      archetype: 'technical',
      tier: 'fast',
      collaborativePlanning: false,
      hasCorpus: false,
      questionLength: 40,
    });
    expect(without.some((n) => n.includes('Hierarchy of truth'))).toBe(false);
  });

  it('adds the not-legal-advice note for regulatory work', () => {
    const notes = operatorNotes({
      archetype: 'regulatory',
      tier: 'max',
      collaborativePlanning: false,
      hasCorpus: false,
      questionLength: 40,
    });
    expect(notes.some((n) => n.includes('not legal advice'))).toBe(true);
  });
});

describe('corpus grounding placement', () => {
  it('puts the corpus block BEFORE the final re-anchor, never after it', () => {
    // This is the bug that shipped once. Appending the block after the closing
    // <core_directive> put it in the weakest position in the prompt and killed
    // the anti-drift anchor; a live run with the corpus indexed and the tool
    // attached produced a 12,660-token report with zero references to it.
    const { prompt } = buildPrompt({ question: 'Should we keep X disabled?', corpusGrounding: true });
    const corpusAt = prompt.indexOf('<corpus_grounding>');
    const lastAnchor = prompt.lastIndexOf('<core_directive>');
    expect(corpusAt).toBeGreaterThan(-1);
    expect(corpusAt).toBeLessThan(lastAnchor);
    // Nothing at all may follow the re-anchor.
    expect(prompt.trimEnd().endsWith('</core_directive>')).toBe(true);
  });

  it('adds the contradictions section to output_format, where output rules live', () => {
    const { prompt } = buildPrompt({ question: 'q', corpusGrounding: true });
    const outputAt = prompt.indexOf('<output_format>');
    const outputEnd = prompt.indexOf('</output_format>');
    const contradictionsAt = prompt.indexOf('Contradictions with the attached corpus');
    expect(contradictionsAt).toBeGreaterThan(outputAt);
    expect(contradictionsAt).toBeLessThan(outputEnd);
  });

  it('omits both when no corpus is attached', () => {
    const { prompt } = buildPrompt({ question: 'q' });
    expect(prompt).not.toContain('corpus_grounding');
    expect(prompt).not.toContain('Contradictions with the attached corpus');
  });
});

describe('prior research placement', () => {
  // GROUND-15
  it('puts the prior-research block BEFORE the final re-anchor, never after it', () => {
    // Exactly the rule the corpus block is held to, and for exactly the same
    // reason: the closing directive re-anchors synthesis after an hour of
    // recursive search, and it only works because it is last.
    const { prompt } = buildPrompt({ question: 'Has X changed since?', priorResearchRuns: 2 });
    const priorAt = prompt.indexOf('<prior_research>');
    const lastAnchor = prompt.lastIndexOf('<core_directive>');
    expect(priorAt).toBeGreaterThan(-1);
    expect(priorAt).toBeLessThan(lastAnchor);
    expect(prompt.trimEnd().endsWith('</core_directive>')).toBe(true);
    expect((prompt.match(/<core_directive>/g) ?? [])).toHaveLength(2);
  });

  // GROUND-16
  it('carries the count and the rule, and no text from the prior reports', () => {
    const { prompt } = buildPrompt({ question: 'Has X changed?', priorResearchRuns: 3 });
    expect(prompt).toContain('3 earlier Dossier research runs');
    expect(prompt).toContain('never independent corroboration');
    expect(prompt).toContain('Count support in independent sources, never in reports');
  });

  it('sits alongside corpus grounding rather than displacing it', () => {
    const { prompt } = buildPrompt({
      question: 'q',
      corpusGrounding: true,
      priorResearchRuns: 1,
    });
    const lastAnchor = prompt.lastIndexOf('<core_directive>');
    expect(prompt.indexOf('<corpus_grounding>')).toBeLessThan(lastAnchor);
    expect(prompt.indexOf('<prior_research>')).toBeLessThan(lastAnchor);
    expect(prompt.trimEnd().endsWith('</core_directive>')).toBe(true);
  });

  it('omits the block when the run was grounded in nothing', () => {
    expect(buildPrompt({ question: 'q' }).prompt).not.toContain('prior_research');
    expect(buildPrompt({ question: 'q', priorResearchRuns: 0 }).prompt).not.toContain('prior_research');
  });
});
