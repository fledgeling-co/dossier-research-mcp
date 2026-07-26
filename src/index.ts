#!/usr/bin/env node
import { backendLimitations, describeAuth, loadConfig } from './config.js';
import { buildDeps, createServer } from './server.js';
import { version } from './version.js';

/**
 * CLI entry point.
 *
 *   dossier-research-mcp                    # stdio (the default; what MCP clients use)
 *   dossier-research-mcp --transport http   # streamable HTTP on DOSSIER_HTTP_PORT
 *   dossier-research-mcp setup              # the guided setup, for a human
 *
 * Nothing is written to stdout except the MCP protocol itself — on stdio, a
 * stray `console.log` corrupts the stream and the client sees a parse error
 * rather than a message. Every diagnostic goes to stderr.
 */

interface Args {
  readonly transport: 'stdio' | 'http';
  readonly port?: number;
}

/**
 * The setup wizard runs before anything else and never touches the server.
 *
 * It is interactive by definition, so it is refused outright when stdout is not
 * a terminal: an MCP client launching this binary must get the protocol, and a
 * wizard drawing prompts into that stream would look like a corrupt server
 * rather than a mistake.
 */
async function maybeRunSetup(argv: readonly string[]): Promise<number | null> {
  if (!argv.includes('setup') && !argv.includes('--setup')) return null;
  if (!process.stdout.isTTY) {
    process.stderr.write('`setup` needs an interactive terminal. Run it directly rather than through an MCP client.\n');
    return 1;
  }
  const { runWizard } = await import('./setup/wizard.js');
  return runWizard();
}

function parseArgs(argv: readonly string[]): Args {
  let transport: 'stdio' | 'http' = 'stdio';
  let port: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--transport') {
      const value = argv[i + 1];
      if (value !== 'stdio' && value !== 'http') {
        throw new Error(`--transport must be "stdio" or "http" (got "${value ?? ''}")`);
      }
      transport = value;
      i += 1;
    } else if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`--port must be a valid port number (got "${argv[i + 1] ?? ''}")`);
      }
      port = value;
      i += 1;
    } else if (arg === '--version' || arg === '-v') {
      process.stderr.write(`dossier-research-mcp ${version}\n`);
      process.exit(0);
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(USAGE);
      process.exit(0);
    } else {
      // Unknown flags used to be ignored, so `--http` (a plausible guess for
      // `--transport http`) silently started a stdio server and the operator
      // got no hint that the thing they asked for did not happen.
      throw new Error(`Unknown argument "${arg ?? ''}". Run with --help for usage.`);
    }
  }
  return { transport, ...(port !== undefined ? { port } : {}) };
}

const USAGE = `dossier-research-mcp ${version}

MCP server for Google Gemini Deep Research.

Usage:
  dossier-research-mcp [--transport stdio|http] [--port <n>]

Options:
  --transport   stdio (default) or http (streamable HTTP + SSE)
  --port        HTTP port (default $DOSSIER_HTTP_PORT or 8787)
  -v, --version
  -h, --help

Auth (one of):
  GEMINI_API_KEY=...                      Google AI Studio
  VERTEX_PROJECT=... VERTEX_LOCATION=...  Vertex AI (with ADC)

See .env.example for the full configuration surface.
`;

async function main(): Promise<void> {
  const setupExit = await maybeRunSetup(process.argv.slice(2));
  if (setupExit !== null) {
    process.exit(setupExit);
  }

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const deps = await buildDeps(config);
  const server = createServer(deps);

  process.stderr.write(
    `dossier-research-mcp ${version} · auth: ${describeAuth(config)} · store: ${config.storeDir}\n`,
  );
  if (!deps.client) {
    process.stderr.write(
      'WARNING: no Gemini credentials, so read-only tools work but no run can be started.\n',
    );
  }
  for (const limitation of backendLimitations(config)) {
    process.stderr.write(`NOTE: ${limitation}\n`);
  }

  // Resume anything left in flight by a previous process before accepting work,
  // then keep polling. This is what makes a run survive a server restart.
  await deps.runner.tick().catch(() => undefined);
  deps.runner.startPolling();

  const shutdown = (): void => {
    deps.runner.stopPolling();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.transport === 'http') {
    const port = args.port ?? config.httpPort;
    // An unauthenticated HTTP server that can spend $100/day is not a warning,
    // it is a misconfiguration. A stderr line is easy to miss and impossible to
    // act on after the fact; refusing to start is not. The escape hatch exists
    // because a container behind its own auth is a legitimate deployment, but
    // it has to be chosen deliberately.
    if (config.httpTokens.length === 0) {
      if (!config.httpAllowAnonymous) {
        process.stderr.write(
          'REFUSING TO START: HTTP transport with no DOSSIER_HTTP_TOKENS set.\n' +
            'Every tool would be reachable without authentication, including the ones that spend money.\n' +
            'Set DOSSIER_HTTP_TOKENS=<token>[,<token>] , or DOSSIER_HTTP_ALLOW_ANONYMOUS=1 if this port\n' +
            'is already protected by something else (a reverse proxy, a private network, a sidecar).\n',
        );
        process.exitCode = 78; // EX_CONFIG
        return;
      }
      process.stderr.write(
        'WARNING: HTTP transport running ANONYMOUSLY by explicit opt-in. Anyone who can reach ' +
          `port ${String(port)} can spend up to $${config.budgetUsd.toFixed(2)} per ${String(config.budgetWindowHours)}h.\n`,
      );
    }
    await server.start({ transportType: 'httpStream', httpStream: { port } });
    process.stderr.write(`Listening on http://127.0.0.1:${port}/mcp\n`);
  } else {
    await server.start({ transportType: 'stdio' });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
