/**
 * MCP Manager — Injectable Class for MCP Tool Management
 *
 * Replaces the global singleton pattern in mcp.ts and mcp-relay.ts
 * with a testable, injectable class that handles:
 *   - Tool discovery and caching (with invalidation)
 *   - Permission checking before tool execution
 *   - Health monitoring for MCP servers
 *   - Graceful error handling with circuit breaker
 */

import { type ToolSet } from 'ai';
import { buildMcpTools } from '../tools/mcp.js';
import { checkToolPermission, recordToolCall, type ToolPermission } from './mcp-permissions.js';
import { recordSuccess, recordError, isServerHealthy, getAllHealth, type ServerHealth } from './mcp-health.js';
import { log } from '../logger.js';

/** Cache TTL — how long to cache MCP tools before re-querying */
const CACHE_TTL_MS = 60_000; // 1 minute (was 30s)

interface CachedTools {
  tools: ToolSet;
  expiresAt: number;
  toolCount: number;
}

export class McpManager {
  private cache = new Map<string, CachedTools>();
  private userPermissions = new Map<string, ToolPermission[]>();

  /**
   * Get MCP tools for a user, with permission wrapping and health checks.
   */
  async getTools(userId: string): Promise<ToolSet> {
    // Check cache
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.tools;
    }

    try {
      const rawTools = await buildMcpTools(userId);
      const wrappedTools = this.wrapToolsWithGovernance(userId, rawTools);

      this.cache.set(userId, {
        tools: wrappedTools,
        expiresAt: Date.now() + CACHE_TTL_MS,
        toolCount: Object.keys(wrappedTools).length,
      });

      return wrappedTools;
    } catch (err) {
      log.general.error({ err, userId }, 'McpManager: failed to load tools');
      // Return cached tools (even if stale) or empty
      return cached?.tools || {};
    }
  }

  /**
   * Invalidate the tool cache for a user.
   * Call this when the user updates their MCP server configuration.
   */
  invalidateCache(userId: string): void {
    this.cache.delete(userId);
  }

  /** Invalidate all caches */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Set custom permissions for a user.
   */
  setUserPermissions(userId: string, permissions: ToolPermission[]): void {
    this.userPermissions.set(userId, permissions);
    // Invalidate cache since permissions changed
    this.invalidateCache(userId);
  }

  /**
   * Get health status for all tracked MCP servers.
   */
  getHealth(): ServerHealth[] {
    return getAllHealth();
  }

  /**
   * Get stats about the manager's state.
   */
  getStats(): { cachedUsers: number; totalCachedTools: number } {
    let totalTools = 0;
    for (const cached of this.cache.values()) {
      totalTools += cached.toolCount;
    }
    return { cachedUsers: this.cache.size, totalCachedTools: totalTools };
  }

  // ── Internal ──

  /**
   * Wrap each tool with permission checking, health monitoring, and error handling.
   */
  private wrapToolsWithGovernance(userId: string, tools: ToolSet): ToolSet {
    const wrapped: ToolSet = {};
    const permissions = this.userPermissions.get(userId);

    for (const [name, rawTool] of Object.entries(tools)) {
      // Extract server info from tool name (mcp_{server}__{tool})
      const serverMatch = name.match(/^mcp_([^_]+(?:_[^_]+)*)__/);
      const serverName = serverMatch?.[1] || 'unknown';

      wrapped[name] = {
        ...rawTool,
        execute: async (...args: any[]) => {
          // Permission check
          const permission = checkToolPermission(userId, name, permissions);
          if (!permission.allowed) {
            return { error: `Tool blocked: ${permission.reason}` };
          }

          // Health check
          if (!isServerHealthy(serverName)) {
            return { error: `MCP server "${serverName}" is currently unhealthy. Try again later.` };
          }

          // Execute with monitoring
          const startMs = Date.now();
          try {
            const result = await (rawTool as any).execute(...args);
            recordToolCall(userId, name);
            recordSuccess(serverName, serverName, Date.now() - startMs);
            return result;
          } catch (err: any) {
            recordError(serverName, serverName, err.message);
            log.general.warn({ err, toolName: name, userId }, 'McpManager: tool call failed');
            return { error: `MCP tool failed: ${err.message?.slice(0, 200) || 'unknown error'}` };
          }
        },
      } as any;
    }

    return wrapped;
  }
}

/** Global MCP Manager instance */
let globalManager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!globalManager) {
    globalManager = new McpManager();
  }
  return globalManager;
}
