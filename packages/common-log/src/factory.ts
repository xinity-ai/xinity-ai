import pino, { type StreamEntry } from "pino";
import { hostname } from "node:os";

export type LoggerOptions = {
  /** Pino log level. */
  level: pino.Level;
  /** Service name, added to every log line as `service`. */
  service: string;
  /** If set, write a JSONL log file to this directory, named after the process start date. */
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
 * When `logDir` is set, logs also go to a `.log.jsonl` file named after the
 * start date, which the process keeps writing to for its lifetime.
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
