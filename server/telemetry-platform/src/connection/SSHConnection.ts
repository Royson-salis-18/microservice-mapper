import { readFileSync } from "node:fs";
import { Client as SSHClient } from "ssh2";
import type { Connection } from "./Connection.js";
import type { RemoteCommand, RemoteCommandResult } from "./RemoteCommand.js";
import type { SSHConnectionConfig } from "../types/target.js";

/**
 * SSH-backed Connection. The private key is read from disk once at
 * connect() time and never logged, never embedded in config, never
 * transmitted anywhere except to the ssh2 client itself.
 */
export class SSHConnection implements Connection {
  readonly targetId: string;
  private client: SSHClient | null = null;
  private connected = false;

  constructor(
    targetId: string,
    private readonly config: SSHConnectionConfig,
  ) {
    this.targetId = targetId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    const privateKey = readFileSync(this.config.privateKeyPath);
    const passphrase = this.config.passphraseEnvVar
      ? process.env[this.config.passphraseEnvVar]
      : undefined;

    await new Promise<void>((resolve, reject) => {
      const client = new SSHClient();
      client
        .on("ready", () => {
          this.client = client;
          this.connected = true;
          resolve();
        })
        .on("error", (err) => {
          this.connected = false;
          this.client = null;
          reject(new Error(`SSH connect failed for ${this.targetId}: ${err.message}`));
        })
        .on("close", () => {
          this.connected = false;
          this.client = null;
        })
        .connect({
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          privateKey,
          passphrase,
          readyTimeout: this.config.readyTimeoutMs ?? 15_000,
        });
    });
  }

  async execute<T>(cmd: RemoteCommand<T>): Promise<RemoteCommandResult<T>> {
    if (!this.client || !this.connected) {
      throw new Error(`Not connected to target ${this.targetId}`);
    }
    const started = Date.now();

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let channel: any = null;

      /**
       * Give the channel back to the SSH server.
       *
       * Timing out used to resolve the promise and walk away, leaving the
       * channel open with the command still running on the other end. Each
       * one holds a slot against the server's MaxSessions (OpenSSH defaults
       * to 10), so on a loaded host — where these commands time out often —
       * the slots fill up and then *every* subsequent exec fails with
       * "(SSH) Channel open failure: open failed", which is exactly what
       * the telemetry warnings were showing across all three targets.
       */
      const releaseChannel = () => {
        try {
          channel?.close?.();
          channel?.destroy?.();
        } catch {
          // Best effort: the channel may already be gone, and failing to
          // close it must never fail the command's result.
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        releaseChannel();
        resolve({
          name: cmd.name,
          command: cmd.command,
          exitCode: null,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          truncated,
          error: `Command timed out after ${cmd.timeoutMs}ms`,
        });
      }, cmd.timeoutMs);

      this.client!.exec(cmd.command, (err, stream) => {
        channel = stream;

        // The open itself can outlast the timeout. Without this the
        // just-opened channel would be orphaned the moment it arrived.
        if (settled) {
          releaseChannel();
          return;
        }

        if (err) {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve({
            name: cmd.name,
            command: cmd.command,
            exitCode: null,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - started,
            truncated: false,
            error: err.message,
          });
          return;
        }

        stream
          .on("close", (code: number | null) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            let parsed: T | undefined;
            let parseError: string | undefined;
            if (cmd.parser) {
              try {
                parsed = cmd.parser(stdout);
              } catch (e) {
                parseError = e instanceof Error ? e.message : String(e);
              }
            }
            resolve({
              name: cmd.name,
              command: cmd.command,
              exitCode: code,
              stdout,
              stderr,
              durationMs: Date.now() - started,
              truncated,
              parsed,
              error: parseError,
            });
          })
          .on("data", (chunk: Buffer) => {
            if (stdout.length < cmd.maxOutputBytes) {
              stdout += chunk.toString("utf8");
              if (stdout.length > cmd.maxOutputBytes) {
                stdout = stdout.slice(0, cmd.maxOutputBytes);
                truncated = true;
              }
            } else {
              truncated = true;
            }
          })
          .stderr.on("data", (chunk: Buffer) => {
            if (stderr.length < cmd.maxOutputBytes) {
              stderr += chunk.toString("utf8");
            }
          });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.client?.end();
    this.client = null;
    this.connected = false;
  }
}
