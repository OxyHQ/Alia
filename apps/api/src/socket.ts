import { Server } from 'socket.io';
import http from 'http';

let io: Server | null = null;

export function initSocket(server: http.Server) {
  io = new Server(server, {
    cors: {
      origin: '*', // Puedes restringir esto si lo deseas
      methods: ['GET', 'POST']
    }
  });
  io.on('connection', (socket) => {
    // El cliente se suscribe a un canal de token
    socket.on('subscribe-telegram-token', (token: string) => {
      socket.join(`telegram-token:${token}`);
    });
  });
  return io;
}

export function emitTelegramLinked(token: string, data: any) {
  if (io) {
    io.to(`telegram-token:${token}`).emit('telegram-linked', data);
  }
}
