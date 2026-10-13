import { describe, test, expect, mock } from "bun:test";
import { mockConfigModule } from "../../mock-config";

mock.module("../../config", () => mockConfigModule());

const { devicesFor, unpinnedDevicesFor, resolvePinnedCards, NO_HOST_DEVICES } = await import("./gpu-devices");
type DetectedGpu = import("../hardware-detect").DetectedGpu;
type HostDevices = import("./gpu-devices").HostDevices;

const nvidia = (index: number): DetectedGpu => ({
  vendor: "nvidia", name: "NVIDIA L40S", vramMb: 46068, index, uuid: `GPU-n${index}`, pciBusId: `0000:0${index + 1}:00.0`,
});
const amd = (slot: number): DetectedGpu => ({
  vendor: "amd", name: "AMD Instinct MI300X", vramMb: 196608, uuid: `GPU-a${slot}`, pciBusId: `0000:${slot}3:00.0`,
});
const intel = (slot: number): DetectedGpu => ({
  vendor: "intel", name: "Intel(R) Data Center GPU Max 1550", vramMb: 131072, index: slot, pciBusId: `0000:${slot}9:00.0`,
});

const host: HostDevices = {
  kfdGid: 992,
  renderNodes: [
    { pciBusId: "0000:00:02.0", vendor: "intel", path: "/dev/dri/renderD128", gid: 44 },
    { pciBusId: "0000:13:00.0", vendor: "amd", path: "/dev/dri/renderD129", gid: 44 },
    { pciBusId: "0000:23:00.0", vendor: "amd", path: "/dev/dri/renderD130", gid: 44 },
    { pciBusId: "0000:29:00.0", vendor: "intel", path: "/dev/dri/renderD131", gid: 105 },
  ],
};

describe("devicesFor", () => {
  test("nvidia pins by index for systemd and by uuid for docker", () => {
    const devices = devicesFor([nvidia(1), nvidia(3)], [nvidia(0), nvidia(1), nvidia(2), nvidia(3)], NO_HOST_DEVICES);
    expect(devices.env).toEqual(["CUDA_DEVICE_ORDER=PCI_BUS_ID", "CUDA_VISIBLE_DEVICES=1,3"]);
    expect(devices.dockerArgs.slice(0, 2)).toEqual(["--gpus", "\"device=GPU-n1,GPU-n3\""]);
    expect(devices.tensorParallelSize).toBe(2);
  });

  test("an unpinned nvidia installation keeps the first card and docker's whole set", () => {
    const devices = unpinnedDevicesFor([nvidia(0), nvidia(1)], NO_HOST_DEVICES);
    expect(devices.env).toContain("CUDA_VISIBLE_DEVICES=0");
    expect(devices.dockerArgs.slice(0, 2)).toEqual(["--gpus", "all"]);
    expect(devices.tensorParallelSize).toBe(1);
  });

  test("amd pins by rocr uuid and hands docker only the cards' render nodes", () => {
    const devices = devicesFor([amd(2)], [amd(1), amd(2)], host);
    expect(devices.env).toEqual(["ROCR_VISIBLE_DEVICES=GPU-a2"]);
    expect(devices.dockerArgs).toContain("/dev/dri/renderD130");
    expect(devices.dockerArgs).not.toContain("/dev/dri/renderD129");
    expect(devices.dockerArgs).toContain("/dev/kfd");
    expect(devices.supplementaryGroups).toEqual([992, 44]);
  });

  test("an unpinned amd installation sees every card", () => {
    const devices = unpinnedDevicesFor([amd(1), amd(2)], host);
    expect(devices.env).toEqual([]);
    expect(devices.dockerArgs).toContain("/dev/dri");
  });

  test("intel numbers cards the way level zero does, integrated gpus included", () => {
    const devices = devicesFor([intel(2)], [intel(2)], host);
    expect(devices.env).toContain("ZE_AFFINITY_MASK=1");
    expect(devices.dockerArgs.slice(0, 2)).toEqual(["--device", "/dev/dri/renderD131"]);
    expect(devices.supplementaryGroups).toEqual([105]);
  });

  test("refuses tensor parallelism on intel", () => {
    expect(() => devicesFor([intel(2), intel(3)], [intel(2), intel(3)], host)).toThrow("tensor parallelism is not supported");
  });

  test("refuses an installation spanning vendors", () => {
    expect(() => devicesFor([nvidia(0), amd(1)], [nvidia(0), amd(1)], host)).toThrow("different vendors");
  });

  test("fails when a pinned card has no render node", () => {
    expect(() => devicesFor([amd(2)], [amd(2)], NO_HOST_DEVICES)).toThrow("No render node found for GPU 0000:23:00.0");
  });
});

describe("resolvePinnedCards", () => {
  test("finds a card without a uuid by its bus id", () => {
    expect(resolvePinnedCards([intel(2)], ["0000:29:00.0"])).toEqual([intel(2)]);
  });

  test("fails for a card the node does not have", () => {
    expect(() => resolvePinnedCards([nvidia(0)], ["GPU-gone"])).toThrow("Assigned GPU GPU-gone is not on this node");
  });
});
