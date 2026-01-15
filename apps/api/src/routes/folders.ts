import { Router } from 'express';
// TODO: Migrar lógica de folders desde Next.js

const router = Router();

router.get('/', async (req, res) => {
  // TODO: Listar folders
  res.status(501).json({ message: 'To be implemented' });
});

router.post('/', async (req, res) => {
  // TODO: Crear folder
  res.status(501).json({ message: 'To be implemented' });
});

router.delete('/:id', async (req, res) => {
  // TODO: Eliminar folder
  res.status(501).json({ message: 'To be implemented' });
});

export default router;
