export type StepEvent =
  | { type: "pass"; label: string; detail?: string }
  | { type: "fail"; label: string; detail?: string }
  | { type: "warn"; label: string; detail?: string }
  | { type: "info"; label: string; detail?: string }
  | { type: "spinner"; id: string; message?: string; done?: boolean }
  | { type: "log"; message: string };
