import { Ollama } from "ollama";
import { bufferTime, concatMap, defer, endWith, from, ignoreElements, map, merge, mergeMap, Observable, switchMap, tap } from "rxjs";
import { env } from "../../env";
import { getDB } from "../../db/connection";
import { ModelInstallation, modelInstallationStateT } from "common-db";
import { rootLogger } from "../../logger";

const log = rootLogger.child({ name: "ollama" });

let _ollama: Ollama | null = null;
export function getOllamaClient(): Ollama {
  if (!_ollama) {
    if (!env.XINITY_OLLAMA_ENDPOINT) throw new Error("env.XINITY_OLLAMA_ENDPOINT is not configured but ollama sync was triggered");
    _ollama = new Ollama({ host: env.XINITY_OLLAMA_ENDPOINT });
  }
  return _ollama;
}

const OLLAMA_CONCURRENCY = 2;

function consumePull$({model, id}: ModelInstallation): Observable<void> {
  return defer(() => from(getOllamaClient().pull({ model, stream: true }))).pipe(
    switchMap((res) => from(res)),
    bufferTime(15 * 1000),
    concatMap(async (chunk) => {
      const newest = chunk.at(-1);
      if(newest){
        const isDownloading = newest.completed != null && newest.total != null && newest.total > 0;
        const progress = isDownloading ? (newest.completed / newest.total) : null;
        const isDone = newest.status === "success";
        const isInstalling = newest.status.startsWith("verifying");
        const lifecycleState = isDone ? "ready" : isInstalling ? "installing" : "downloading";

        try {
          await getDB().insert(modelInstallationStateT)
            .values({
              id, lifecycleState, progress, statusMessage: newest.status,
            })
            .onConflictDoUpdate({
            set: {lifecycleState, progress, statusMessage: newest.status},
            target: modelInstallationStateT.id,
          })
        } catch (err) {
          log.error({ err, model, installationId: id }, "Failed to update pull progress");
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
  return defer(() => from(getOllamaClient().list())).pipe(
    map((existingInstallations) => {
      const desiredModels = new Set(installations.map((i) => i.model));
      const existingModels = new Set(
        existingInstallations.models.map((i) => i.model)
      );

      const toRemove = existingInstallations.models.filter(
        (i) => !desiredModels.has(i.model)
      );
      const toAdd = installations.filter((i) => !existingModels.has(i.model));

      return { toRemove, toAdd };
    }),
    tap(({ toRemove, toAdd }) => {
      if(toRemove.length)
        log.info(
          { models: toRemove.map((i) => i.model) },
          "Removing installations"
        );
      if(toAdd.length)
        log.info(
          { models: toAdd.map((i) => i.model) },
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
        mergeMap((i) => consumePull$(i), OLLAMA_CONCURRENCY)
      );

      return merge(remove$, add$).pipe(ignoreElements(), endWith(void 0));
    })
  );
}
