import { spawn } from "child_process";
import { createServer, createConnection } from "net";
import { DebugSession } from "./types.js";

let _rpcId = 1;

/**
 * Active debug sessions
 */
export const sessions: Map<string, DebugSession> = new Map();

/**
 * Get an available port by attempting to create a server
 */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('Could not get server address'));
      }
    });
  });
}

/**
 * Start a new debug session.
 * Waits for dlv to emit "API server listening" on stderr before resolving.
 */
export async function startDebugSession(type: string, target: string, args: string[] = []): Promise<DebugSession> {
  const port = await getAvailablePort();
  const id = Math.random().toString(36).substring(7);

  const dlvArgs = [
    type,
    "--headless",
    `--listen=:${port}`,
    "--accept-multiclient",
    "--api-version=2",
    ...(target ? [target] : []),
    ...args
  ];

  const child = spawn("dlv", dlvArgs, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const session: DebugSession = {
    id,
    type,
    target,
    process: child,
    port,
    breakpoints: new Map()
  };

  sessions.set(id, session);

  // Wait for dlv to be ready or fail
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Delve failed to start within 30s. stderr:\n${stderr}`));
    }, 30000);

    const onData = (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes("API server listening at:")) {
        clearTimeout(timeout);
        child.stderr?.off("data", onData);
        resolve();
      }
    };

    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      clearTimeout(timeout);
      sessions.delete(id);
      reject(new Error(`Failed to spawn dlv: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      sessions.delete(id);
      reject(new Error(`dlv exited with code ${code} before becoming ready. stderr:\n${stderr}`));
    });
  });

  return session;
}

/**
 * Send a JSON-RPC command to a running delve session over raw TCP.
 * Delve's headless API speaks JSON-RPC 1.0 over a plain TCP socket — not HTTP.
 */
export async function sendDelveCommand(session: DebugSession, command: string, args: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = _rpcId++;
    const request = JSON.stringify({
      method: `RPCServer.${command}`,
      params: [args],
      id,
    }) + "\n";

    const socket = createConnection({ port: session.port, host: "127.0.0.1" });
    let buf = "";

    socket.setTimeout(10000);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      try {
        const resp = JSON.parse(buf);
        socket.destroy();
        if (resp.error) {
          reject(new Error(resp.error));
        } else {
          resolve(resp.result ?? {});
        }
      } catch {
        // incomplete JSON, keep buffering
      }
    });
    socket.on("timeout", () => { socket.destroy(); reject(new Error("Delve RPC timeout")); });
    socket.on("error", reject);
  });
}