/*
 * `agentglass-server plugin-bridge --listen 127.0.0.1:<port> --socket <path>
 * -- <cmd...>` — dispatched by cookieentry.ts, the same way `cookies` is,
 * before any import that would open the database.
 *
 * Runs INSIDE a `network: "agentglass"` box, where `sandboxArgv`'s
 * `--unshare-net` has cut off every interface but the box's own loopback.
 * The plugin it wraps still only ever knows `AGENTGLASS_URL =
 * http://127.0.0.1:<port>` — see the network comment on `sandboxArgv` in
 * plugin-sandbox.ts — so this proxies that loopback TCP port to the one
 * socket bwrap bind-mounted into the box (`PLUGIN_SOCKET_BOX_PATH`), which is
 * the SAME socket plugin-socket.ts serves from outside the box and never
 * treats as a local caller. Neither side of the proxy knows about the other's
 * trust boundary; it only carries bytes.
 *
 * Ceiling: one Bun process per boxed plugin. Cheaper than it sounds — this
 * process holds no state but the open connections themselves — but it is a
 * process nonetheless, on top of the plugin's own.
 *
 * No DB, no config, no HOME read: this file never imports db.ts or anything
 * that would, and it exits when the wrapped command does, so nothing outlives
 * the plugin it is proxying for.
 */
import type { Socket } from "bun";
import { constants as osConstants } from "node:os";

interface ParsedArgs {
  listenHost: string;
  listenPort: number;
  socketPath: string;
  cmd: string[];
}

export function parsePluginBridgeArgs(argv: string[]): ParsedArgs | null {
  let listen = "";
  let socketPath = "";
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--listen") {
      listen = argv[++i] ?? "";
    } else if (a === "--socket") {
      socketPath = argv[++i] ?? "";
    } else if (a === "--") {
      i++;
      break;
    } else {
      return null;
    }
  }
  const cmd = argv.slice(i);
  const colon = listen.lastIndexOf(":");
  if (colon < 0 || !socketPath || cmd.length === 0) return null;
  const listenHost = listen.slice(0, colon);
  const listenPort = Number(listen.slice(colon + 1));
  if (!listenHost || !Number.isInteger(listenPort) || listenPort <= 0) return null;
  return { listenHost, listenPort, socketPath, cmd };
}

// A 20 MB upload arrived whole in testing (the OS socket buffer happened to
// cover it), a 1 MB one did not: `socket.write()` returns the byte count it
// actually took, and the rest was silently dropped on the floor because
// nothing here queued it or waited for `drain`. Same bug in both directions.
const MAX_DIAL_PENDING_BYTES = 4 * 1024 * 1024;

/** Per-TCP-connection state: bytes that arrived before the matching unix
 *  connection finished dialling are queued here rather than dropped — a
 *  plugin's first request can otherwise race the bridge's own `Bun.connect`.
 *  `toUnix` is the unwritten tail of a partial write toward the unix side,
 *  flushed from that socket's own `drain`. */
interface TcpData {
  pending: Buffer[];
  pendingBytes: number;
  unix: Socket<UnixData> | null;
  unixClosed: boolean;
  toUnix: Buffer[];
}
interface UnixData {
  tcp: Socket<TcpData>;
  // Unwritten tail of a partial write toward the tcp side, flushed from
  // the tcp socket's own `drain`. Symmetric with `TcpData.toUnix`.
  toTcp: Buffer[];
}

/** Write what will go, queue what will not, and pause `source` until the
 *  other end's `drain` catches the queue up — never silently drop a tail. */
function sendOrQueue<D>(dest: Socket<D>, chunk: Buffer, queue: Buffer[], source: Socket<unknown>): void {
  if (queue.length > 0) {
    queue.push(chunk);
    return;
  }
  const n = dest.write(chunk);
  if (n < chunk.length) {
    queue.push(chunk.subarray(n));
    source.pause();
  }
}

/** Called from the writable side's own `drain`: flush as much of `queue` as
 *  will go, and resume `source` once the backlog is gone. */
function flushQueue(dest: Socket<unknown>, queue: Buffer[], source: Socket<unknown>): void {
  while (queue.length > 0) {
    const chunk = queue[0]!;
    const n = dest.write(chunk);
    if (n < chunk.length) {
      queue[0] = chunk.subarray(n);
      return;
    }
    queue.shift();
  }
  source.resume();
}

/**
 * `Bun.listen` on the box's loopback, each connection piped both ways to
 * `Bun.connect({ unix })`. Throws when it cannot bind; `runPluginBridge`
 * turns that into a non-zero exit before the wrapped command is started.
 */
function startProxy(host: string, port: number, unixPath: string): void {
  Bun.listen<TcpData>({
    hostname: host,
    port,
    socket: {
      open(tcp) {
        tcp.data = { pending: [], pendingBytes: 0, unix: null, unixClosed: false, toUnix: [] };
        // Paused for the whole dial: a slow `Bun.connect` used to let
        // `pending` grow until a byte cap dropped the connection outright,
        // killing a large upload the drain logic further down would
        // otherwise have carried just fine once dialled. Backpressure
        // instead of a cap — resumed in `open` below once there is
        // somewhere for the bytes to go.
        tcp.pause();
        Bun.connect<UnixData>({
          unix: unixPath,
          data: { tcp, toTcp: [] },
          socket: {
            open(unix) {
              tcp.data.unix = unix;
              for (const chunk of tcp.data.pending) sendOrQueue(unix, chunk, tcp.data.toUnix, tcp);
              tcp.data.pending = [];
              tcp.data.pendingBytes = 0;
              tcp.resume();
            },
            data(unix, chunk) {
              sendOrQueue(unix.data.tcp, Buffer.from(chunk), unix.data.toTcp, unix);
            },
            drain(unix) {
              flushQueue(unix, unix.data.tcp.data.toUnix, unix.data.tcp);
            },
            close(unix) {
              tcp.data.unixClosed = true;
              try {
                unix.data.tcp.end();
              } catch {
                /* already gone */
              }
            },
            error(unix) {
              tcp.data.unixClosed = true;
              try {
                unix.data.tcp.end();
              } catch {
                /* already gone */
              }
            },
          },
        }).catch(() => {
          tcp.data.unixClosed = true;
          try {
            tcp.end();
          } catch {
            /* already gone */
          }
        });
      },
      data(tcp, chunk) {
        if (tcp.data.unix) {
          sendOrQueue(tcp.data.unix, Buffer.from(chunk), tcp.data.toUnix, tcp);
          return;
        }
        if (tcp.data.unixClosed) return;
        const buf = Buffer.from(chunk);
        tcp.data.pendingBytes += buf.length;
        // The dial has not resolved yet and nothing is reading this queue
        // down: past the cap, drop the connection rather than grow it
        // without bound (this is the same bug as the missing drain handler,
        // one step earlier — before there is even a socket to back-pressure).
        if (tcp.data.pendingBytes > MAX_DIAL_PENDING_BYTES) {
          tcp.end();
          return;
        }
        tcp.data.pending.push(buf);
      },
      drain(tcp) {
        const unix = tcp.data.unix;
        if (unix) flushQueue(tcp, unix.data.toTcp, unix);
      },
      close(tcp) {
        try {
          tcp.data.unix?.end();
        } catch {
          /* already gone */
        }
      },
      error(tcp) {
        try {
          tcp.data.unix?.end();
        } catch {
          /* already gone */
        }
      },
    },
  });
}

export async function runPluginBridge(argv: string[]): Promise<number> {
  const parsed = parsePluginBridgeArgs(argv);
  if (!parsed) {
    console.error("usage: agentglass-server plugin-bridge --listen host:port --socket path -- <cmd...>");
    return 2;
  }
  const { listenHost, listenPort, socketPath, cmd } = parsed;
  try {
    startProxy(listenHost, listenPort, socketPath);
  } catch (e) {
    // Fatal: a plugin whose only route to the app is a bridge that is not
    // there fails every call with "connection refused" and says nothing else,
    // while a box that exits at once is a start failure the panel can show.
    console.error(`plugin-bridge: could not listen on ${listenHost}:${listenPort}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // `Bun.spawn`, not `node:child_process`: the rest of this app already
  // spawns every subprocess this way (plugins.ts, `git`, …), and `exited`
  // resolves the propagated exit code without a second signal-to-number
  // table — Bun's own `exitCode`/`signalCode` already separate the two.
  const child = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  const onTerm = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("SIGTERM", onTerm);
  try {
    await child.exited;
    // A hardcoded 128 said every signal was the same signal: the panel
    // could not tell a SIGKILL from a SIGTERM apart, both reported as
    // "128". `os.constants.signals` is the same table `128 + signo` is
    // conventionally built from (matches a shell's own `$?` after a
    // signalled child); fall back to 128 only for a signal name the table
    // does not have, rather than throwing on it.
    return child.exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1);
  } finally {
    process.off("SIGTERM", onTerm);
  }
}
