import { sql } from "drizzle-orm";
import { aiNodeT, modelDeploymentT, modelInstallationStateT, modelInstallationT } from "../schema/models";

/**
 * The node is live: available and not removed.
 * Needs `ai_node` in the query. Use in a WHERE, or in the ON of a join onto `ai_node`.
 */
export const nodeIsLive = sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`;

/**
 * The installation runs on this node, and the node is live.
 * Needs `model_installation` and `ai_node`. Use as the ON when joining `ai_node` onto `model_installation`.
 */
export const installationOnLiveNode = sql`${aiNodeT.id} = ${modelInstallationT.nodeId} AND ${nodeIsLive}`;

/**
 * The state row belongs to the installation.
 * Needs `model_installation` and `model_installation_state`. Use as the ON when joining
 * `model_installation_state` onto `model_installation`.
 */
export const stateOfInstallation = sql`${modelInstallationStateT.id} = ${modelInstallationT.id}`;

/**
 * The installation serves the deployment.
 * Needs `model_deployment` and `model_installation`. Use as the ON when joining one onto the other.
 */
export const deploymentMatchesInstallation = sql`${modelDeploymentT.id} = ${modelInstallationT.deploymentId}`;

/**
 * The installation is of the given canonical specifier.
 * Needs `model_installation`. Use in a WHERE.
 */
export function installationMatchesLookup(value: string) {
  return sql`${modelInstallationT.specifier} = ${value}`;
}

/**
 * The installation takes requests: it runs alone, or is rank 0 of a group whose every member is
 * ready on a live node.
 * Needs `model_installation`. The other members are looked up in a subquery of their own. Use in a WHERE.
 */
export const installationTakesRequests = sql`(
  ${modelInstallationT.group} IS NULL
  OR (
    (${modelInstallationT.group}->>'rank')::int = 0
    AND (
      SELECT count(*) FROM model_installation member
      JOIN model_installation_state member_state ON member_state.id = member.id AND member_state.lifecycle_state = 'ready'
      JOIN ai_node member_node ON member_node.id = member.node_id AND member_node.available AND member_node.deleted_at IS NULL
      WHERE member."group"->>'id' = ${modelInstallationT.group}->>'id' AND member.deleted_at IS NULL
    ) = (${modelInstallationT.group}->>'size')::int
  )
)`;
