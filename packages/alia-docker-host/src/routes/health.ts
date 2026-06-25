import { Router } from 'express';
import { docker, listManagedContainers } from '../lib/docker.js';
import { errorMessage } from '../lib/errors.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    const info = await docker.info();
    const containers = await listManagedContainers();
    const running = containers.filter(c => c.status === 'running').length;

    res.json({
      status: 'ok',
      docker: {
        version: info.ServerVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        images: info.Images,
        memoryTotal: info.MemTotal,
      },
      alia: {
        managedContainers: containers.length,
        runningContainers: running,
      },
      uptime: process.uptime(),
    });
  } catch (err: unknown) {
    res.status(503).json({
      status: 'error',
      error: errorMessage(err),
    });
  }
});
