# Security

Dossier drives an agent that reads the open web on your behalf, and it holds a key that spends money. This is what it does about both.

---

## Security

Deep Research reads the open web for you, and Google's own documentation flags prompt injection from untrusted pages, exposure to malicious sites, and exfiltration risk when internal data meets web browsing. Dossier takes a position on each.

Citation verification is **SSRF-safe**. Those URLs came out of a model that was reading untrusted pages, so they get treated as untrusted input: scheme allowlist, DNS resolution checked against private, loopback, link-local and CGNAT ranges (`169.254.169.254` included), redirects followed manually and re-validated on every hop, explicit timeouts, response-size caps.

Private context goes through **File Search rather than a live endpoint**. Deep Research can call a remote `mcp_server` tool mid-run, so a poisoned page could in principle steer it into calling your tools. Grounding through Google's retrieval layer means there's no live endpoint for a compromised run to reach.

Anything that **sends your data somewhere** says so. `corpus_add_file` is annotated non-read-only and its description states plainly that the file leaves your machine.

Secrets stay out of **logs and fingerprints**. MCP auth headers are excluded from the dedupe hash, so rotating a token doesn't fork the key, and error messages carry no credential material.

Every boundary is **Zod-parsed, never cast**. API responses, stored records, config, model output, all of it.

---

---

## Spend is a security property too

An uncapped key is a security problem, not only a billing one. Dossier reserves a run's worst-case cost **before** the call is made, inside a lock, so a runaway agent gets refused rather than reconciled after the fact.

Treat Google's own cap as the backstop rather than the first line: their docs say long-running agents "may incur overages beyond your project spend cap", and their billing pipeline lags around ten minutes. Set both. [Setup](setup.md#3-set-a-spend-cap-at-googles-end) covers where.
