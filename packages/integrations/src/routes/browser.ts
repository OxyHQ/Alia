import { Router, type Router as RouterType } from 'express';
import { getOrCreateContext, takeScreenshot, closeContext } from '../browser/manager';

export const browserRouter: RouterType = Router();

// Start or get a browser session
browserRouter.post('/session/:sessionId/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const { page } = await getOrCreateContext(req.params.sessionId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    res.json({ title, url: page.url() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Take a screenshot
browserRouter.get('/session/:sessionId/screenshot', async (req, res) => {
  try {
    const screenshot = await takeScreenshot(req.params.sessionId);
    if (!screenshot) {
      res.status(404).json({ error: 'No active browser session' });
      return;
    }
    res.set('Content-Type', 'image/jpeg');
    res.send(screenshot);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Close a browser session
browserRouter.post('/session/:sessionId/close', async (req, res) => {
  try {
    await closeContext(req.params.sessionId);
    res.json({ closed: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
