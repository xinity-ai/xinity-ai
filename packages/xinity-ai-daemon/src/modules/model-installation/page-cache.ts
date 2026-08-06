import { $ } from "bun";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "page-cache" });

export async function dropPageCache(): Promise<void> {
  const result = await $`sh -c 'sync && echo 3 > /proc/sys/vm/drop_caches'`.quiet().nothrow();
  if (result.exitCode !== 0) {
    log.warn({ stderr: result.stderr.toString() }, "Failed to drop page cache before model start");
  }
}
