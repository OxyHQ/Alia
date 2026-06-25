import { Router } from 'express';
import { z } from 'zod';
import {
  createContainer,
  execInContainer,
  writeFileToContainer,
  readFileFromContainer,
  readFileRawFromContainer,
  listFilesInContainer,
  exposeContainerPort,
  snapshotContainer,
  destroyContainer,
  getContainerStatus,
  listManagedContainers,
  listSnapshots,
  deleteSnapshot,
} from '../lib/docker.js';
import { log } from '../index.js';
import { errorMessage, errorStatusCode } from '../lib/errors.js';

const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN || 'preview.alia.onl';
const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.tsx': 'application/typescript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

export const containersRouter = Router();

function safeFileName(path: string): string {
  const candidate = path.split('/').pop() || 'download';
  return candidate.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function guessMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = path.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ── List all managed containers ──

containersRouter.get('/', async (_req, res) => {
  try {
    const containers = await listManagedContainers();
    res.json({ containers });
  } catch (err: unknown) {
    log.error({ err }, 'Failed to list containers');
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Create container ──

const createSchema = z.object({
  image: z.string().default('ubuntu:22.04'),
  name: z.string().optional(),
  size: z.enum(['small', 'medium', 'large']).default('small'),
  persistent: z.boolean().default(false),
  labels: z.record(z.string()).optional(),
});

containersRouter.post('/', async (req, res) => {
  try {
    const opts = createSchema.parse(req.body);
    const info = await createContainer(opts);
    res.status(201).json(info);
  } catch (err: unknown) {
    log.error({ err }, 'Failed to create container');
    res.status(errorMessage(err).includes('not allowed') ? 400 : 500).json({ error: errorMessage(err) });
  }
});

// ── Get container status ──

containersRouter.get('/:id', async (req, res) => {
  try {
    const status = await getContainerStatus(req.params.id);
    res.json(status);
  } catch (err: unknown) {
    if (errorStatusCode(err) === 404) {
      res.status(404).json({ error: 'Container not found' });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Delete container ──

containersRouter.delete('/:id', async (req, res) => {
  try {
    await destroyContainer(req.params.id);
    res.json({ destroyed: true });
  } catch (err: unknown) {
    if (errorStatusCode(err) === 404) {
      res.json({ destroyed: true }); // already gone
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Execute command ──

const execSchema = z.object({
  command: z.string(),
  timeout: z.number().min(1).max(300).default(30),
});

containersRouter.post('/:id/exec', async (req, res) => {
  try {
    const { command, timeout } = execSchema.parse(req.body);
    const result = await execInContainer(req.params.id, command, timeout);
    res.json(result);
  } catch (err: unknown) {
    if (errorMessage(err).includes('timed out')) {
      res.status(408).json({ error: errorMessage(err) });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Write file ──

const writeFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

containersRouter.post('/:id/files/write', async (req, res) => {
  try {
    const { path, content } = writeFileSchema.parse(req.body);
    await writeFileToContainer(req.params.id, path, content);
    res.json({ success: true, path });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Read file ──

containersRouter.get('/:id/files/read', async (req, res) => {
  try {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: 'Missing path query parameter' });
      return;
    }
    const content = await readFileFromContainer(req.params.id, path);
    res.json({ content, path });
  } catch (err: unknown) {
    res.status(errorMessage(err).includes('not found') ? 404 : 500).json({ error: errorMessage(err) });
  }
});

// â”€â”€ Download file (binary-safe) â”€â”€

containersRouter.get('/:id/files/download', async (req, res) => {
  try {
    const path = req.query.path as string;
    if (!path) {
      res.status(400).json({ error: 'Missing path query parameter' });
      return;
    }

    const content = await readFileRawFromContainer(req.params.id, path);
    res.setHeader('Content-Type', guessMimeType(path));
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(path)}"`);
    res.send(content);
  } catch (err: unknown) {
    if (errorMessage(err).includes('not found')) {
      res.status(404).json({ error: errorMessage(err) });
      return;
    }
    if (errorMessage(err).includes('too large')) {
      res.status(413).json({ error: errorMessage(err) });
      return;
    }
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── List files ──

containersRouter.get('/:id/files/list', async (req, res) => {
  try {
    const dir = (req.query.dir as string) || '/workspace';
    const files = await listFilesInContainer(req.params.id, dir);
    res.json({ files, dir });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Expose port ──

const exposeSchema = z.object({
  port: z.number().min(1).max(65535),
});

containersRouter.post('/:id/expose', async (req, res) => {
  try {
    const { port } = exposeSchema.parse(req.body);
    const previewUrl = await exposeContainerPort(req.params.id, port, PREVIEW_DOMAIN);
    res.json({ previewUrl, port });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Snapshot ──

const snapshotSchema = z.object({
  tag: z.string().regex(/^[a-zA-Z0-9._-]+$/, 'Invalid tag format'),
});

containersRouter.post('/:id/snapshot', async (req, res) => {
  try {
    const { tag } = snapshotSchema.parse(req.body);
    const imageTag = await snapshotContainer(req.params.id, tag);
    res.json({ imageTag, tag });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ── Snapshots management ──

containersRouter.get('/snapshots/list', async (_req, res) => {
  try {
    const snapshots = await listSnapshots();
    res.json({ snapshots });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

containersRouter.delete('/snapshots/:tag', async (req, res) => {
  try {
    await deleteSnapshot(req.params.tag);
    res.json({ deleted: true });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});
