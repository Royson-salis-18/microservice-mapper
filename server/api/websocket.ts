import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SENTINEL = '___CMD_DONE___';

function resolveKeyPath(keyPath: string): string {
  return keyPath.startsWith('~/') ? path.join(os.homedir(), keyPath.slice(2)) : keyPath;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private sessions: Map<WebSocket, ChildProcess> = new Map();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server });
    
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('Client connected to WebSocket');
      
      ws.on('message', (message: string) => {
        try {
          const parsed = JSON.parse(message.toString());
          if (parsed.type === 'TERMINAL_EXEC') {
            this.handleTerminalExec(ws, parsed.data);
          }
        } catch (e) {
          console.error('Failed parsing WS message', e);
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
        const session = this.sessions.get(ws);
        if (session) {
          session.kill();
          this.sessions.delete(ws);
        }
      });
    });
  }

  private handleTerminalExec(ws: WebSocket, data: { cmd: string, ip?: string, key?: string, targetId?: string }) {
    if (!data.cmd) return;
    try {
      let session = this.sessions.get(ws);
      
      // Check if existing session is dead/closed
      if (session && (session.killed || session.exitCode !== null || session.stdin?.destroyed)) {
        this.sessions.delete(ws);
        session = undefined;
      }

      if (!session) {
        let spawnCmd = 'bash';
        let spawnArgs = ['--login'];
        
        if (data.targetId) {
          let sshUser = 'ubuntu';
          let targetIp = data.ip;
          let targetKey = data.key;

          try {
            const configPath = path.join(process.cwd(), 'data', 'remote_config.json');
            if (fs.existsSync(configPath)) {
              const remoteConf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              const tVal = remoteConf[data.targetId];
              if (tVal) {
                targetIp = tVal.ec2PublicIp || targetIp;
                targetKey = tVal.sshKeyPath || targetKey;
                sshUser = tVal.sshUsername || sshUser;
              }
            }
          } catch (e) {}

          if (targetIp && targetKey) {
            spawnCmd = 'ssh';
            spawnArgs = ['-tt', '-F', '/dev/null', '-i', resolveKeyPath(targetKey), '-o', 'StrictHostKeyChecking=no', `${sshUser}@${targetIp}`];
          }
        }

        session = spawn(spawnCmd, spawnArgs, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        this.sessions.set(ws, session);

        session.stdout?.on('data', (out) => {
          const str = out.toString();
          if (str.includes(SENTINEL)) {
            const cleanStr = str.replace(new RegExp(`${SENTINEL}.*?\\n?`, 'g'), '');
            if (cleanStr) ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: cleanStr }));
          } else {
            ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: str }));
          }
        });
        
        session.stderr?.on('data', (err) => {
          ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: `${err.toString()}` }));
        });
        
        session.on('close', (code) => {
          ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: `\n[Terminal session ended (code ${code}). Next command will open a new session.]\n` }));
          this.sessions.delete(ws);
        });
      }

      ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: `\n> ${data.cmd}` }));
      
      if (session.stdin && !session.stdin.destroyed) {
        session.stdin.write(`${data.cmd}\n`);
        session.stdin.write(`echo ${SENTINEL}$?\n`);
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'TERMINAL_LOG', data: `[SYSTEM ERROR] ${e.message}` }));
    }
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