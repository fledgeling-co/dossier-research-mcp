#!/usr/bin/env node
/**
 * Verify every internal markdown link and heading anchor across the docs set.
 *
 * A doc split is exactly when internal links break, and they break silently:
 * nothing typechecks a README. This ran by hand five times during the
 * multi-provider docs work and caught five genuinely broken links, so it lives
 * in the repo now rather than in someone's shell history.
 *
 * One subtlety worth preserving: GitHub's heading slugs keep underscores and
 * hyphens and strip everything else. An earlier version of this stripped
 * underscores too, which reported `#research_doctor` as broken when it was
 * fine. A link checker that cries wolf gets ignored, so the slugify below
 * matches GitHub's rules deliberately.
 */
import { readFileSync, statSync, globSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';

const FILES = [
  ...globSync('docs/**/*.md'),
  ...globSync('blog/**/*.md'),
  'README.md',
  'CLAUDE.md',
].sort();

/** GitHub slugify: lowercase, drop inline markup, keep [a-z0-9_-], spaces to hyphens. */
function anchors(file) {
  const out = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const slug = m[1]
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[`*[\]()]/g, '')
      .replace(/[^a-z0-9\s_-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
    out.add(slug);
  }
  return out;
}

const broken = [];
let linkCount = 0;

for (const file of FILES) {
  const body = readFileSync(file, 'utf8');
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = m[1].trim();
    if (link.startsWith('http') || link.startsWith('mailto:')) continue;
    linkCount += 1;

    if (link.startsWith('#')) {
      if (!anchors(file).has(link.slice(1))) broken.push([file, link, 'anchor missing here']);
      continue;
    }

    const [path, frag] = link.split('#');
    const target = resolve(dirname(file), decodeURIComponent(path));
    // statSync, not readFileSync: a link to a directory is valid on GitHub and
    // reading one throws. The first version of this reported every directory
    // link as missing.
    let stat;
    try {
      stat = statSync(target);
    } catch {
      broken.push([file, link, 'file missing']);
      continue;
    }
    if (frag && stat.isFile() && extname(target) === '.md' && !anchors(target).has(frag)) {
      broken.push([file, link, 'anchor missing in target']);
    }
  }
}

console.log(`Checked ${linkCount} internal links across ${FILES.length} files.`);
if (broken.length === 0) {
  console.log('All internal links and anchors resolve.');
  process.exit(0);
}
for (const [file, link, why] of broken) console.error(`BROKEN  ${file} -> ${link}  (${why})`);
process.exit(1);
