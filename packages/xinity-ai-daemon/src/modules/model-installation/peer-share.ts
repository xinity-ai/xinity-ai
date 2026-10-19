import type { BunFile, Server } from "bun";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createRequestVerifier, rdmaPathsOf, signRequest, type DesiredGroup } from "common-env";
import { config } from "../../config";
import { rootLogger } from "../../logger";
import { lastInterconnectCheck } from "../statekeeper";
import type { SyncInstallation } from "../db-sync";
import { resolveInstallationEntry } from "./catalog";
import { cachedRepoDir, getFileSize, stallWatchdog, streamToFile, type FileRequest, type FileSource } from "./vllm-download";

const log = rootLogger.child({ name: "peer-share" });

export const PEER_SHARE_PORT = 29400;

const BLOB_PATH = /^\/blobs\/(.+)\/([0-9a-f]{40,64})$/;

type PeerFileState = { state: "downloading"; bytes: number } | { state: "absent" };

async function fileSize(file: string): Promise<number | undefined> {
  return (await stat(file).catch(() => undefined))?.size;
}

function rangeResponse(file: BunFile, size: number, range: string | null): Response {
  const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
  if (!match) {
    return new Response(file, { headers: { "accept-ranges": "bytes", "content-length": String(size) } });
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
}

export function peerShareHandler(sharedModels: () => ReadonlySet<string>, secret: () => string): (req: Request) => Promise<Response> {
  const verify = createRequestVerifier();
  return async (req) => {
    const url = new URL(req.url);
    const match = req.method === "GET" ? BLOB_PATH.exec(url.pathname) : null;
    if (!match) {
      return new Response("Not found", { status: 404 });
    }
    const verdict = verify(secret(), req.headers.get("authorization"), { method: req.method, path: url.pathname });
    if (!verdict.ok) {
      return new Response(`Unauthorized: ${verdict.reason}`, { status: 401 });
    }
    const model = match[1]!;
    const hash = match[2]!;
    // Checked before the name reaches a path, so only repositories this node shares can be read.
    if (!sharedModels().has(model)) {
      return new Response("Not shared", { status: 403 });
    }
    const blob = path.join(cachedRepoDir(model), "blobs", hash);
    const size = await fileSize(blob);
    if (size === undefined) {
      const bytes = await fileSize(`${blob}.incomplete`);
      const state: PeerFileState = bytes === undefined ? { state: "absent" } : { state: "downloading", bytes };
      return Response.json(state, { status: 404 });
    }
    return rangeResponse(Bun.file(blob), size, req.headers.get("range"));
  };
}

function createPeerShare(handler: (req: Request) => Promise<Response>) {
  let servers: Server<undefined>[] = [];
  let boundTo = "";
  const stop = () => {
    servers.forEach((server) => void server.stop(true));
    servers = [];
    boundTo = "";
  };
  return {
    share(addresses: string[]) {
      const key = addresses.toSorted().join(",");
      if (key === boundTo) {
        return;
      }
      stop();
      boundTo = key;
      servers = addresses.flatMap((address) => {
        try {
          return [Bun.serve({ hostname: address, port: PEER_SHARE_PORT, fetch: handler })];
        } catch (err) {
          log.warn({ err, address }, "Cannot share model files on this coupling address");
          return [];
        }
      });
      if (servers.length > 0) {
        log.info({ addresses, port: PEER_SHARE_PORT }, "Sharing model files with the other members of its groups");
      }
    },
  };
}

let sharedModels: ReadonlySet<string> = new Set();
const peerShare = createPeerShare(peerShareHandler(() => sharedModels, () => config.tether.secret));

export async function sharePeerFilesFor(installations: SyncInstallation[]): Promise<void> {
  // Rank 0 downloads a group's model first, so it shares it with the other members, on its own coupled addresses.
  const leading = installations.filter((installation) => installation.group?.rank === 0);
  const entries = await Promise.all(leading.map((installation) => resolveInstallationEntry(installation.specifier, "vllm")));
  sharedModels = new Set(entries.flatMap((entry) => (entry ? [entry.engineSpecifier] : [])));
  const subnets = new Set(leading.flatMap((installation) => installation.group!.addresses.map(({ subnet }) => subnet)));
  const addresses = lastInterconnectCheck().flatMap(rdmaPathsOf).filter(({ subnet }) => subnets.has(subnet)).map(({ address }) => address);
  peerShare.share(sharedModels.size > 0 ? [...new Set(addresses)] : []);
}


const PEER_POLL_MS = 5_000;

async function copyFromPeer(
  url: string,
  machine: string,
  { model, etag, sha256, incompletePath, expectedSize, stallMs, onBytes }: FileRequest,
): Promise<boolean> {
  const blobPath = `/blobs/${model}/${etag}`;
  let peerBytes = -1;
  let grewAt = Date.now();
  // The peer serves only files it has finished, so one it is still downloading is waited for while it grows.
  while (Date.now() - grewAt < stallMs) {
    const existingBytes = await getFileSize(incompletePath);
    const stall = stallWatchdog(stallMs);
    try {
      const response = await fetch(`${url}${blobPath}`, {
        headers: {
          authorization: signRequest(config.tether.secret, { method: "GET", path: blobPath }),
          ...(existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {}),
        },
        signal: stall.signal,
      });
      if (response.ok && response.body) {
        await streamToFile(incompletePath, response.body, existingBytes > 0 && response.status === 206, stall.signal, (bytes) => {
          stall.reset();
          return onBytes(bytes);
        });
        if (await matchesHash(incompletePath, sha256, expectedSize)) {
          return true;
        }
        await unlink(incompletePath);
        log.warn({ model, etag, peer: machine }, "File copied from the peer does not match its hash, downloading it instead");
        return false;
      }
      const peerFile = response.status === 404 ? (await response.json().catch(() => undefined)) as PeerFileState | undefined : undefined;
      if (peerFile?.state !== "downloading") {
        return false;
      }
      if (peerFile.bytes > peerBytes) {
        peerBytes = peerFile.bytes;
        grewAt = Date.now();
      }
    } catch (err) {
      log.warn({ err, model, etag, peer: machine }, "Copy from the peer failed, downloading the file instead");
      return false;
    } finally {
      stall.stop();
    }
    await Bun.sleep(Math.min(PEER_POLL_MS, stallMs / 4));
  }
  return false;
}

async function matchesHash(filePath: string, sha256: string | undefined, expectedSize: number): Promise<boolean> {
  if ((await getFileSize(filePath)) !== expectedSize) {
    return false;
  }
  // The listing gives a SHA-256 for the large files only, and the cache's file names are no hash of their content on every storage.
  if (!sha256) {
    return true;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(filePath).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex") === sha256;
}

export function peerSourceFor(group: DesiredGroup | null | undefined): FileSource | undefined {
  if (!group || group.rank === 0) {
    return undefined;
  }
  const { machineName, addresses } = group.masterHost;
  const address = addresses.find(({ subnet }) => subnet === group.addresses[0]!.subnet) ?? addresses[0];
  return address && {
    name: machineName,
    fetch: (request) => copyFromPeer(`http://${address.address}:${PEER_SHARE_PORT}`, machineName, request),
  };
}
