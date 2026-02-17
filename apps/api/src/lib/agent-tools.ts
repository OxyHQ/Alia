/**
 * Agent Tools
 *
 * Factory that builds the tool set available to autonomous agent sessions.
 * Includes built-in Alia tools + agent-specific tools (completeTask, hireAgent, VM ops).
 */

import { tool } from 'ai';
import { z } from 'zod';
import crypto from 'crypto';
import { getCurrentDateTool } from './tools/date.js';
import { createGoogleSearchTool } from './tools/google-search.js';
import { webScraperTool } from './tools/web-scraper.js';
import { saveUserMemoryTool } from './tools/user-memory.js';
import { createSendTelegramTool } from './tools/telegram.js';
import { log } from './logger.js';
import type { IAgent } from '../models/agent.js';
import type { IAgentSession } from '../models/agent-session.js';

const DO_API = 'https://api.digitalocean.com/v2';
const DO_TOKEN = process.env.DIGITALOCEAN_API_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_AI_API_KEY || '';

// SSH key pairs per session (generated on first VM create)
const sessionSSHKeys = new Map<string, { publicKey: string; privateKey: string }>();

interface BuildToolsContext {
  agent: IAgent;
  session: IAgentSession;
  onComplete: (result: string) => void;
  onHireAgent?: (handle: string, task: string) => Promise<string>;
}

export function buildAgentTools(ctx: BuildToolsContext) {
  const { agent, session, onComplete, onHireAgent } = ctx;
  const sessionId = session._id.toString();
  const userId = session.userId.toString();

  const tools: Record<string, ReturnType<typeof tool>> = {};

  // ── Built-in tools ──

  tools.getCurrentDate = getCurrentDateTool;

  if (GOOGLE_API_KEY) {
    tools.googleSearch = createGoogleSearchTool(GOOGLE_API_KEY);
  }

  tools.webScraper = webScraperTool;
  tools.saveMemory = saveUserMemoryTool(userId);
  tools.sendTelegram = createSendTelegramTool(userId);

  // ── Agent-specific tools ──

  tools.completeTask = tool({
    description: 'Signal that the current task is complete. Call this when you have finished working and have a final result.',
    parameters: z.object({
      result: z.string().describe('The final result or summary of what was accomplished'),
    }),
    execute: async ({ result }: { result: string }) => {
      onComplete(result);
      return { completed: true, result };
    },
  });

  if (onHireAgent) {
    tools.hireAgent = tool({
      description: 'Hire another agent for a subtask. The agent will work autonomously and return the result.',
      parameters: z.object({
        agentHandle: z.string().describe('The handle of the agent to hire (e.g. @researcher)'),
        task: z.string().describe('Description of the task for the hired agent'),
      }),
      execute: async ({ agentHandle, task }: { agentHandle: string; task: string }) => {
        try {
          const handle = agentHandle.replace(/^@/, '');
          const result = await onHireAgent(handle, task);
          return { success: true, agentHandle: handle, result };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to hire agent' };
        }
      },
    });
  }

  // ── VM Tools (only if DO token available) ──

  if (DO_TOKEN) {
    tools.createVM = tool({
      description: 'Create a virtual machine (DigitalOcean droplet) for executing code. Returns the VM ID and IP address.',
      parameters: z.object({
        name: z.string().optional().describe('Name for the VM (auto-generated if not provided)'),
        image: z.string().optional().describe('OS image slug (default: ubuntu-24-04-x64)'),
        size: z.string().optional().describe('Droplet size slug (default: s-1vcpu-1gb)'),
      }),
      execute: async ({ name, image, size }: { name?: string; image?: string; size?: string }) => {
        // Check VM limit
        const activeVMs = session.resources.filter(r => r.type === 'vm' && r.status === 'active');
        if (activeVMs.length >= session.config.maxVMs) {
          return { error: `VM limit reached (${session.config.maxVMs}). Destroy an existing VM first.` };
        }

        try {
          // Generate SSH key pair for this session if not already done
          if (!sessionSSHKeys.has(sessionId)) {
            const { generateKeyPairSync } = await import('crypto');
            const { publicKey, privateKey } = generateKeyPairSync('rsa', {
              modulusLength: 2048,
              publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
              privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            });
            // Convert PEM public key to OpenSSH format for cloud-init
            const sshPubKey = pemToOpenSSH(publicKey);
            sessionSSHKeys.set(sessionId, { publicKey: sshPubKey, privateKey });
          }

          const sshKey = sessionSSHKeys.get(sessionId)!;
          const vmName = name || `agent-${agent.handle}-${crypto.randomUUID().slice(0, 8)}`;

          const userData = `#!/bin/bash
mkdir -p /root/.ssh
echo "${sshKey.publicKey}" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
`;

          const createRes = await fetch(`${DO_API}/droplets`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${DO_TOKEN}`,
            },
            body: JSON.stringify({
              name: vmName,
              region: 'nyc1',
              size: size || 's-1vcpu-1gb',
              image: image || 'ubuntu-24-04-x64',
              user_data: userData,
              tags: [`agent-session:${sessionId}`],
            }),
          });

          if (!createRes.ok) {
            const err = await createRes.text();
            log.agents.error({ err, status: createRes.status }, 'Failed to create droplet');
            return { error: 'Failed to create VM' };
          }

          const dropletData = await createRes.json() as any;
          const dropletId = String(dropletData.droplet.id);

          // Wait for the droplet to get an IP (poll up to 60s)
          let ip: string | undefined;
          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const statusRes = await fetch(`${DO_API}/droplets/${dropletId}`, {
              headers: { 'Authorization': `Bearer ${DO_TOKEN}` },
            });
            if (statusRes.ok) {
              const d = await statusRes.json() as any;
              const v4 = d.droplet?.networks?.v4?.find((n: any) => n.type === 'public');
              if (v4?.ip_address) {
                ip = v4.ip_address;
                break;
              }
            }
          }

          // Track resource in session
          session.resources.push({
            type: 'vm',
            resourceId: dropletId,
            ip,
            status: 'active',
            createdAt: new Date(),
          });
          await session.save();

          return { vmId: dropletId, ip: ip || 'pending', name: vmName };
        } catch (err: any) {
          log.agents.error({ err }, 'VM creation error');
          return { error: err.message || 'VM creation failed' };
        }
      },
    });

    tools.executeCommand = tool({
      description: 'Execute a shell command on a VM via SSH. Returns stdout, stderr, and exit code.',
      parameters: z.object({
        vmId: z.string().describe('The VM ID returned by createVM'),
        command: z.string().describe('The shell command to execute'),
        timeout: z.number().optional().describe('Command timeout in seconds (default: 30)'),
      }),
      execute: async ({ vmId, command, timeout }: { vmId: string; command: string; timeout?: number }) => {
        const resource = session.resources.find(r => r.resourceId === vmId && r.status === 'active');
        if (!resource?.ip) {
          return { error: 'VM not found or has no IP address' };
        }

        const keys = sessionSSHKeys.get(sessionId);
        if (!keys) {
          return { error: 'No SSH keys for this session' };
        }

        try {
          const { Client } = await import('ssh2');
          const result = await sshExec(resource.ip, keys.privateKey, command, timeout || 30);
          return result;
        } catch (err: any) {
          return { error: err.message || 'SSH execution failed' };
        }
      },
    });

    tools.writeFile = tool({
      description: 'Write content to a file on a VM via SSH.',
      parameters: z.object({
        vmId: z.string().describe('The VM ID'),
        path: z.string().describe('Absolute file path on the VM'),
        content: z.string().describe('File content to write'),
      }),
      execute: async ({ vmId, path, content }: { vmId: string; path: string; content: string }) => {
        const resource = session.resources.find(r => r.resourceId === vmId && r.status === 'active');
        if (!resource?.ip) return { error: 'VM not found or has no IP' };

        const keys = sessionSSHKeys.get(sessionId);
        if (!keys) return { error: 'No SSH keys for this session' };

        try {
          // Escape single quotes in content for the heredoc
          const escaped = content.replace(/'/g, "'\\''");
          const cmd = `cat > '${path}' << 'AGENT_EOF'\n${content}\nAGENT_EOF`;
          const result = await sshExec(resource.ip, keys.privateKey, cmd, 15);
          return { success: result.exitCode === 0, path };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.readFile = tool({
      description: 'Read a file from a VM via SSH.',
      parameters: z.object({
        vmId: z.string().describe('The VM ID'),
        path: z.string().describe('Absolute file path on the VM'),
      }),
      execute: async ({ vmId, path }: { vmId: string; path: string }) => {
        const resource = session.resources.find(r => r.resourceId === vmId && r.status === 'active');
        if (!resource?.ip) return { error: 'VM not found or has no IP' };

        const keys = sessionSSHKeys.get(sessionId);
        if (!keys) return { error: 'No SSH keys for this session' };

        try {
          const result = await sshExec(resource.ip, keys.privateKey, `cat '${path}'`, 15);
          if (result.exitCode !== 0) return { error: result.stderr || 'File not found' };
          return { content: result.stdout, path };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.destroyVM = tool({
      description: 'Destroy a VM (DigitalOcean droplet). Always destroy VMs when done to save costs.',
      parameters: z.object({
        vmId: z.string().describe('The VM ID to destroy'),
      }),
      execute: async ({ vmId }: { vmId: string }) => {
        try {
          const res = await fetch(`${DO_API}/droplets/${vmId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${DO_TOKEN}` },
          });

          // Mark resource as destroyed in session
          const resource = session.resources.find(r => r.resourceId === vmId);
          if (resource) {
            resource.status = 'destroyed';
            await session.save();
          }

          return { destroyed: res.ok, vmId };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });
  }

  return tools;
}

/**
 * Destroy all active VMs for a session (cleanup on completion/failure).
 */
export async function cleanupSessionVMs(session: IAgentSession): Promise<void> {
  if (!DO_TOKEN) return;

  for (const resource of session.resources) {
    if (resource.type === 'vm' && resource.status === 'active') {
      try {
        await fetch(`${DO_API}/droplets/${resource.resourceId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${DO_TOKEN}` },
        });
        resource.status = 'destroyed';
        log.agents.info({ vmId: resource.resourceId }, 'Cleaned up agent VM');
      } catch (err) {
        log.agents.warn({ err, vmId: resource.resourceId }, 'Failed to clean up VM');
      }
    }
  }

  // Clean up SSH keys
  const sessionId = session._id.toString();
  sessionSSHKeys.delete(sessionId);

  await session.save();
}

// ── SSH Helper ──

async function sshExec(
  host: string,
  privateKey: string,
  command: string,
  timeoutSec: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { Client } = await import('ssh2');

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH command timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    conn.on('ready', () => {
      let stdout = '';
      let stderr = '';

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          return reject(err);
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
          // Cap output at 50KB
          if (stdout.length > 50000) stdout = stdout.slice(0, 50000) + '\n... [truncated]';
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (stderr.length > 50000) stderr = stderr.slice(0, 50000) + '\n... [truncated]';
        });

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    conn.connect({
      host,
      port: 22,
      username: 'root',
      privateKey,
      readyTimeout: 10000,
    });
  });
}

/**
 * Convert PEM RSA public key to OpenSSH format.
 */
function pemToOpenSSH(pemPublicKey: string): string {
  // Use crypto to create a proper OpenSSH key
  const keyObject = crypto.createPublicKey(pemPublicKey);
  const sshKey = keyObject.export({ type: 'spki', format: 'der' });
  // For simplicity, use the crypto module's built-in SSH export (Node 16+)
  try {
    return (keyObject as any).export({ type: 'pkcs1', format: 'pem' })
      ? `ssh-rsa ${sshKey.toString('base64')} agent-key`
      : pemPublicKey;
  } catch {
    // Fallback: just base64 encode the DER
    return `ssh-rsa ${sshKey.toString('base64')} agent-key`;
  }
}
