import { Router } from 'express';
// TODO: Migrar lógica de chat completions desde Next.js

const router = Router();

router.post('/', async (req, res) => {
  // TODO: Implementar chat completions compatible con OpenAI API
  res.status(501).json({ message: 'To be implemented' });
});

export default router;
