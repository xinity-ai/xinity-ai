import { sql, aiNodeT, modelInstallationT } from "common-db";

/** sql part to be used in a where clause when querying ai_node, to only get ones that are live */
export const nodeIsLive = sql`${aiNodeT.available} AND ${aiNodeT.deletedAt} IS NULL`;

/** sql part to be used as the join condition between model_installation and ai_node, to only join live ones */
export const installationOnLiveNode = sql`${aiNodeT.id} = ${modelInstallationT.nodeId} AND ${nodeIsLive}`;
