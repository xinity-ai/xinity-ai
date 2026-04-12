import pino, { type StreamEntry } from "pino";

export type LoggerOptions = {
  /** Pino log level. */
  level: string;
  /** Service name, added to every log line as `service`. */
  service: string;
  /** If set, write JSONL log files to this directory (one per day). */
  logDir?: string;
};

function dayStamp(): string {
  return new Date().toISOString().split("T")[0]!.replace(/-/g, ".");
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
  };

  if (!opts.logDir) {
    return pino(pinoOpts, pino.destination({ dest: 1, sync: false }));
  }

  const streams: StreamEntry[] = [
    { level: opts.level as pino.Level, stream: pino.destination({ dest: 1, sync: false }) },
    {
      level: opts.level as pino.Level,
      stream: pino.destination({
        dest: `${opts.logDir}/${dayStamp()}.log.jsonl`,
        mkdir: true,
        append: true,
        sync: false,
      }),
    },
  ];

  return pino(pinoOpts, pino.multistream(streams));
}
