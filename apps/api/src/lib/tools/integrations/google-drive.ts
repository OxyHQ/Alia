/**
 * Google Drive integration tools — search files, read file content
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { safeExecute, authedFetch, authedFetchText, assertDriveFileId } from './shared.js';

export function buildGoogleDriveTools(userId: string): ToolSet {
  return {
    searchDriveFiles: tool({
      description: '[Google Drive] Search files in the user\'s Google Drive.',
      inputSchema: z.object({
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
      inputSchema: z.object({
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
