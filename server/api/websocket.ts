import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export class WebSocketManager {
  private wss: WebSocketServer;

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server });
    
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('Client connected to WebSocket');
      ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
      });
    });
  }

  broadcast(type: string, data: any) {
    const payload = JSON.stringify({ type, data });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }
}