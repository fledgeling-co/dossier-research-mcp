import { capturePage, writeFixture } from '../capture.js';

const targets: [string, string][] = [
  ['rfc6265-cookies', 'https://www.rfc-editor.org/rfc/rfc6265.txt'],
  ['semver-2-0-0', 'https://semver.org/'],
  ['nvd-cve-2021-44228', 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228'],
  ['arxiv-2509-04499-deeptrace', 'https://arxiv.org/abs/2509.04499'],
  ['rfc2119-key-words', 'https://www.ietf.org/rfc/rfc2119.txt'],
  ['mdn-http-404', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404'],
  ['linkedin-feed-login-wall', 'https://www.linkedin.com/feed/'],
  ['x-home-script-wall', 'https://x.com/home'],
  ['sciencedirect-403', 'https://www.sciencedirect.com/science/article/pii/S0004370223002102'],
];
const root = new URL('../../../detector/', import.meta.url).pathname;
for (const [name, url] of targets) {
  const p = await capturePage(url);
  const block = writeFixture(root, name, p);
  console.log(`\n### ${name}\n${block}`);
}
