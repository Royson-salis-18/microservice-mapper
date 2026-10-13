# 21 — Connection Layer & SSH Infrastructure

## Overview

The connection layer (`server/telemetry-platform/src/connection/`) provides a structured abstraction for executing remote commands on target hosts via SSH. It separates connection lifecycle management from command execution, enabling the system to collect telemetry from EC2 instances without installing any agent.

## Architecture

```
┌─────────────────────┐
│   GraphStore /      │
│   DiscoveryEngine   │
│   / PrometheusSource│
├─────────────────────┤
│  ConnectionManager  │  ← Retry with backoff
├─────────────────────┤
│    Connection       │  ← Abstract interface
│  ┌─────────────────┐│
│  │  SSHConnection  ││  ← Only concrete impl
│  │  (ssh2 library) ││
│  └─────────────────┘│
├─────────────────────┤
│   RemoteCommand<T>  │  ← Typed command + parser
└─────────────────────┘
```

## Connection Interface (server/telemetry-platform/src/connection/Connection.ts)

The minimal contract every connection type must satisfy:

```typescript
export interface Connection {
  readonly targetId: string;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  execute<T>(cmd: RemoteCommand<T>): Promise<RemoteCommandResult<T>>;
}
```

**Design note**: Only SSH is implemented. The `FakeConnection` exists for testing.

## SSHConnection (server/telemetry-platform/src/connection/SSHConnection.ts)

The only production `Connection` implementation. Uses the `ssh2` library.

### Key Behaviors

1. **Private key read from disk** — read once at `connect()` time, never logged, never embedded in config
2. **Passphrase from environment** — optional, loaded from an env var name stored in config
3. **Ready timeout** — defaults to 15,000ms, configurable per target
4. **Command timeout** — per-command, via `RemoteCommand.timeoutMs`
5. **Output capping** — stdout/stderr are capped at `RemoteCommand.maxOutputBytes` to prevent OOM from a runaway command

### Timeout Handling

```typescript
const timer = setTimeout(() => {
  resolve({
    name: cmd.name,
    exitCode: null,       // no exit code because command didn't finish
    error: `Command timed out after ${cmd.timeoutMs}ms`,
    truncated,
  });
}, cmd.timeoutMs);
```

A timed-out command returns a result with `exitCode: null` and an error string, rather than throwing. This keeps the collection loop running even when one command hangs.

## RemoteCommand<T> (server/telemetry-platform/src/connection/RemoteCommand.ts)

A typed command descriptor:

```typescript
export interface RemoteCommand<T> {
  name: string;              // Human-readable label for logging
  command: string;           // Shell command to execute
  timeoutMs: number;         // Kill after this
  maxOutputBytes: number;    // Truncate stdout/stderr beyond this
  parser?: (stdout: string) => T;  // Optional typed parser
}

export interface RemoteCommandResult<T> {
  name: string;
  command: string;
  exitCode: number | null;   // null = timed out or exec error
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  parsed?: T;                // Parser result if parser was provided
  error?: string;
}
```

The `parser` field allows commands to return typed results (e.g., parsing `docker stats --format json` into structured data).

## ConnectionManager (server/telemetry-platform/src/connection/ConnectionManager.ts)

Manages the connection lifecycle with retry logic:

### Retry Strategy

```typescript
async getConnection(): Promise<Connection> {
  if (this.connection?.isConnected()) return this.connection;

  const maxRetries = this.options.maxRetries ?? 3;
  const backoffMs = this.options.backoffMs ?? 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const conn = this.buildConnection();
      await conn.connect();
      return conn;
    } catch (err) {
      if (attempt < maxRetries) await sleep(backoffMs * attempt);
    }
  }
  throw new Error(`Failed after ${maxRetries} attempts`);
}
```

- **Linear backoff**: 2s, 4s, 6s (default)
- **Reuse existing**: Returns the existing connection if still alive
- **Build from config**: Routes to the correct Connection subclass based on `target.connection.type`

## SSH in the WebSocket Terminal

The `WebSocketManager` also manages interactive SSH sessions for the UI terminal:

```typescript
if (data.targetId) {
  spawnCmd = 'ssh';
  spawnArgs = ['-tt', '-F', '/dev/null', '-i', resolveKeyPath(targetKey),
               '-o', 'StrictHostKeyChecking=no', `${sshUser}@${targetIp}`];
}
```

- **Per-WebSocket session**: Each browser tab gets its own SSH process
- **Config lookup**: SSH credentials loaded from `data/remote_config.json`
- **Session cleanup**: Dead sessions detected and removed before reuse
- **Error handling**: Missing ssh binary emits `TERMINAL_LOG` error rather than crashing

## SSH Channel Exhaustion

A known production issue: SSH channel exhaustion on resource-constrained EC2 hosts can black out ALL commands for several minutes. This is why:

1. **Stale node pruning** uses a 15-minute grace period (not 5 minutes like the OFFLINE threshold)
2. **The `unhandledRejection` handler** in `server/index.ts` catches stray SSH rejections
3. **Discovery failures at boot are non-fatal** — caught and logged, not propagated
