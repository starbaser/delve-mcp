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
 * Start a new debug session
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
    target,
    ...args
  ];

  const process = spawn("dlv", dlvArgs, {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const session: DebugSession = {
    id,
    type,
    target,
    process,
    port,
    breakpoints: new Map()
  };

  sessions.set(id, session);
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