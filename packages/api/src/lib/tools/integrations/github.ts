/**
 * GitHub integration tools — repos, issues, PRs, code search, file management
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  safeExecute,
  authedFetch,
  normalizeGitHubRepo,
  assertGitHubRepo,
  assertGitHubBranch,
  assertGitHubPath,
} from './shared.js';

const GH = 'https://api.github.com';
const GH_HEADERS = { Accept: 'application/vnd.github.v3+json' };

export function buildGitHubTools(userId: string): ToolSet {
  return {
    // ----- Browsing & Discovery -----

    listMyGitHubRepos: tool({
      description: '[GitHub] List the authenticated user\'s repositories. Use when user asks to see their repos, projects, or repositories.',
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
