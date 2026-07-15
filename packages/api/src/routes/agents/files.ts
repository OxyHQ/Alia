import { Router } from 'express';
import mongoose from 'mongoose';
import { AgentSession } from '../../models/agent-session.js';
import { Container } from '../../models/container.js';
import { authenticateToken } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';
import type { Request, Response } from 'express';

const router = Router();

type SessionResourceLike = {
  type: string;
  resourceId: string;
  status: string;
};

function resolveWorkspaceFilePath(inputPath: string): string | null {
  let normalized = inputPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\0')) return null;

  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  } else if (normalized === 'workspace') {
    return null;
  }

  const safeSegments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    safeSegments.push(segment);
  }

  if (safeSegments.length === 0) return null;
  return `/workspace/${safeSegments.join('/')}`;
}

function safeDownloadName(filePath: string): string {
  const fileName = filePath.split('/').pop() || 'download.txt';
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function resolveSessionContainerId(
  sessionId: string,
  userId: string,
  resources: SessionResourceLike[] | undefined,
): Promise<string | null> {
  const resourceContainer = resources?.find(
    r => r.type === 'container' && (r.status === 'active' || r.status === 'idle'),
  );
  if (resourceContainer?.resourceId) return resourceContainer.resourceId;

  const containerDoc = await Container.findOne({
    sessionId: new mongoose.Types.ObjectId(sessionId),
    userId: new mongoose.Types.ObjectId(userId),
    status: { $in: ['running', 'idle'] },
  }).sort({ createdAt: -1 }).lean();

  return containerDoc?.containerId || null;
}

// GET /agents/sessions/:sid/files - list workspace files
router.get('/sessions/:sid/files', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      userId: req.user.id,
    })
      .select('resources')
      .lean();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const containerId = await resolveSessionContainerId(
      String(req.params.sid),
      String(req.user.id),
      session.resources as SessionResourceLike[] | undefined,
    );

    if (!containerId) {
      return res.json({ files: [], message: 'No workspace container found' });
    }

    // List files via Docker host
    const dockerHostUrl = process.env.DOCKER_HOST_URL;
    const dockerHostSecret = process.env.DOCKER_HOST_SECRET;
    if (!dockerHostUrl || !dockerHostSecret) {
      return res.json({ files: [], message: 'Docker host not configured' });
    }

    const listRes = await fetch(`${dockerHostUrl}/containers/${containerId}/files/list?dir=${encodeURIComponent('/workspace')}`, {
      headers: { Authorization: `Bearer ${dockerHostSecret}` },
    });

    if (!listRes.ok) {
      return res.json({ files: [], message: 'Failed to list workspace files' });
    }

    const data = await listRes.json();
    res.json({ files: data.files || [], containerId });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error listing session files');
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// GET /agents/sessions/:sid/files/* - download a file from workspace
router.get('/sessions/:sid/files/*', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Extract file path from wildcard
    const filePath = req.params[0];
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const session = await AgentSession.findOne({
      _id: req.params.sid,
      userId: req.user.id,
    })
      .select('resources')
      .lean();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const containerId = await resolveSessionContainerId(
      String(req.params.sid),
      String(req.user.id),
      session.resources as SessionResourceLike[] | undefined,
    );

    if (!containerId) {
      return res.status(404).json({ error: 'No workspace container found' });
    }

    const dockerHostUrl = process.env.DOCKER_HOST_URL;
    const dockerHostSecret = process.env.DOCKER_HOST_SECRET;
    if (!dockerHostUrl || !dockerHostSecret) {
      return res.status(503).json({ error: 'Docker host not configured' });
    }

    const absolutePath = resolveWorkspaceFilePath(filePath);
    if (!absolutePath) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
    const fileRes = await fetch(
      `${dockerHostUrl}/containers/${containerId}/files/download?path=${encodeURIComponent(absolutePath)}`,
      { headers: { Authorization: `Bearer ${dockerHostSecret}` } },
    );

    if (!fileRes.ok) {
      let message = 'Failed to download file';
      try {
        const errPayload = await fileRes.json();
        if (typeof errPayload?.error === 'string' && errPayload.error.trim()) {
          message = errPayload.error.slice(0, 200);
        }
      } catch {
        // Keep generic message if docker host response is not JSON.
      }
      return res.status(fileRes.status).json({ error: message });
    }

    const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(filePath)}"`);
    res.send(buffer);
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error downloading session file');
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
