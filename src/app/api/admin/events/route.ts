import { NextRequest } from 'next/server';
import { getAllKeys } from '@/lib/load-balancer';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Función para enviar datos
      const sendData = async () => {
        try {
          const keys = await getAllKeys();
          // Formato SSE: "data: ... \n\n"
          const message = `data: ${JSON.stringify(keys)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch (e) {
          console.error("Error sending SSE data", e);
          controller.error(e);
        }
      };

      // Enviar datos iniciales
      await sendData();

      // Loop para enviar datos cada 1s (Simulando Real-time push)
      // En un entorno de producción ideal usaríamos eventos, pero esto es robusto para dashboards
      const interval = setInterval(sendData, 1000);

      // Limpieza al cerrar conexión (no funciona siempre en serverless pero ayuda en dev)
      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
