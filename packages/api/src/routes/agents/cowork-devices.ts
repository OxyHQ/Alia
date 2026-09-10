import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';
import { listCoworkDevices, registerCoworkDevice, setCoworkDeviceStatus } from '../../db/agents/coworkDeviceRepository.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

router.get('/cowork/devices', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ devices: await listCoworkDevices(getDb(), req.user.id) });
}));

router.post('/cowork/devices/register', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const suppliedId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
  const deviceId = /^[a-zA-Z0-9_-]{16,100}$/.test(suppliedId) ? suppliedId : randomUUID();
  const platform = typeof req.body?.platform === 'string' ? req.body.platform.slice(0, 40) : 'unknown';
  if (!['win32', 'linux'].includes(platform)) return res.status(400).json({ error: 'Cowork supports Windows and Linux only' });
  const row = await registerCoworkDevice(getDb(), {
    id: deviceId,
    oxyUserId: req.user.id,
    name: typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) || 'Cowork device' : 'Cowork device',
    platform,
    version: typeof req.body?.version === 'string' ? req.body.version.slice(0, 40) : 'unknown',
    capabilities: req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {},
  });
  if (!row) return res.status(409).json({ error: 'Device ID belongs to another account' });
  res.status(201).json({ device: row });
}));

router.post('/cowork/devices/:deviceId/heartbeat', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const device = await setCoworkDeviceStatus(getDb(), req.user.id, String(req.params.deviceId), 'online');
  if (!device || device.status === 'revoked') return res.status(404).json({ error: 'Device not found' });
  res.json({ device });
}));

router.delete('/cowork/devices/:deviceId', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const device = await setCoworkDeviceStatus(getDb(), req.user.id, String(req.params.deviceId), 'revoked');
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.status(204).end();
}));

export default router;
