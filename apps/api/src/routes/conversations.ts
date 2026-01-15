import { Router } from 'express';
// TODO: Migrar lógica de conversaciones desde Next.js

const router = Router();

router.get('/', async (req, res) => {
  // TODO: Listar conversaciones
  res.status(501).json({ message: 'To be implemented' });
});

router.post('/', async (req, res) => {
  // TODO: Crear conversación
  res.status(501).json({ message: 'To be implemented' });
});

router.get('/:id', async (req, res) => {
  // TODO: Obtener conversación por ID
  res.status(501).json({ message: 'To be implemented' });
});

router.put('/:id', async (req, res) => {
  // TODO: Actualizar conversación
  res.status(501).json({ message: 'To be implemented' });
});

router.delete('/:id', async (req, res) => {
  // TODO: Eliminar conversación
  res.status(501).json({ message: 'To be implemented' });
});

export default router;
