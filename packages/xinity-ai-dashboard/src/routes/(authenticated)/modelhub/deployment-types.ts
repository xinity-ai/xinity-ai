import type { Component, ComponentProps } from "svelte";
import type { DeploymentOutput } from "$lib/orpc/dtos/model.dto";
import type { DeploymentDefinition } from "./+page.server";
import DeploymentModal from "./DeploymentModal.svelte";
import LegacyDeploymentDetails from "./LegacyDeploymentDetails.svelte";

type DeploymentTypeView = {
  label: (deployment: DeploymentDefinition) => string;
  replicas: (deployment: DeploymentDefinition) => number;
  /** The catalog model the deployment serves, which decides how it can be tested. */
  modelSpecifier: (deployment: DeploymentDefinition) => string;
  details: Component<{ deployment: DeploymentDefinition }>;
  editModal: Component<ComponentProps<typeof DeploymentModal>>;
};

export const DEPLOYMENT_TYPE_VIEWS: Record<DeploymentDefinition["type"], DeploymentTypeView> = {
  legacy: {
    label: ({ legacy }) => {
      if (!legacy.earlySpecifier) {
        return "Static";
      }
      if (legacy.canaryProgressWithFeedback) {
        return "Canary (smart-auto)";
      }
      if (legacy.canaryProgressUntil) {
        return "Canary (time-based)";
      }
      if (legacy.canaryProgressFrom) {
        return "Canary (manual)";
      }
      return "Canary";
    },
    replicas: ({ legacy }) => legacy.replicas,
    modelSpecifier: ({ legacy }) => legacy.specifier,
    details: LegacyDeploymentDetails,
    editModal: DeploymentModal,
  },
};

export const hasView = (deployment: DeploymentOutput): deployment is DeploymentDefinition => deployment.type in DEPLOYMENT_TYPE_VIEWS;
