/**
 * What local runtimes this person currently has connected, and which models
 * each one offers.
 *
 * The picker needs this on every device, not just the one running the model: a
 * phone cannot reach the laptop's `localhost`, so without a published list a
 * local model would only ever be selectable on the machine serving it. The
 * runtime announces its catalogue when it joins (`subscribe-user-runtime`), and
 * this is that announcement read back.
 *
 * Two things are deliberately absent. There is no endpoint URL — it never
 * leaves the browser that talks to it, which is what keeps this feature's
 * server-side-request-forgery surface at zero. And there is no persistence: a
 * runtime exists exactly as long as its socket, so a stored list would
 * advertise models that nothing can answer.
 *
 * Not on `/catalogue`, because that surface describes what ALIA can route to
 * and every entry on it is the same for everybody. These entries are one
 * person's hardware.
 */
import { Router, type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  formatUserRuntimeModel,
  listUserRuntimes,
} from '../lib/inference/user-runtime-bridge.js';
import { log } from '../lib/logger.js';

const router = Router();

router.get('/', authenticateToken, async (req: Request, res: Response) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const runtimes = await listUserRuntimes(userId);
    res.json({
      runtimes: runtimes.map((runtime) => ({
        id: runtime.id,
        label: runtime.label,
        // The id the picker must send back, spelled by the module that parses
        // it — so the two halves cannot drift into disagreeing.
        models: runtime.models.map((model) => ({
          id: formatUserRuntimeModel(runtime.id, model),
          name: model,
        })),
      })),
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Failed to list local runtimes');
    res.status(500).json({ error: 'Failed to list local runtimes' });
  }
});

export default router;
