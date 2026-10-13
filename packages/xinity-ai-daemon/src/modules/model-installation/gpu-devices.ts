import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { gpuCardId } from "common-env";
import { normalizePciBusId, type DetectedGpu, type GpuVendor } from "../hardware-detect";

export type RenderNode = { pciBusId: string; vendor: GpuVendor | null; path: string; gid: number };

export type HostDevices = { renderNodes: RenderNode[]; kfdGid: number | null };

export const NO_HOST_DEVICES: HostDevices = { renderNodes: [], kfdGid: null };

export type GpuDevices = {
  env: string[];
  supplementaryGroups: number[];
  dockerArgs: string[];
  tensorParallelSize: number;
};

type DeviceAccess = Omit<GpuDevices, "tensorParallelSize">;

type DeviceControl = {
  tensorParallel: boolean;
  unpinned(host: HostDevices): DeviceAccess;
  pinned(cards: readonly DetectedGpu[], host: HostDevices): DeviceAccess;
};

function requirePinField<K extends "uuid" | "index">(card: DetectedGpu, field: K): NonNullable<DetectedGpu[K]> {
  const value = card[field];
  if (value === undefined) {
    throw new Error(`GPU ${card.pciBusId ?? card.name} reports no ${field}, so it cannot be pinned`);
  }
  return value as NonNullable<DetectedGpu[K]>;
}

const uuidList = (cards: readonly DetectedGpu[]) => cards.map((card) => requirePinField(card, "uuid")).join(",");
const indexList = (cards: readonly DetectedGpu[]) => cards.map((card) => requirePinField(card, "index")).join(",");

function renderNodeOf(card: DetectedGpu, host: HostDevices): RenderNode {
  const node = host.renderNodes.find((candidate) => candidate.pciBusId === card.pciBusId);
  if (!node) {
    throw new Error(`No render node found for GPU ${card.pciBusId ?? card.name}`);
  }
  return node;
}

const renderNodesOf = (cards: readonly DetectedGpu[], host: HostDevices) => cards.map((card) => renderNodeOf(card, host));
const vendorRenderNodes = (vendor: GpuVendor, host: HostDevices) => host.renderNodes.filter((node) => node.vendor === vendor);
const deviceArgs = (paths: string[]) => paths.flatMap((path) => ["--device", path]);
const distinctGids = (gids: (number | null)[]) => [...new Set(gids.filter((gid) => gid !== null))];

// Level Zero counts integrated GPUs too, so the index comes from every Intel render node.
function levelZeroIndex(card: DetectedGpu, host: HostDevices): number {
  const busOrder = vendorRenderNodes("intel", host).map((node) => node.pciBusId).sort();
  return busOrder.indexOf(renderNodeOf(card, host).pciBusId);
}

const CUDA_PCI_ORDER = "CUDA_DEVICE_ORDER=PCI_BUS_ID";
// ROCm maps device memory through calls docker's default seccomp profile blocks.
const ROCM_DOCKER_ARGS = ["--group-add", "video", "--security-opt", "seccomp=unconfined"];
const LEVEL_ZERO_CARD_PER_DEVICE = "ZE_FLAT_DEVICE_HIERARCHY=COMPOSITE";

export const DEVICE_CONTROL: Record<GpuVendor, DeviceControl> = {
  nvidia: {
    tensorParallel: true,
    unpinned: () => ({
      env: [CUDA_PCI_ORDER, "CUDA_VISIBLE_DEVICES=0"],
      supplementaryGroups: [],
      dockerArgs: ["--gpus", "all", "-e", CUDA_PCI_ORDER],
    }),
    pinned: (cards) => ({
      env: [CUDA_PCI_ORDER, `CUDA_VISIBLE_DEVICES=${indexList(cards)}`],
      supplementaryGroups: [],
      // docker splits --gpus on commas unless the value is one quoted field
      dockerArgs: ["--gpus", `"device=${uuidList(cards)}"`, "-e", CUDA_PCI_ORDER],
    }),
  },
  amd: {
    tensorParallel: true,
    unpinned: (host) => ({
      env: [],
      supplementaryGroups: distinctGids([host.kfdGid, ...vendorRenderNodes("amd", host).map((node) => node.gid)]),
      dockerArgs: [...deviceArgs(["/dev/kfd", "/dev/dri"]), ...ROCM_DOCKER_ARGS],
    }),
    pinned: (cards, host) => {
      const nodes = renderNodesOf(cards, host);
      return {
        env: [`ROCR_VISIBLE_DEVICES=${uuidList(cards)}`],
        supplementaryGroups: distinctGids([host.kfdGid, ...nodes.map((node) => node.gid)]),
        dockerArgs: [...deviceArgs(["/dev/kfd", ...nodes.map((node) => node.path)]), ...ROCM_DOCKER_ARGS],
      };
    },
  },
  intel: {
    tensorParallel: false,
    unpinned: (host) => ({
      env: [LEVEL_ZERO_CARD_PER_DEVICE],
      supplementaryGroups: distinctGids(vendorRenderNodes("intel", host).map((node) => node.gid)),
      dockerArgs: [...deviceArgs(["/dev/dri"]), "-e", LEVEL_ZERO_CARD_PER_DEVICE],
    }),
    pinned: (cards, host) => {
      const nodes = renderNodesOf(cards, host);
      return {
        env: [
          LEVEL_ZERO_CARD_PER_DEVICE,
          "ZE_ENABLE_PCI_ID_DEVICE_ORDER=1",
          `ZE_AFFINITY_MASK=${cards.map((card) => levelZeroIndex(card, host)).join(",")}`,
        ],
        supplementaryGroups: distinctGids(nodes.map((node) => node.gid)),
        dockerArgs: [...deviceArgs(nodes.map((node) => node.path)), "-e", LEVEL_ZERO_CARD_PER_DEVICE],
      };
    },
  },
};

export function resolvePinnedCards(nodeGpus: readonly DetectedGpu[], cardIds: readonly string[]): DetectedGpu[] {
  return cardIds.map((id) => {
    const gpu = nodeGpus.find((candidate) => gpuCardId(candidate) === id);
    if (!gpu) {
      throw new Error(`Assigned GPU ${id} is not on this node`);
    }
    return gpu;
  });
}

export function devicesFor(pinnedCards: readonly DetectedGpu[], nodeGpus: readonly DetectedGpu[], host: HostDevices): GpuDevices {
  const vendor = (pinnedCards[0] ?? nodeGpus[0])?.vendor ?? "nvidia";
  if (pinnedCards.some((card) => card.vendor !== vendor)) {
    throw new Error("An installation cannot span GPUs of different vendors");
  }
  const control = DEVICE_CONTROL[vendor];
  if (pinnedCards.length > 1 && !control.tensorParallel) {
    throw new Error(`${vendor} GPUs run an installation on one card, tensor parallelism is not supported`);
  }
  const access = pinnedCards.length > 0 ? control.pinned(pinnedCards, host) : control.unpinned(host);
  return { ...access, tensorParallelSize: Math.max(pinnedCards.length, 1) };
}

export function unpinnedDevicesFor(nodeGpus: readonly DetectedGpu[], host: HostDevices): GpuDevices {
  return devicesFor([], nodeGpus, host);
}

const DRM_SYSFS_PATH = "/sys/class/drm";

const PCI_VENDORS: Record<string, GpuVendor> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

async function gidOf(path: string): Promise<number | null> {
  return stat(path).then((info) => info.gid, () => null);
}

async function readRenderNode(entry: string): Promise<RenderNode | null> {
  const [deviceLink, vendorId, gid] = await Promise.all([
    readlink(`${DRM_SYSFS_PATH}/${entry}/device`).catch(() => null),
    readFile(`${DRM_SYSFS_PATH}/${entry}/device/vendor`, "utf-8").then((text) => text.trim(), () => null),
    gidOf(`/dev/dri/${entry}`),
  ]);
  const pciBusId = normalizePciBusId(deviceLink?.split("/").pop());
  if (!pciBusId || gid === null) {
    return null;
  }
  return { pciBusId, vendor: (vendorId && PCI_VENDORS[vendorId]) || null, path: `/dev/dri/${entry}`, gid };
}

export async function readHostDevices(): Promise<HostDevices> {
  const entries = await readdir(DRM_SYSFS_PATH).catch(() => [] as string[]);
  const renderNodes = await Promise.all(entries.filter((entry) => /^renderD\d+$/.test(entry)).map(readRenderNode));
  return {
    renderNodes: renderNodes.filter((node) => node !== null),
    kfdGid: await gidOf("/dev/kfd"),
  };
}
