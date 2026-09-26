import { describe, expect, test } from "bun:test";
import { buildSeaweedfsCommands, type SeaweedfsPlan } from "../../src/lib/seaweedfs-setup.ts";

const credentials = {
  endpoint: "http://127.0.0.1:8333",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t",
  bucket: "xinity-media",
};

const plan: SeaweedfsPlan = {
  dataDir: "/var/lib/xinity-ai-seaweedfs/data",
  credentials,
  s3Config: '{"identities":[]}',
  unitFile: "[Unit]\nDescription=Xinity SeaweedFS Object Store\n",
};

const withDownload: SeaweedfsPlan = {
  ...plan,
  download: {
    version: "3.80",
    url: "https://github.com/seaweedfs/seaweedfs/releases/download/3.80/linux_amd64_large_disk.tar.gz",
    tmpTar: "/tmp/seaweedfs-3.80.tar.gz",
  },
};

describe("buildSeaweedfsCommands", () => {
  test("an already-installed host skips the download entirely", () => {
    const commands = buildSeaweedfsCommands(plan);
    expect(commands.some((c) => c.startsWith("curl -fL"))).toBe(false);
    expect(commands.some((c) => c.includes("tar -xzf"))).toBe(false);
  });

  test("the data dir is created before the unit that declares it read-write", () => {
    const commands = buildSeaweedfsCommands(plan);
    const mkdir = commands.findIndex((c) => c === `mkdir -p ${plan.dataDir}`);
    const unit = commands.findIndex((c) => c.includes("xinity-ai-seaweedfs.service") && c.startsWith("cat >"));
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(unit).toBeGreaterThan(mkdir);
  });

  test("the service is only enabled once its config and unit are written", () => {
    const commands = buildSeaweedfsCommands(plan);
    const enable = commands.findIndex((c) => c.startsWith("systemctl enable"));
    const s3Config = commands.findIndex((c) => c.includes("seaweedfs-s3.json"));
    const reload = commands.findIndex((c) => c === "systemctl daemon-reload");
    expect(s3Config).toBeLessThan(enable);
    expect(reload).toBeLessThan(enable);
  });

  test("the bucket is created last, after the endpoint could answer", () => {
    const commands = buildSeaweedfsCommands(plan);
    expect(commands.at(-1)).toContain(`${credentials.endpoint}/${credentials.bucket}`);
    expect(commands.findIndex((c) => c.startsWith("systemctl enable")))
      .toBeLessThan(commands.length - 1);
  });

  test("a download lands the binary and marks it executable before anything runs it", () => {
    const commands = buildSeaweedfsCommands(withDownload);
    const download = commands.findIndex((c) => c.includes(withDownload.download!.url));
    const chmod = commands.findIndex((c) => c.startsWith("chmod +x"));
    const enable = commands.findIndex((c) => c.startsWith("systemctl enable"));
    expect(download).toBe(0);
    expect(chmod).toBeGreaterThan(download);
    expect(chmod).toBeLessThan(enable);
  });
});
