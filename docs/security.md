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

## Fixed after an external review, July 2026

A `gpt-5.6-sol` review of the codebase found real defects. Recording them here because a security page that only lists what was always fine is not a security page.

| Was | Now |
|---|---|
| `[::ffff:127.0.0.1]` reached loopback, and `::ffff:169.254.169.254` reached the cloud metadata endpoint. The URL parser canonicalises those to hex, and the guard matched dotted-quad text | Byte-level range checks covering IPv4-mapped, IPv4-compatible, NAT64 and 6to4 |
| Link-local was `startsWith('fe80')`; the range is `fe80::/10`, so `fe90::` through `febf::` passed | Full `/10` check |
| DNS was validated, then `fetch` resolved again. A hostile zone could answer public for the check and private for the connection | The socket is pinned to the validated address; Host header and TLS SNI unchanged |
| `DOSSIER_HERMETIC=treu` silently disabled hermetic mode and permitted live calls | Unrecognised boolean values fail startup |
| A caller-supplied regex ran against every report line, so `(a+)+$` could block the event loop | Nested quantifiers rejected before compiling |
| `javascript:` and `file:` citations rendered as clickable markdown links | Non-http schemes render as inert code |
| Store files inherited the umask, so reports, prompts and the ledger were world-readable | `0600` files, `0700` directories |
| Corrupting the ledger *raised* the spend ceiling, because unparseable lines vanished from committed spend | Unreadable lines are charged at worst case; an unreadable ledger throws rather than reading as zero |

### Closed since: cross-process admission control

The spend and concurrency gates used an in-process mutex, so two MCP clients configured with Dossier were two processes on one store, each seeing headroom the other had claimed. There is now a cross-process advisory lock (`src/store/file-lock.ts`) around admission, chosen over SQLite because the plain-JSON store is worth keeping and this closes the specific race in about eighty lines with no format change.

Proven by a test that spawns real OS processes: with a $15 ceiling and $7 per run, three racing processes admit exactly two. Against the previous implementation the same test admits three and commits $21.

Not covered by this: a store on NFS, where `O_EXCL` create is unreliable. The store is a local per-user directory by default.

### Also hardened

- **HTTP with no tokens now refuses to start.** It previously printed a warning and served every tool, including the ones that spend money, to anyone who could reach the port. `DOSSIER_HTTP_ALLOW_ANONYMOUS=1` is the deliberate opt-in for a port already protected by something else.
- **Unknown CLI arguments are rejected.** `--http` (a plausible guess for `--transport http`) used to be ignored, silently starting a stdio server instead of the one you asked for.

### Still open

**Read-modify-write outside admission.** Refresh, cancellation and journal appends serialise within a process but not across them. They cannot overspend, so the consequence is a lost update rather than a lost dollar. If that ever needs the same guarantee, the honest answer is SQLite rather than more lock files.
