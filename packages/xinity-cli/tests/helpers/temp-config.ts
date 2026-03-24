/**
 * Test helper for managing temporary config/env files.
 *
 * Creates isolated temp directories for each test to avoid
 * conflicts and filesystem pollution.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface TempDir {
  path: string;
  /** Write a file at a relative path inside the temp dir. */
  write(relativePath: string, content: string): string;
  /** Read a file at a relative path inside the temp dir. */
  read(relativePath: string): string;
  /** Check if a file exists at a relative path inside the temp dir. */
  exists(relativePath: string): boolean;
  /** Get the absolute path for a relative path inside the temp dir. */
  resolve(relativePath: string): string;
  /** Clean up the temp directory. */
  cleanup(): void;
}

/** Create an isolated temp directory for a test. */
export function createTempDir(prefix = "xinity-cli-test"): TempDir {
  const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });

  return {
    path,
    write(relativePath: string, content: string): string {
      const fullPath = join(path, relativePath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
      return fullPath;
    },
    read(relativePath: string): string {
      return readFileSync(join(path, relativePath), "utf-8");
    },
    exists(relativePath: string): boolean {
      return existsSync(join(path, relativePath));
    },
    resolve(relativePath: string): string {
      return join(path, relativePath);
    },
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
