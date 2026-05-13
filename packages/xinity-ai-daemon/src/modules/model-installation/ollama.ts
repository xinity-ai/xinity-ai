import { Ollama } from "ollama";
import { bufferTime, concatMap, defer, endWith, from, ignoreElements, map, merge, mergeMap, Observable, switchMap, tap } from "rxjs";
import { env } from "../../env";
import { ModelInstallation } from "common-db";
import { createInfoserverClient } from "xinity-infoserver";
import { rootLogger } from "../../logger";
import { updateInstallationState } from "./state";

const log = rootLogger.child({ name: "ollama" });

const infoClient = createInfoserverClient({ baseUrl: env.INFOSERVER_URL, cacheTtlMs: env.INFOSERVER_CACHE_TTL_MS });

let _ollama: Ollama | null = null;
export function getOllamaClient(): Ollama {
  if (!_ollama) {
    if (!env.XINITY_OLLAMA_ENDPOINT) throw new Error("env.XINITY_OLLAMA_ENDPOINT is not configured but ollama sync was triggered");
    _ollama = new Ollama({ host: env.XINITY_OLLAMA_ENDPOINT });
  }
  return _ollama;
}

const OLLAMA_CONCURRENCY = 2;

/** Installation paired with its catalog-resolved Ollama provider tag. */
type ResolvedInstallation = { installation: ModelInstallation; tag: string };

async function resolveInstallations(installations: Array<ModelInstallation>): Promise<ResolvedInstallation[]> {
  const resolved: ResolvedInstallation[] = [];
  for (const installation of installations) {
    const model = await infoClient.fetchModel(installation.specifier);
    const tag = model?.providers.ollama;
    if (!tag) {
      log.warn({ specifier: installation.specifier, installationId: installation.id }, "Catalog has no ollama provider for installation, skipping");
      continue;
    }
    resolved.push({ installation, tag });
  }
  return resolved;
}

function consumePull$({ installation, tag }: ResolvedInstallation): Observable<void> {
  return defer(() => from(getOllamaClient().pull({ model: tag, stream: true }))).pipe(
    switchMap((res) => from(res)),
    bufferTime(15 * 1000),
    concatMap(async (chunk) => {
      const newest = chunk.at(-1);
      if (newest){
        const isDownloading = newest.completed != null && newest.total != null && newest.total > 0;
        const progress = isDownloading ? (newest.completed / newest.total) : null;
        const isDone = newest.status === "success";
        const isInstalling = newest.status.startsWith("verifying");
        const lifecycleState = isDone ? "ready" : isInstalling ? "installing" : "downloading";

        try {
          await updateInstallationState(installation.id, lifecycleState, { progress, statusMessage: newest.status });
        } catch (err) {
          log.error({ err, tag, installationId: installation.id }, "Failed to update pull progress");
        }
      }
    }),
    ignoreElements(),
    endWith(void 0)
  );
}

export function syncOllamaInstallations$(
  installations: Array<ModelInstallation>
): Observable<void> {
  return defer(() => from(resolveInstallations(installations))).pipe(
    switchMap((resolved) =>
      from(getOllamaClient().list()).pipe(
        map((existingInstallations) => {
          const desiredTags = new Set(resolved.map((r) => r.tag));
          const existingTags = new Set(
            existingInstallations.models.map((i) => i.model)
          );

          const toRemove = existingInstallations.models.filter(
            (i) => !desiredTags.has(i.model)
          );
          const toAdd = resolved.filter((r) => !existingTags.has(r.tag));

          return { toRemove, toAdd };
        }),
        tap(({ toRemove, toAdd }) => {
          if (toRemove.length)
            log.info(
              { models: toRemove.map((i) => i.model) },
              "Removing installations"
            );
          if (toAdd.length)
            log.info(
              { models: toAdd.map((r) => r.tag) },
              "Adding installations"
            );
        }),
        switchMap(({ toRemove, toAdd }) => {
          const remove$ = from(toRemove).pipe(
            mergeMap(
              (i) => defer(() => from(getOllamaClient().delete({ model: i.model }))),
              OLLAMA_CONCURRENCY
            )
          );

          const add$ = from(toAdd).pipe(
            mergeMap((r) => consumePull$(r), OLLAMA_CONCURRENCY)
          );

          return merge(remove$, add$).pipe(ignoreElements(), endWith(void 0));
        })
      )
    )
  );
}
