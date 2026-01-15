import { Router } from 'express';
// TODO: Migrar lógica de models desde Next.js

const router = Router();

router.get('/', async (req, res) => {
  // TODO: Listar modelos disponibles
  res.status(501).json({ message: 'To be implemented' });
});

export default router;
