import { Router } from 'express';
import { createSession, runCommand, destroySession, writeToSession } from '../terminal/manager';

export const terminalRouter = Router();

// Create a terminal session
terminalRouter.post('/session/:sessionId/create', async (req, res) => {
  try {
    await createSession(req.params.sessionId);
    res.json({ sessionId: req.params.sessionId, status: 'created' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Run a command and get output
terminalRouter.post('/session/:sessionId/run', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }
    const output = await runCommand(req.params.sessionId, command);
    res.json({ output, command });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Write raw input to the terminal (for interactive use via WebSocket fallback)
terminalRouter.post('/session/:sessionId/write', async (req, res) => {
  const { data } = req.body;
  if (!data) {
    res.status(400).json({ error: 'data is required' });
    return;
  }
  const success = writeToSession(req.params.sessionId, data);
  if (!success) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ written: true });
});

// Destroy a terminal session
terminalRouter.post('/session/:sessionId/close', async (req, res) => {
  destroySession(req.params.sessionId);
  res.json({ closed: true });
});
