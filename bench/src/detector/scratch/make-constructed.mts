import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeConstructedFixture } from '../capture.js';

const root = new URL('../../../detector/', import.meta.url).pathname;
const pages = join(root, 'pages');

// 1. ScienceDirect 403, with the two identifiers the live block page echoed back
//    at the caller removed. The real capture carried this machine's public IP
//    address and a Cloudflare reference number; neither belongs in a committed
//    fixture, and redacting them makes this a constructed page rather than a
//    captured one.
const sd = readFileSync(join(pages, 'sciencedirect-403.txt'), 'utf8')
  .replace(/Reference number:\s+\S+/, 'Reference number:  [redacted]')
  .replace(/IP Address:\s+\S+/, 'IP Address:  [redacted]');
console.log('### sciencedirect-403\n' + writeConstructedFixture(root, 'sciencedirect-403', {
  text: sd,
  capturedAt: '2026-07-27',
  verdict: 'blocked',
  httpStatus: 403,
  completeHtml: false,
  note: 'Captured from ScienceDirect on 2026-07-27 and edited: the live block page echoes the requesting IP address and a Cloudflare reference number back at the caller, and neither belongs in a committed fixture.',
}));

// 2. A cookie-consent interstitial. Constructed, because a real one differs by
//    region, by cookie jar and by week, so freezing one freezes a photograph of
//    a moving thing. Written to the shape those pages actually take: HTTP 200,
//    a full HTML document, and no article text at all.
const consent = [
  'We value your privacy',
  '',
  'We and our 847 partners store and access information on a device, such as cookies,',
  'and process personal data, such as unique identifiers and standard information sent',
  'by a device, for personalised advertising and content, advertising and content',
  'measurement, audience research and services development.',
  '',
  'With your permission we and our partners may use precise geolocation data and',
  'identification through device scanning.',
  '',
  'Accept all      Reject all      Manage preferences',
  '',
  'You can change your choice at any time in our privacy centre.',
  'Some of our partners process your data on the basis of legitimate interest.',
  'Privacy policy   Cookie policy   Terms of use',
].join('\n');
console.log('\n### consent-wall\n' + writeConstructedFixture(root, 'consent-wall', {
  text: consent,
  capturedAt: '2026-07-27',
  verdict: 'live',
  httpStatus: 200,
  completeHtml: true,
  note: 'A cookie-consent interstitial, written to the shape those pages take rather than frozen from one: a real consent wall differs by region, by cookie jar and by week. HTTP 200 and a complete HTML document carrying no article text, which is exactly why link checking cannot see it.',
}));

// 3. The captured RFC 6265 text, cut short at 4000 characters with `truncated`
//    set. What a byte cap produces, and the case containment must abstain on.
const rfc = readFileSync(join(pages, 'rfc6265-cookies.txt'), 'utf8').slice(0, 4000);
console.log('\n### rfc6265-truncated\n' + writeConstructedFixture(root, 'rfc6265-truncated', {
  text: rfc,
  capturedAt: '2026-07-27',
  verdict: 'live',
  httpStatus: 200,
  completeHtml: false,
  note: 'The first 4000 characters of the captured RFC 6265 text, which is what the collector’s byte cap produces on a long document. The case that goes with it carries `truncated: true`.',
}));
