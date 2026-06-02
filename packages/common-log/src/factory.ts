import pino, { type StreamEntry } from "pino";
import { hostname } from "os";

export type LoggerOptions = {
  /** Pino log level. */
  level: string;
  /** Service name, added to every log line as `service`. */
  service: string;
  /** If set, write JSONL log files to this directory (one per day). */
  logDir?: string;
};

function dayStamp(): string {
  const [datePart = ""] = new Date().toISOString().split("T");
  return datePart.replace(/-/g, ".");
}

function stdoutStream() {
  return pino.destination({ dest: 1, sync: false });
}

function dailyFileStream(logDir: string) {
  return pino.destination({
    dest: `${logDir}/${dayStamp()}.log.jsonl`,
    mkdir: true,
    append: true,
    sync: false,
  });
}

/**
 * Create a pino logger.
 *
 * Uses `pino.destination()` with `sync: false` for buffered async I/O
 * on the main thread, no worker threads, works in compiled binaries.
 *
 * When `logDir` is set, a daily `.log.jsonl` file is created alongside stdout.
 */
export function createLogger(opts: LoggerOptions): pino.Logger {
  const pinoOpts: pino.LoggerOptions = {
    level: opts.level,
    base: { pid: process.pid, hostname: hostname(), service: opts.service },
  };

  if (!opts.logDir) {
    return pino(pinoOpts, stdoutStream());
  }

  const streams: StreamEntry[] = [
    { stream: stdoutStream() },
    { stream: dailyFileStream(opts.logDir) },
  ];

  return pino(pinoOpts, pino.multistream(streams));
}
