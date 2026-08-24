import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MultiTenantGraphStorage, type GraphNode, type GraphEdge } from '../db/graphStorage.js';
import { RepositoryIndexer } from '../indexing/indexer.js';
import { verifyJwtToken, assertPermission, type TenantContext } from '../auth/rbac.js';
import { logAuditEvent, logSecurityViolation } from '../audit/logger.js';

function formatToolOutput(data: any, format: 'compact' | 'json' = 'compact', toolName: string): string {
  if (format === 'json') {
    return JSON.stringify(data);
  }

  switch (toolName) {
    case 'enterprise_query_symbols': {
      const nodes = data as GraphNode[];
      if (!nodes || nodes.length === 0) return 'No matching symbols found.';
      return nodes
        .map(n => `[${n.type}] ${n.name} @ ${n.filePath}${n.language ? ` (${n.language})` : ''}`)
        .join('\n');
    }

    case 'enterprise_get_neighbors': {
      if (!data || data.message) return data?.message || 'Node not found';
      const { node, edges } = data as { node: GraphNode; edges: GraphEdge[] };
      const header = `Node: [${node.type}] ${node.name} (${node.filePath})`;
      if (!edges || edges.length === 0) return `${header}\nConnections: None`;
      const edgeLines = edges.map(e => `  ${e.sourceNodeId} -[${e.relationType}]-> ${e.targetNodeId}`);
      return `${header}\nConnections:\n${edgeLines.join('\n')}`;
    }

    case 'enterprise_tenant_overview': {
      const { tenantId, repoId, symbolsByType, relationsByType } = data;
      return (
        `Tenant: ${tenantId} | Repo: ${repoId}\n` +
        `Symbols: ${JSON.stringify(symbolsByType || {})}\n` +
        `Relations: ${JSON.stringify(relationsByType || {})}`
      );
    }

    default:
      return JSON.stringify(data);
  }
}

export function createEnterpriseMcpServer(storage: MultiTenantGraphStorage) {
  const indexer = new RepositoryIndexer(storage);
  const server = new Server(
    {
      name: 'enterprise-code-intelligence',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'enterprise_query_symbols',
          description: 'Search symbols (classes, functions, files) across tenant code graph with RBAC authorization & token minimization.',
          inputSchema: {
            type: 'object',
            properties: {
              authToken: { type: 'string', description: 'JWT authentication token containing tenant claims and roles.' },
              query: { type: 'string', description: 'Search term or symbol name.' },
              repoId: { type: 'string', description: 'Optional target repository ID.' },
              limit: { type: 'number', description: 'Maximum results to return (default: 50).' },
              format: { type: 'string', enum: ['compact', 'json'], description: 'Output format (default: compact for 70% token savings).' }
            },
            required: ['authToken', 'query']
          }
        },
        {
          name: 'enterprise_get_neighbors',
          description: 'Retrieve direct connections and edges for a code graph node with RBAC verification.',
          inputSchema: {
            type: 'object',
            properties: {
              authToken: { type: 'string', description: 'JWT authentication token.' },
              nodeId: { type: 'string', description: 'Node ID to query.' },
              repoId: { type: 'string', description: 'Optional target repository ID.' },
              format: { type: 'string', enum: ['compact', 'json'], description: 'Output format (default: compact).' }
            },
            required: ['authToken', 'nodeId']
          }
        },
        {
          name: 'enterprise_tenant_overview',
          description: 'Get high-level code intelligence metrics for a tenant.',
          inputSchema: {
            type: 'object',
            properties: {
              authToken: { type: 'string', description: 'JWT authentication token.' },
              repoId: { type: 'string', description: 'Optional target repository ID.' },
              format: { type: 'string', enum: ['compact', 'json'], description: 'Output format (default: compact).' }
            },
            required: ['authToken']
          }
        },
        {
          name: 'enterprise_index_repository',
          description: 'Trigger asynchronous indexing for a repository path (Requires repo:index permission).',
          inputSchema: {
            type: 'object',
            properties: {
              authToken: { type: 'string', description: 'JWT authentication token.' },
              repoId: { type: 'string', description: 'Repository ID.' },
              rootDir: { type: 'string', description: 'Absolute root directory of repository.' },
              branch: { type: 'string', description: 'Git branch name (default: main).' }
            },
            required: ['authToken', 'repoId', 'rootDir']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const token = args?.authToken as string;
    const format = ((args?.format as string) || 'compact') as 'compact' | 'json';

    if (!token) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: Missing required authentication token (authToken).' }]
      };
    }

    let tenantContext: TenantContext;
    try {
      tenantContext = verifyJwtToken(token);
    } catch (err: any) {
      logSecurityViolation({}, 'INVALID_JWT', { error: err.message });
      return {
        isError: true,
        content: [{ type: 'text', text: `Authentication Failed: ${err.message}` }]
      };
    }

    try {
      switch (name) {
        case 'enterprise_query_symbols': {
          const repoId = args?.repoId as string | undefined;
          assertPermission(tenantContext, 'graph:read', repoId);

          const query = args?.query as string;
          const limit = (args?.limit as number) || 50;

          const results = storage.querySymbols(tenantContext.tenantId, query, repoId, limit);
          logAuditEvent({
            action: 'query_symbols',
            tenantId: tenantContext.tenantId,
            userId: tenantContext.userId,
            repoId,
            details: { query, count: results.length },
            status: 'SUCCESS'
          });

          return {
            content: [{ type: 'text', text: formatToolOutput(results, format, name) }]
          };
        }

        case 'enterprise_get_neighbors': {
          const repoId = args?.repoId as string | undefined;
          assertPermission(tenantContext, 'graph:read', repoId);

          const nodeId = args?.nodeId as string;
          const result = storage.findNeighbors(tenantContext.tenantId, nodeId, repoId);

          logAuditEvent({
            action: 'get_neighbors',
            tenantId: tenantContext.tenantId,
            userId: tenantContext.userId,
            repoId,
            details: { nodeId, found: !!result },
            status: 'SUCCESS'
          });

          return {
            content: [{ type: 'text', text: formatToolOutput(result || { message: 'Node not found' }, format, name) }]
          };
        }

        case 'enterprise_tenant_overview': {
          const repoId = args?.repoId as string | undefined;
          assertPermission(tenantContext, 'graph:read', repoId);

          const overview = storage.getTenantOverview(tenantContext.tenantId, repoId);
          logAuditEvent({
            action: 'tenant_overview',
            tenantId: tenantContext.tenantId,
            userId: tenantContext.userId,
            repoId,
            status: 'SUCCESS'
          });

          return {
            content: [{ type: 'text', text: formatToolOutput(overview, format, name) }]
          };
        }

        case 'enterprise_index_repository': {
          const repoId = args?.repoId as string;
          const rootDir = args?.rootDir as string;
          const branch = (args?.branch as string) || 'main';

          assertPermission(tenantContext, 'repo:index', repoId);

          const result = await indexer.indexRepository({
            tenantId: tenantContext.tenantId,
            repoId,
            rootDir,
            branch
          });

          logAuditEvent({
            action: 'index_repository',
            tenantId: tenantContext.tenantId,
            userId: tenantContext.userId,
            repoId,
            details: result,
            status: 'SUCCESS'
          });

          return {
            content: [{ type: 'text', text: JSON.stringify({ message: 'Indexing complete', metrics: result }) }]
          };
        }

        default:
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }]
          };
      }
    } catch (err: any) {
      logAuditEvent({
        action: name,
        tenantId: tenantContext.tenantId,
        userId: tenantContext.userId,
        status: 'DENIED',
        details: { error: err.message }
      });

      return {
        isError: true,
        content: [{ type: 'text', text: `Authorization / Execution Error: ${err.message}` }]
      };
    }
  });

  return server;
}
