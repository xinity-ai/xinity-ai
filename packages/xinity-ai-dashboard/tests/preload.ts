import { mock } from "bun:test";

mock.module("$app/environment", () => ({
  building: false,
  dev: false,
  browser: false,
}));
