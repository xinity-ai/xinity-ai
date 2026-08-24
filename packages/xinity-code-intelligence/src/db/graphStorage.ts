import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../audit/logger.js';

export interface GraphNode {
  id: string;
  tenantId: string;
  repoId: string;
  name: string;
  type: 'file' | 'class' | 'function' | 'interface' | 'symbol' | 'directory';
  filePath: string;
  language?: string;
  metadata?: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  tenantId: string;
  repoId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: 'calls' | 'imports' | 'inherits' | 'defines' | 'contains';
  metadata?: Record<string, any>;
}

interface StorageSchema {
  tenants: Record<string, { tenantId: string; name: string; createdAt: string }>;
  repositories: Record<string, { tenantId: string; repoId: string; name: string; branch: string; lastIndexedAt: string }>;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
}

export class MultiTenantGraphStorage {
  private filePath: string;
  private data: StorageSchema;

  constructor(dbPath?: string) {
    const rawPath = dbPath || config.databasePath;
    this.filePath = rawPath.endsWith('.json') ? rawPath : rawPath.replace(/\.db$/, '.json');
    
    const dbDir = path.dirname(this.filePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.data = this.loadData();
    logger.info(`Multi-Tenant Graph Storage initialized at ${this.filePath}`);
  }

  private loadData(): StorageSchema {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(raw);
      } catch (err: any) {
        logger.warn(`Failed reading storage file ${this.filePath}, creating new graph: ${err.message}`);
      }
    }
    return {
      tenants: {},
      repositories: {},
      nodes: {},
      edges: {}
    };
  }

  private persistData(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err: any) {
      logger.error(`Failed persisting graph storage to file: ${err.message}`);
    }
  }

  public registerTenant(tenantId: string, name: string): void {
    this.data.tenants[tenantId] = {
      tenantId,
      name,
      createdAt: new Date().toISOString()
    };
    this.persistData();
  }

  public registerRepository(tenantId: string, repoId: string, name: string, branch = 'main'): void {
    this.registerTenant(tenantId, tenantId);
    const key = `${tenantId}:${repoId}`;
    this.data.repositories[key] = {
      tenantId,
      repoId,
      name,
      branch,
      lastIndexedAt: new Date().toISOString()
    };
    this.persistData();
  }

  public upsertNode(node: GraphNode): void {
    this.data.nodes[node.id] = node;
    this.persistData();
  }

  public upsertEdge(edge: GraphEdge): void {
    this.data.edges[edge.id] = edge;
    this.persistData();
  }

  public querySymbols(tenantId: string, query: string, repoId?: string, limit = 50): GraphNode[] {
    const q = query.toLowerCase();
    const results: GraphNode[] = [];

    for (const node of Object.values(this.data.nodes)) {
      if (node.tenantId !== tenantId) continue;
      if (repoId && node.repoId !== repoId) continue;

      if (node.name.toLowerCase().includes(q) || node.filePath.toLowerCase().includes(q)) {
        results.push(node);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  public findNeighbors(tenantId: string, nodeId: string, repoId?: string): { node: GraphNode; edges: GraphEdge[] } | null {
    const targetNode = this.data.nodes[nodeId];
    if (!targetNode || targetNode.tenantId !== tenantId) return null;
    if (repoId && targetNode.repoId !== repoId) return null;

    const matchingEdges: GraphEdge[] = [];
    for (const edge of Object.values(this.data.edges)) {
      if (edge.tenantId !== tenantId) continue;
      if (repoId && edge.repoId !== repoId) continue;

      if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) {
        matchingEdges.push(edge);
      }
    }

    return {
      node: targetNode,
      edges: matchingEdges
    };
  }

  public getTenantOverview(tenantId: string, repoId?: string) {
    const symbolsByType: Record<string, number> = {};
    const relationsByType: Record<string, number> = {};

    for (const node of Object.values(this.data.nodes)) {
      if (node.tenantId !== tenantId) continue;
      if (repoId && node.repoId !== repoId) continue;

      symbolsByType[node.type] = (symbolsByType[node.type] || 0) + 1;
    }

    for (const edge of Object.values(this.data.edges)) {
      if (edge.tenantId !== tenantId) continue;
      if (repoId && edge.repoId !== repoId) continue;

      relationsByType[edge.relationType] = (relationsByType[edge.relationType] || 0) + 1;
    }

    return {
      tenantId,
      repoId: repoId || 'ALL',
      symbolsByType,
      relationsByType
    };
  }

  public close(): void {
    this.persistData();
  }
}
