/**
 * `codea connect` — serve a coding-agent CLI to Alia as one of the person's agents (ADR 0030).
 *
 *   codea connect --code AB12-CD34-EF56 --cli codex     pair this machine, then serve it
 *   codea connect                                       serve the agents this machine is paired with
 *
 * Outbound only: it dials Alia over WebSocket with the person's own Oxy session and drives the
 * installed CLI under the person's own login. Nothing is listening on this machine, and no token of
 * the CLI's vendor ever reaches Alia.
 */
import { hostname } from 'node:os';
import chalk from 'chalk';
import { config } from '../utils/config.js';
import { linkedAliaClient } from '../utils/oxy-session.js';
import { startDaemon, type Daemon } from '../external/daemon.js';
import { runProcess } from '../external/process.js';
import { runtimeFor } from '../external/registry.js';
import {
  forgetAgent,
  pairedAgents,
  rememberAgent,
  sessionStore,
  type PairedAgent,
} from '../external/state.js';
import { EXTERNAL_CLIS, isExternalCli, type ExternalCli } from '../external/types.js';

export interface ConnectOptions {
  code?: string;
  cli?: string;
  agent?: string;
  cwd?: string;
  /** Commander turns `--read-only` into `readOnly`. */
  readOnly?: boolean;
  /** Accepted for compatibility: editing is the default now. */
  write?: boolean;
}

const WRITE_NOTICE =
  'The agent may edit files in the working directory. Start with --read-only to forbid it.';

async function installed(cli: ExternalCli): Promise<boolean> {
  const result = await runProcess({
    command: cli,
    args: ['--version'],
    cwd: process.cwd(),
    signal: new AbortController().signal,
  }).catch(() => null);
  return result !== null && result.code === 0;
}

async function chooseCli(requested: string | undefined): Promise<ExternalCli | null> {
  if (requested !== undefined) {
    if (!isExternalCli(requested)) {
      console.error(chalk.red(`--cli must be one of: ${EXTERNAL_CLIS.join(', ')}`));
      return null;
    }
    if (!(await installed(requested))) {
      console.error(chalk.red(`\`${requested}\` is not installed or not on the PATH.`));
      return null;
    }
    return requested;
  }
  const found: ExternalCli[] = [];
  for (const cli of EXTERNAL_CLIS) if (await installed(cli)) found.push(cli);
  if (found.length === 1) return found[0];
  console.error(
    chalk.red(
      found.length === 0
        ? `No supported CLI found (${EXTERNAL_CLIS.join(', ')}).`
        : `Several CLIs are installed (${found.join(', ')}); pick one with --cli.`,
    ),
  );
  return null;
}

async function redeem(
  apiBaseUrl: string,
  code: string,
  cli: ExternalCli,
): Promise<PairedAgent | null> {
  const linked = linkedAliaClient();
  try {
    const response = await linked.fetch(`${apiBaseUrl}/agents/external/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, cli, hostName: hostname().slice(0, 80) || 'this computer' }),
    });
    if (response.status === 400) {
      console.error(
        chalk.red('That code is invalid, expired or already used. Create a new one in Alia.'),
      );
      return null;
    }
    if (!response.ok) {
      console.error(chalk.red(`Alia could not pair this machine (HTTP ${response.status}).`));
      return null;
    }
    const body = (await response.json()) as { agentId: string; name: string };
    const agent: PairedAgent = { agentId: body.agentId, name: body.name, cli, apiBaseUrl };
    rememberAgent(agent);
    return agent;
  } finally {
    linked.dispose();
  }
}

export async function connect(options: ConnectOptions): Promise<void> {
  const apiBaseUrl = config.get('apiBaseUrl') || 'https://api.alia.onl';
  let agents = pairedAgents(apiBaseUrl);

  if (options.code !== undefined) {
    const cli = await chooseCli(options.cli);
    if (cli === null) process.exit(1);
    const agent = await redeem(apiBaseUrl, options.code, cli);
    if (agent === null) process.exit(1);
    console.log(chalk.green(`Paired: ${agent.name}`));
    agents = [agent];
  } else if (options.agent !== undefined) {
    agents = agents.filter((a) => a.agentId === options.agent);
  }

  if (agents.length === 0) {
    console.error(
      chalk.red(
        'This machine is not paired with any agent. Create a code in Alia (Settings → Connect an external agent) and run `codea connect --code <code>`.',
      ),
    );
    process.exit(1);
  }

  const cwd = options.cwd ?? process.cwd();
  const write = options.readOnly !== true;
  const wsUrl = `${apiBaseUrl.replace(/^http/, 'ws')}/ws/external-agent`;
  const linked = linkedAliaClient();
  const daemons: Daemon[] = [];

  console.log(
    chalk.gray(`Working directory: ${cwd}${write ? `\n${WRITE_NOTICE}` : ' (read-only)'}`),
  );
  for (const agent of agents) {
    let announced = false;
    const daemon = startDaemon({
      wsUrl,
      agentId: agent.agentId,
      agentName: agent.name,
      runtime: runtimeFor(agent.cli),
      sessions: sessionStore(),
      cwd,
      write,
      getToken: () => linked.getAccessToken(wsUrl),
      log: (message) => {
        if (message === 'connected') {
          if (!announced) console.log(chalk.green(`Connected: ${agent.name}`));
          announced = true;
          return;
        }
        console.log(chalk.gray(`[${agent.name}] ${message}`));
      },
    });
    daemons.push(daemon);
    void daemon.done.then((exit) => {
      if (exit.reason === 'revoked' || exit.reason === 'unknown-agent') {
        forgetAgent(agent.agentId);
        console.log(chalk.yellow(`${agent.name} was removed in Alia; this machine forgot it.`));
      }
    });
  }

  const stopAll = () => {
    for (const daemon of daemons) daemon.stop();
  };
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);

  await Promise.all(daemons.map((daemon) => daemon.done));
  linked.dispose();
}
