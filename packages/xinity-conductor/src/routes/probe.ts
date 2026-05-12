import { withRunnerAuth } from "../auth/middleware";

export const handleProbe = withRunnerAuth((_req, identity) => {
  return Response.json({
    tokenId: identity.tokenId,
    organizationId: identity.organizationId,
    name: identity.name,
  });
});
