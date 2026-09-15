type LogFn = (obj: object, msg: string) => void;

/** `common-log` depends on this package, so its `Logger` type cannot be imported here. */
export type PinoLike = {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
};
