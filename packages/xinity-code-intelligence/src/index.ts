import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MultiTenantGraphStorage } from './db/graphStorage.js';
import { createEnterpriseMcpServer } from './mcp/server.js';
import { generateJwtToken, type TenantContext } from './auth/rbac.js';
import { config } from './config/index.js';
import { logger } from './audit/logger.js';

export { MultiTenantGraphStorage } from './db/graphStorage.js';
export { RepositoryIndexer } from './indexing/indexer.js';
export { createEnterpriseMcpServer } from './mcp/server.js';
export { generateJwtToken, verifyJwtToken, hasPermission, assertPermission } from './auth/rbac.js';

export async function startMcpService() {
  if (!config.enabled) {
    logger.info('Xinity Code Intelligence Package is currently disabled by default. Admin must set CODE_INTELLIGENCE_ENABLED=true to activate.');
    return { storage: null, mcpServer: null };
  }

  logger.info('Initializing Xinity Code Intelligence Package...');

  const storage = new MultiTenantGraphStorage(config.databasePath);
  const mcpServer = createEnterpriseMcpServer(storage);

  storage.registerTenant('tenant-default', 'Default Tenant');
  storage.registerRepository('tenant-default', 'repo-main', 'Main Repository', 'main');

  if (process.argv.includes('--stdio')) {
    logger.info('Starting Xinity Code Intelligence MCP Server in Stdio Mode...');
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  }

  return { storage, mcpServer };
}

if (import.meta.main || process.argv[1]?.endsWith('index.ts')) {
  startMcpService().catch((err) => {
    logger.error(`Fatal Startup Error: ${err.message}`, { stack: err.stack });
  });
}
