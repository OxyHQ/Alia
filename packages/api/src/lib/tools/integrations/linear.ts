/**
 * Linear integration tools — search issues, create issues
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { safeExecute, authedFetch, assertUUID } from './shared.js';

export function buildLinearTools(userId: string): ToolSet {
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
      inputSchema: z.object({
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
      inputSchema: z.object({
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
