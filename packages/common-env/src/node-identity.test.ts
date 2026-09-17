import { describe, expect, test } from "bun:test";
import { generateNodeKeypair, readNodeKeypair, signAsNode, verifyNodeSignature } from "./node-identity";
import {
  canonicalRegistration,
  canonicalStateReport,
  installationStatePayloadSchema,
  nodeRegistrationSchema,
  type InstallationStatePayload,
  type UnsignedNodeRegistration,
} from "./tether-protocol";

const keypair = generateNodeKeypair();

describe("node signatures", () => {
  test("verifies what the matching key signed", () => {
    const signature = signAsNode(keypair.privateKeyPem, "payload");
    expect(verifyNodeSignature(keypair.publicKey, "payload", signature)).toBe(true);
  });

  test("refuses a payload changed after signing", () => {
    const signature = signAsNode(keypair.privateKeyPem, "payload");
    expect(verifyNodeSignature(keypair.publicKey, "payload!", signature)).toBe(false);
  });

  test("refuses another node's key, which is the claim being blocked", () => {
    const signature = signAsNode(generateNodeKeypair().privateKeyPem, "payload");
    expect(verifyNodeSignature(keypair.publicKey, "payload", signature)).toBe(false);
  });

  test("returns false rather than throwing on a key or signature that is not one", () => {
    expect(verifyNodeSignature("not-a-key", "payload", "not-a-signature")).toBe(false);
  });

  test("reads a corrupt key file as absent, so the daemon regenerates instead of crashing", () => {
    expect(readNodeKeypair("-----BEGIN PRIVATE KEY-----\nrubbish\n-----END PRIVATE KEY-----")).toBeNull();
  });

  test("derives the same public key from a stored private key", () => {
    expect(readNodeKeypair(keypair.privateKeyPem)?.publicKey).toBe(keypair.publicKey);
  });
});

describe("canonical payloads", () => {
  const base: UnsignedNodeRegistration = {
    nodeId: "3f1a2b3c-0000-4000-8000-000000000001",
    host: "10.0.0.1",
    port: 4044,
    gpuCount: 1,
    gpus: [{ vendor: "nvidia", name: "RTX 4090", vramMb: 24576 }],
    driverVersions: { vllm: "0.8.0", ollama: "0.6.3" },
    driverFeatures: { vllm: ["audio"] },
    tls: false,
    estCapacity: 24,
    authToken: "token",
    protocolFingerprint: "fp",
    publicKey: keypair.publicKey,
  };

  // The wire preserves key order, so a daemon and a tether that iterate differently would
  // otherwise disagree on the bytes and reject every registration.
  test("does not depend on the order of driver record keys", () => {
    const reordered = { ...base, driverVersions: { ollama: "0.6.3", vllm: "0.8.0" } };
    expect(canonicalRegistration(reordered)).toBe(canonicalRegistration(base));
  });

  // A field added to the schema but not to the canonical form would travel unsigned, and the
  // protocol fingerprint would not catch it. Adding a field here is the reminder to cover it.
  const REGISTRATION_MUTATIONS: Record<string, Partial<UnsignedNodeRegistration>> = {
    nodeId: { nodeId: "3f1a2b3c-0000-4000-8000-000000000002" },
    host: { host: "10.0.0.9" },
    port: { port: 1 },
    gpuCount: { gpuCount: 2 },
    gpus: { gpus: [] },
    driverVersions: { driverVersions: { vllm: "9.9.9" } },
    driverFeatures: { driverFeatures: {} },
    tls: { tls: true },
    estCapacity: { estCapacity: 48 },
    machineName: { machineName: "renamed" },
    authToken: { authToken: "other" },
    protocolFingerprint: { protocolFingerprint: "other" },
    publicKey: { publicKey: generateNodeKeypair().publicKey },
  };

  test("signs every field of the registration schema", () => {
    for (const field of Object.keys(nodeRegistrationSchema.shape)) {
      if (field === "signature") {
        continue;
      }
      const mutation = REGISTRATION_MUTATIONS[field];
      expect(mutation, `${field} is in the schema but not covered here`).toBeDefined();
      expect(canonicalRegistration({ ...base, ...mutation })).not.toBe(canonicalRegistration(base));
    }
  });

  const STATE_MUTATIONS: Record<string, Partial<InstallationStatePayload>> = {
    installationId: { installationId: "3f1a2b3c-0000-4000-8000-0000000000ff" },
    lifecycleState: { lifecycleState: "failed" },
    progress: { progress: 0.5 },
    statusMessage: { statusMessage: "other" },
    errorMessage: { errorMessage: "other" },
    failureLogs: { failureLogs: "other" },
  };

  test("signs every field of a reported installation state", () => {
    const report = { nodeId: base.nodeId, states: [{ installationId: "3f1a2b3c-0000-4000-8000-000000000010", lifecycleState: "ready" as const }] };

    for (const field of Object.keys(installationStatePayloadSchema.shape)) {
      const mutation = STATE_MUTATIONS[field];
      expect(mutation, `${field} is in the schema but not covered here`).toBeDefined();
      const tampered = { ...report, states: [{ ...report.states[0]!, ...mutation }] };
      expect(canonicalStateReport(tampered)).not.toBe(canonicalStateReport(report));
    }
  });

  test("signs the node the report claims to come from", () => {
    const states = [{ installationId: "3f1a2b3c-0000-4000-8000-000000000010", lifecycleState: "ready" as const }];
    expect(canonicalStateReport({ nodeId: "3f1a2b3c-0000-4000-8000-000000000002", states }))
      .not.toBe(canonicalStateReport({ nodeId: base.nodeId, states }));
  });

  test("treats an absent optional field the same as an explicit null", () => {
    expect(canonicalRegistration({ ...base, machineName: undefined })).toBe(canonicalRegistration(base));
  });
});
