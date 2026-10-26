import type { Component, ComponentProps } from "svelte";
import type { DeploymentType } from "common-env/deployment-types";
import type { DeploymentDefinition } from "./+page.server";
import DeploymentModal from "./DeploymentModal.svelte";
import LegacyDeploymentDetails from "./LegacyDeploymentDetails.svelte";

type DeploymentTypeView = {
  label: (deployment: DeploymentDefinition) => string;
  details: Component<{ deployment: DeploymentDefinition }>;
  editModal: Component<ComponentProps<typeof DeploymentModal>>;
};

export const DEPLOYMENT_TYPE_VIEWS: Record<DeploymentType, DeploymentTypeView> = {
  legacy: {
    label: (deployment) => {
      if (!deployment.earlySpecifier) {
        return "Static";
      }
      if (deployment.canaryProgressWithFeedback) {
        return "Canary (smart-auto)";
      }
      if (deployment.canaryProgressUntil) {
        return "Canary (time-based)";
      }
      if (deployment.canaryProgressFrom) {
        return "Canary (manual)";
      }
      return "Canary";
    },
    details: LegacyDeploymentDetails,
    editModal: DeploymentModal,
  },
};
