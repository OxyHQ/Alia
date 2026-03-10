/**
 * Integration Tools — Dynamic tools from user's connected OAuth integrations
 *
 * Queries the user's active Integration documents and creates AI SDK tool()
 * wrappers so the AI can interact with GitHub, Notion, Google Calendar,
 * Linear, and Google Drive on the user's behalf.
 *
 * Every tool execute() is wrapped with safeExecute() so that errors never
 * propagate — the AI always receives a structured { error } object it can
 * communicate naturally to the user.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Integration } from '../../models/integration.js';
import { getValidToken } from '../integration-token.js';
import { log } from '../logger.js';

const TOOL_TIMEOUT_MS = 15_000;
const GH = 'https://api.github.com';
const GH_HEADERS = { Accept: 'application/vnd.github.v3+json' };

// ---------------------------------------------------------------------------
// Input validators — prevent path traversal, injection via AI-controlled params
// ---------------------------------------------------------------------------

/** GitHub "owner/repo" — alphanumeric, hyphens, underscores, dots, one slash */
const GITHUB_REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** GitHub branch names — alphanumeric, dots, hyphens, underscores, slashes */
const GITHUB_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;

/** Notion/Linear IDs — UUID v4 with or without dashes */
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Google Drive file IDs — alphanumeric, hyphens, underscores */
const DRIVE_FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Normalize a GitHub repo identifier. Accepts both:
 *   - "owner/repo" (pass-through)
 *   - Full GitHub URLs like "https://github.com/owner/repo/tree/main/..."
 * Returns the "owner/repo" portion.
 */
function normalizeGitHubRepo(input: string): string {
  if (GITHUB_REPO_RE.test(input)) return input;

  try {
    const url = new URL(input);
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }
  } catch {
    // Not a valid URL — fall through
  }

  return input;
}

function assertGitHubRepo(repo: string): void {
  if (!GITHUB_REPO_RE.test(repo)) {
    throw new Error('Invalid repository format — expected "owner/repo"');
  }
}

function assertGitHubBranch(branch: string): void {
  if (!GITHUB_BRANCH_RE.test(branch) || branch.includes('..')) {
    throw new Error('Invalid branch name');
  }
}

function assertGitHubPath(path: string): void {
  if (path.includes('\0') || path.includes('..')) {
    throw new Error('Invalid file path — traversal not allowed');
  }
}

function assertUUID(id: string, label: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid ${label} — expected a UUID`);
  }
}

function assertDriveFileId(id: string): void {
  if (!DRIVE_FILE_ID_RE.test(id)) {
    throw new Error('Invalid Drive file ID');
  }
}

// ---------------------------------------------------------------------------
// Safe execution wrapper — tools never throw, always return structured data
// ---------------------------------------------------------------------------

async function safeExecute(service: string, fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (err: any) {
    log.general.warn({ err, service }, 'Integration tool error');
    return { error: `Could not access ${service}: ${err.message?.slice(0, 150) || 'unknown error'}` };
  }
}

// Short-lived cache (same pattern as MCP tools)
const cache = new Map<string, { tools: ToolSet; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

/**
 * Build integration tools for a user based on their connected OAuth services.
 */
export async function buildIntegrationTools(oxyUserId: string): Promise<ToolSet> {
  if (!mongoose.Types.ObjectId.isValid(oxyUserId)) return {};

  const cached = cache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;

  const tools: ToolSet = {};

  try {
    const integrations = await Integration.find({
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      enabled: true,
      status: 'active',
    })
      .select('service')
      .lean();

    const connectedServices = new Set(integrations.map(i => i.service));

    if (connectedServices.has('github')) {
      Object.assign(tools, buildGitHubTools(oxyUserId));
    }
    if (connectedServices.has('notion')) {
      Object.assign(tools, buildNotionTools(oxyUserId));
    }
    if (connectedServices.has('google-calendar')) {
      Object.assign(tools, buildGoogleCalendarTools(oxyUserId));
    }
    if (connectedServices.has('linear')) {
      Object.assign(tools, buildLinearTools(oxyUserId));
    }
    if (connectedServices.has('google-drive')) {
      Object.assign(tools, buildGoogleDriveTools(oxyUserId));
    }

    cache.set(oxyUserId, { tools, expiresAt: Date.now() + CACHE_TTL_MS });

    const toolCount = Object.keys(tools).length;
    if (toolCount > 0) {
      log.general.info({ userId: oxyUserId, toolCount }, 'Integration tools loaded');
    }

    return tools;
  } catch (err) {
    log.general.error({ err, userId: oxyUserId }, 'Failed to load integration tools');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helper: authenticated fetch with token refresh
// ---------------------------------------------------------------------------

async function authedFetch(
  userId: string,
  service: string,
  url: string,
  options: RequestInit = {},
): Promise<any> {
  const token = await getValidToken(userId, service);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${service} API error (${response.status}): ${body.slice(0, 200)}`);
  }

  // Update lastUsedAt in background
  Integration.updateOne(
    { oxyUserId: new mongoose.Types.ObjectId(userId), service, enabled: true },
    { lastUsedAt: new Date() },
  ).catch((err) => log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'));

  return response.json();
}

/** Authenticated fetch that returns raw text instead of JSON */
async function authedFetchText(
  userId: string,
  service: string,
  url: string,
  options: RequestInit = {},
): Promise<string> {
  const token = await getValidToken(userId, service);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${service} API error (${response.status}): ${body.slice(0, 200)}`);
  }

  Integration.updateOne(
    { oxyUserId: new mongoose.Types.ObjectId(userId), service, enabled: true },
    { lastUsedAt: new Date() },
  ).catch((err) => log.general.warn({ err, service }, 'Failed to update integration lastUsedAt'));

  return response.text();
}

// ---------------------------------------------------------------------------
// GitHub tools
// ---------------------------------------------------------------------------

function buildGitHubTools(userId: string): ToolSet {
  return {
    // ----- Browsing & Discovery -----

    listMyGitHubRepos: tool({
      description: '[GitHub] List the authenticated user\'s repositories. Use when user asks to see their repos, projects, or repositories.',
      parameters: z.object({
        sort: z.enum(['updated', 'created', 'pushed', 'full_name']).default('updated').describe('Sort order'),
        type: z.enum(['all', 'owner', 'member']).default('all').describe('Filter by ownership'),
      }),
      execute: async (args) => safeExecute('GitHub', async () => {
        const data = await authedFetch(userId, 'github', `${GH}/user/repos?sort=${args.sort}&type=${args.type}&per_page=30`, {
          headers: GH_HEADERS,
        });
        return data.map((r: any) => ({
          name: r.name,
          fullName: r.full_name,
          description: r.description,
          language: r.language,
          stars: r.stargazers_count,
          private: r.private,
          fork: r.fork,
          url: r.html_url,
          updated: r.updated_at,
          defaultBranch: r.default_branch,
        }));
      }),
    }),

    getGitHubRepo: tool({
      description: '[GitHub] Get full details about a specific repository including stats, topics, and default branch.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
      }),
      execute: async ({ repo: rawRepo }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}`, {
          headers: GH_HEADERS,
        });
        return {
          fullName: data.full_name,
          description: data.description,
          language: data.language,
          stars: data.stargazers_count,
          forks: data.forks_count,
          openIssues: data.open_issues_count,
          defaultBranch: data.default_branch,
          private: data.private,
          topics: data.topics,
          size: data.size,
          url: data.html_url,
          cloneUrl: data.clone_url,
          created: data.created_at,
          updated: data.updated_at,
          license: data.license?.spdx_id,
        };
      }),
    }),

    searchGitHubRepos: tool({
      description: '[GitHub] Search repositories on GitHub by keyword. For listing the user\'s own repos, use listMyGitHubRepos instead.',
      parameters: z.object({
        query: z.string().describe('Search query (e.g. repo name, topic, language)'),
      }),
      execute: async ({ query }) => safeExecute('GitHub', async () => {
        const data = await authedFetch(userId, 'github', `${GH}/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=10`, {
          headers: GH_HEADERS,
        });
        return data.items.map((r: any) => ({
          name: r.full_name,
          description: r.description,
          language: r.language,
          stars: r.stargazers_count,
          url: r.html_url,
          updated: r.updated_at,
        }));
      }),
    }),

    getGitHubFileTree: tool({
      description: '[GitHub] Get the file/directory structure of a repository. Use to browse or understand project layout.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        branch: z.string().optional().describe('Branch name (defaults to repo default branch)'),
      }),
      execute: async ({ repo: rawRepo, branch }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        if (branch) assertGitHubBranch(branch);
        // Resolve default branch if not specified
        const ref = branch || (await authedFetch(userId, 'github', `${GH}/repos/${repo}`, { headers: GH_HEADERS })).default_branch;
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
          headers: GH_HEADERS,
        });
        const entries = (data.tree || []).slice(0, 200).map((e: any) => ({
          path: e.path,
          type: e.type === 'blob' ? 'file' : 'dir',
          size: e.size || undefined,
        }));
        const truncated = (data.tree || []).length > 200;
        return { branch: ref, entries, truncated, totalEntries: (data.tree || []).length };
      }),
    }),

    getGitHubFileContent: tool({
      description: '[GitHub] Read the content of a file from a repository. Use to view, analyze, or review code.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        path: z.string().describe('File path within the repository (e.g. "src/index.ts")'),
        branch: z.string().optional().describe('Branch name (defaults to repo default branch)'),
      }),
      execute: async ({ repo: rawRepo, path, branch }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        assertGitHubPath(path);
        if (branch) assertGitHubBranch(branch);
        const refParam = branch ? `?ref=${encodeURIComponent(branch)}` : '';
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/contents/${encodeURIComponent(path)}${refParam}`, {
          headers: GH_HEADERS,
        });
        // Directory listing
        if (Array.isArray(data)) {
          return { type: 'directory', path, entries: data.map((e: any) => ({ name: e.name, type: e.type, size: e.size, path: e.path })) };
        }
        // File content (base64 decode)
        let content = '';
        if (data.content && data.encoding === 'base64') {
          content = Buffer.from(data.content, 'base64').toString('utf-8');
          // Cap at 100KB to prevent token explosion
          if (content.length > 100_000) {
            content = content.slice(0, 100_000) + '\n\n[truncated — file too large]';
          }
        }
        return {
          type: 'file',
          name: data.name,
          path: data.path,
          size: data.size,
          sha: data.sha,
          content,
          url: data.html_url,
        };
      }),
    }),

    searchGitHubCode: tool({
      description: '[GitHub] Search for code across repositories. Use to find specific functions, patterns, or code snippets.',
      parameters: z.object({
        query: z.string().describe('Code search query'),
        repo: z.string().optional().describe('Limit search to a specific "owner/repo" or GitHub URL'),
      }),
      execute: async ({ query, repo: rawRepo }) => safeExecute('GitHub', async () => {
        const repo = rawRepo ? normalizeGitHubRepo(rawRepo) : undefined;
        if (repo) assertGitHubRepo(repo);
        const q = repo ? `${query}+repo:${repo}` : query;
        const data = await authedFetch(userId, 'github', `${GH}/search/code?q=${encodeURIComponent(q)}&per_page=10`, {
          headers: { ...GH_HEADERS, Accept: 'application/vnd.github.text-match+json' },
        });
        return (data.items || []).map((item: any) => ({
          path: item.path,
          repo: item.repository?.full_name,
          url: item.html_url,
          textMatches: (item.text_matches || []).map((m: any) => m.fragment).slice(0, 3),
        }));
      }),
    }),

    // ----- Issues -----

    getGitHubIssues: tool({
      description: '[GitHub] List issues for a repository.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        state: z.enum(['open', 'closed', 'all']).default('open').describe('Issue state filter'),
      }),
      execute: async ({ repo: rawRepo, state }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/issues?state=${state}&per_page=15`, {
          headers: GH_HEADERS,
        });
        return data.map((i: any) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          author: i.user?.login,
          labels: i.labels?.map((l: any) => l.name),
          created: i.created_at,
          url: i.html_url,
        }));
      }),
    }),

    createGitHubIssue: tool({
      description: '[GitHub] Create a new issue in a repository.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (markdown)'),
        labels: z.array(z.string()).optional().describe('Labels to apply'),
      }),
      execute: async ({ repo: rawRepo, title, body, labels }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const payload: any = { title };
        if (body) payload.body = body;
        if (labels?.length) payload.labels = labels;
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/issues`, {
          method: 'POST',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { number: data.number, title: data.title, url: data.html_url, state: data.state };
      }),
    }),

    commentOnGitHubIssue: tool({
      description: '[GitHub] Add a comment to an issue or pull request.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        issueNumber: z.number().describe('Issue or PR number'),
        body: z.string().describe('Comment body (markdown)'),
      }),
      execute: async ({ repo: rawRepo, issueNumber, body }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/issues/${issueNumber}/comments`, {
          method: 'POST',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        return { id: data.id, url: data.html_url, created: data.created_at };
      }),
    }),

    // ----- Pull Requests -----

    getGitHubPullRequests: tool({
      description: '[GitHub] List pull requests for a repository.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        state: z.enum(['open', 'closed', 'all']).default('open').describe('PR state filter'),
      }),
      execute: async ({ repo: rawRepo, state }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/pulls?state=${state}&per_page=15`, {
          headers: GH_HEADERS,
        });
        return data.map((pr: any) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          created: pr.created_at,
          url: pr.html_url,
          draft: pr.draft,
          head: pr.head?.ref,
          base: pr.base?.ref,
        }));
      }),
    }),

    getGitHubPullRequestDiff: tool({
      description: '[GitHub] Get the changed files and diff for a pull request. Use to review code changes.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        pullNumber: z.number().describe('Pull request number'),
      }),
      execute: async ({ repo: rawRepo, pullNumber }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/pulls/${pullNumber}/files?per_page=30`, {
          headers: GH_HEADERS,
        });
        return data.map((f: any) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch?.slice(0, 1000),
        }));
      }),
    }),

    createGitHubPullRequest: tool({
      description: '[GitHub] Create a new pull request.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        title: z.string().describe('PR title'),
        body: z.string().optional().describe('PR description (markdown)'),
        head: z.string().describe('Branch with changes (source branch)'),
        base: z.string().optional().describe('Target branch (defaults to repo default branch)'),
      }),
      execute: async ({ repo: rawRepo, title, body, head, base }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        assertGitHubBranch(head);
        if (base) assertGitHubBranch(base);
        const payload: any = { title, head };
        if (body) payload.body = body;
        // Resolve default branch if base not specified
        if (base) {
          payload.base = base;
        } else {
          const repoData = await authedFetch(userId, 'github', `${GH}/repos/${repo}`, { headers: GH_HEADERS });
          payload.base = repoData.default_branch;
        }
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/pulls`, {
          method: 'POST',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { number: data.number, title: data.title, url: data.html_url, state: data.state, draft: data.draft };
      }),
    }),

    mergeGitHubPullRequest: tool({
      description: '[GitHub] Merge a pull request.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        pullNumber: z.number().describe('Pull request number'),
        method: z.enum(['squash', 'merge', 'rebase']).default('squash').describe('Merge method'),
        commitMessage: z.string().optional().describe('Custom commit message'),
      }),
      execute: async ({ repo: rawRepo, pullNumber, method, commitMessage }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const payload: any = { merge_method: method };
        if (commitMessage) payload.commit_message = commitMessage;
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/pulls/${pullNumber}/merge`, {
          method: 'PUT',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { merged: data.merged, message: data.message, sha: data.sha };
      }),
    }),

    // ----- Writing & Git -----

    createOrUpdateGitHubFile: tool({
      description: '[GitHub] Create or update a file in a repository. This creates a commit automatically. To update an existing file, provide the current sha.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        path: z.string().describe('File path (e.g. "src/index.ts")'),
        content: z.string().describe('File content (plain text)'),
        message: z.string().describe('Commit message'),
        branch: z.string().optional().describe('Target branch (defaults to repo default branch)'),
        sha: z.string().optional().describe('Current file SHA (required for updates — get from getGitHubFileContent)'),
      }),
      execute: async ({ repo: rawRepo, path, content, message, branch, sha }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        assertGitHubPath(path);
        if (branch) assertGitHubBranch(branch);
        const payload: any = {
          message,
          content: Buffer.from(content).toString('base64'),
        };
        if (branch) payload.branch = branch;
        if (sha) payload.sha = sha;
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/contents/${encodeURIComponent(path)}`, {
          method: 'PUT',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return {
          path: data.content?.path,
          sha: data.content?.sha,
          commitSha: data.commit?.sha,
          commitUrl: data.commit?.html_url,
        };
      }),
    }),

    deleteGitHubFile: tool({
      description: '[GitHub] Delete a file from a repository. This creates a commit automatically.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        path: z.string().describe('File path to delete'),
        message: z.string().describe('Commit message'),
        branch: z.string().optional().describe('Target branch (defaults to repo default branch)'),
      }),
      execute: async ({ repo: rawRepo, path, message, branch }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        assertGitHubPath(path);
        if (branch) assertGitHubBranch(branch);
        // Get current file SHA first
        const refParam = branch ? `?ref=${encodeURIComponent(branch)}` : '';
        const fileData = await authedFetch(userId, 'github', `${GH}/repos/${repo}/contents/${encodeURIComponent(path)}${refParam}`, {
          headers: GH_HEADERS,
        });
        const payload: any = { message, sha: fileData.sha };
        if (branch) payload.branch = branch;
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/contents/${encodeURIComponent(path)}`, {
          method: 'DELETE',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { deleted: true, commitSha: data.commit?.sha, commitUrl: data.commit?.html_url };
      }),
    }),

    createGitHubBranch: tool({
      description: '[GitHub] Create a new branch in a repository.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
        branch: z.string().describe('New branch name'),
        fromBranch: z.string().optional().describe('Source branch (defaults to repo default branch)'),
      }),
      execute: async ({ repo: rawRepo, branch, fromBranch }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        assertGitHubBranch(branch);
        if (fromBranch) assertGitHubBranch(fromBranch);
        // Resolve source branch SHA
        const source = fromBranch || (await authedFetch(userId, 'github', `${GH}/repos/${repo}`, { headers: GH_HEADERS })).default_branch;
        const refData = await authedFetch(userId, 'github', `${GH}/repos/${repo}/git/refs/heads/${encodeURIComponent(source)}`, {
          headers: GH_HEADERS,
        });
        const sha = refData.object?.sha;
        if (!sha) throw new Error(`Could not resolve SHA for branch "${source}"`);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/git/refs`, {
          method: 'POST',
          headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
        });
        return { branch, sha: data.object?.sha, url: data.url };
      }),
    }),

    listGitHubBranches: tool({
      description: '[GitHub] List branches in a repository.',
      parameters: z.object({
        repo: z.string().describe('Repository in "owner/repo" format or GitHub URL'),
      }),
      execute: async ({ repo: rawRepo }) => safeExecute('GitHub', async () => {
        const repo = normalizeGitHubRepo(rawRepo);
        assertGitHubRepo(repo);
        const data = await authedFetch(userId, 'github', `${GH}/repos/${repo}/branches?per_page=30`, {
          headers: GH_HEADERS,
        });
        return data.map((b: any) => ({
          name: b.name,
          sha: b.commit?.sha,
          protected: b.protected,
        }));
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Notion tools
// ---------------------------------------------------------------------------

function buildNotionTools(userId: string): ToolSet {
  const notionHeaders = { 'Notion-Version': '2022-06-28' };

  return {
    searchNotionPages: tool({
      description: '[Notion] Search pages and databases in the user\'s workspace.',
      parameters: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }) => safeExecute('Notion', async () => {
        const data = await authedFetch(userId, 'notion', 'https://api.notion.com/v1/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...notionHeaders },
          body: JSON.stringify({ query, page_size: 10 }),
        });
        return data.results.map((r: any) => ({
          id: r.id,
          type: r.object,
          title: r.properties?.title?.title?.[0]?.plain_text
            || r.properties?.Name?.title?.[0]?.plain_text
            || r.title?.[0]?.plain_text
            || 'Untitled',
          url: r.url,
          lastEdited: r.last_edited_time,
        }));
      }),
    }),

    getNotionPage: tool({
      description: '[Notion] Get the content of a specific Notion page by ID.',
      parameters: z.object({
        pageId: z.string().describe('The Notion page ID'),
      }),
      execute: async ({ pageId }) => safeExecute('Notion', async () => {
        assertUUID(pageId, 'Notion page ID');
        const [page, blocks] = await Promise.all([
          authedFetch(userId, 'notion', `https://api.notion.com/v1/pages/${pageId}`, {
            headers: notionHeaders,
          }),
          authedFetch(userId, 'notion', `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
            headers: notionHeaders,
          }),
        ]);

        // Extract text content from blocks
        const content = blocks.results.map((block: any) => {
          const type = block.type;
          const richText = block[type]?.rich_text || block[type]?.text;
          if (Array.isArray(richText)) {
            return richText.map((t: any) => t.plain_text).join('');
          }
          return '';
        }).filter(Boolean).join('\n');

        return {
          id: page.id,
          url: page.url,
          lastEdited: page.last_edited_time,
          content: content.slice(0, 3000),
        };
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Calendar tools
// ---------------------------------------------------------------------------

function buildGoogleCalendarTools(userId: string): ToolSet {
  return {
    listCalendarEvents: tool({
      description: '[Google Calendar] List upcoming calendar events. Use when user asks about their schedule, meetings, or appointments.',
      parameters: z.object({
        timeMin: z.string().optional().describe('Start time in ISO 8601 format (defaults to now)'),
        timeMax: z.string().optional().describe('End time in ISO 8601 format (defaults to 7 days from now)'),
      }),
      execute: async ({ timeMin, timeMax }) => safeExecute('Google Calendar', async () => {
        const now = new Date();
        const min = timeMin || now.toISOString();
        const max = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams({
          timeMin: min,
          timeMax: max,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '20',
        });
        const data = await authedFetch(userId, 'google-calendar', `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
        return (data.items || []).map((e: any) => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location,
          description: e.description?.slice(0, 200),
          attendees: e.attendees?.map((a: any) => a.email),
          htmlLink: e.htmlLink,
        }));
      }),
    }),

    createCalendarEvent: tool({
      description: '[Google Calendar] Create a new calendar event. Use when user wants to schedule something.',
      parameters: z.object({
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start time in ISO 8601 format'),
        end: z.string().describe('End time in ISO 8601 format'),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
      }),
      execute: async ({ summary, start, end, description, location }) => safeExecute('Google Calendar', async () => {
        const event: any = {
          summary,
          start: { dateTime: start },
          end: { dateTime: end },
        };
        if (description) event.description = description;
        if (location) event.location = location;

        const data = await authedFetch(userId, 'google-calendar', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        return {
          id: data.id,
          summary: data.summary,
          start: data.start?.dateTime || data.start?.date,
          end: data.end?.dateTime || data.end?.date,
          htmlLink: data.htmlLink,
        };
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Linear tools
// ---------------------------------------------------------------------------

function buildLinearTools(userId: string): ToolSet {
  async function linearGraphQL(userId: string, query: string, variables?: Record<string, any>) {
    return authedFetch(userId, 'linear', 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  }

  return {
    searchLinearIssues: tool({
      description: '[Linear] Search issues in the user\'s Linear workspace.',
      parameters: z.object({
        query: z.string().describe('Search query for issues'),
      }),
      execute: async ({ query }) => safeExecute('Linear', async () => {
        const data = await linearGraphQL(userId, `
          query SearchIssues($query: String!) {
            issueSearch(query: $query, first: 15) {
              nodes {
                id identifier title state { name } priority assignee { name }
                createdAt url
              }
            }
          }
        `, { query });
        return (data.data?.issueSearch?.nodes || []).map((i: any) => ({
          id: i.identifier,
          title: i.title,
          state: i.state?.name,
          priority: i.priority,
          assignee: i.assignee?.name,
          created: i.createdAt,
          url: i.url,
        }));
      }),
    }),

    createLinearIssue: tool({
      description: '[Linear] Create a new issue in the user\'s Linear workspace.',
      parameters: z.object({
        title: z.string().describe('Issue title'),
        description: z.string().optional().describe('Issue description (markdown)'),
        teamId: z.string().optional().describe('Team ID (uses first team if not specified)'),
      }),
      execute: async ({ title, description, teamId }) => safeExecute('Linear', async () => {
        if (teamId) assertUUID(teamId, 'Linear team ID');
        // If no team specified, get the first team
        let resolvedTeamId = teamId;
        if (!resolvedTeamId) {
          const teamsData = await linearGraphQL(userId, '{ teams(first: 1) { nodes { id name } } }');
          resolvedTeamId = teamsData.data?.teams?.nodes?.[0]?.id;
          if (!resolvedTeamId) {
            return { error: 'No teams found in Linear workspace' };
          }
        }

        const data = await linearGraphQL(userId, `
          mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { id identifier title url state { name } }
            }
          }
        `, {
          input: { title, description, teamId: resolvedTeamId },
        });

        const issue = data.data?.issueCreate?.issue;
        if (!issue) {
          return { error: 'Failed to create issue' };
        }
        return {
          id: issue.identifier,
          title: issue.title,
          state: issue.state?.name,
          url: issue.url,
        };
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Drive tools
// ---------------------------------------------------------------------------

function buildGoogleDriveTools(userId: string): ToolSet {
  return {
    searchDriveFiles: tool({
      description: '[Google Drive] Search files in the user\'s Google Drive.',
      parameters: z.object({
        query: z.string().describe('Search query (file name, content keywords)'),
      }),
      execute: async ({ query }) => safeExecute('Google Drive', async () => {
        // Escape backslashes first, then single quotes (Drive API query syntax)
        const safeQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const params = new URLSearchParams({
          q: `fullText contains '${safeQuery}'`,
          pageSize: '15',
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
        });
        const data = await authedFetch(userId, 'google-drive', `https://www.googleapis.com/drive/v3/files?${params}`);
        return (data.files || []).map((f: any) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modified: f.modifiedTime,
          url: f.webViewLink,
          size: f.size,
        }));
      }),
    }),

    getDriveFileContent: tool({
      description: '[Google Drive] Get the text content of a file from Google Drive (works for Google Docs, Sheets, and text files).',
      parameters: z.object({
        fileId: z.string().describe('The Drive file ID'),
      }),
      execute: async ({ fileId }) => safeExecute('Google Drive', async () => {
        assertDriveFileId(fileId);
        // First get file metadata to determine type
        const meta = await authedFetch(userId, 'google-drive', `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`);

        // For Google Docs, export as plain text
        if (meta.mimeType === 'application/vnd.google-apps.document') {
          const text = await authedFetchText(userId, 'google-drive',
            `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`);
          return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 5000) };
        }

        // For Google Sheets, export as CSV
        if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
          const text = await authedFetchText(userId, 'google-drive',
            `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`);
          return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 5000) };
        }

        // For regular text files, download content
        const text = await authedFetchText(userId, 'google-drive',
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        return { name: meta.name, mimeType: meta.mimeType, content: text.slice(0, 5000) };
      }),
    }),
  };
}
