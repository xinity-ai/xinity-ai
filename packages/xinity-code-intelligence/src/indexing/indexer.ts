import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import ts from 'typescript';
import { MultiTenantGraphStorage, type GraphNode, type GraphEdge } from '../db/graphStorage.js';
import { logger } from '../audit/logger.js';

export interface IndexerOptions {
  tenantId: string;
  repoId: string;
  rootDir: string;
  branch?: string;
  ignorePatterns?: string[];
  concurrencyLimit?: number;
}

interface ParsedFileAST {
  nodes: GraphNode[];
  edges: GraphEdge[];
  importedPaths: Array<{ importedModule: string; symbols: string[] }>;
}

export class RepositoryIndexer {
  private storage: MultiTenantGraphStorage;

  constructor(storage: MultiTenantGraphStorage) {
    this.storage = storage;
  }

  private generateId(tenantId: string, repoId: string, itemPath: string): string {
    return crypto
      .createHash('sha256')
      .update(`${tenantId}:${repoId}:${itemPath}`)
      .digest('hex')
      .substring(0, 16);
  }

  private sanitizeContent(content: string): string {
    return content
      .replace(/(sk-[a-zA-Z0-9]{32,})/g, '[REDACTED_API_KEY]')
      .replace(/(ghp_[a-zA-Z0-9]{36})/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/(bearer\s+[a-zA-Z0-9\._\-]+)/gi, 'Bearer [REDACTED_TOKEN]');
  }

  private parseTypeScriptAST(
    content: string,
    relativePath: string,
    tenantId: string,
    repoId: string,
    fileNodeId: string
  ): ParsedFileAST {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const importedPaths: Array<{ importedModule: string; symbols: string[] }> = [];

    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith('.tsx') || relativePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const getLineAndChar = (pos: number) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
      return line + 1;
    };

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classId = this.generateId(tenantId, repoId, `${relativePath}::class::${className}`);
        const lineStart = getLineAndChar(node.getStart(sourceFile));
        const lineEnd = getLineAndChar(node.getEnd());

        nodes.push({
          id: classId,
          tenantId,
          repoId,
          name: className,
          type: 'class',
          filePath: relativePath,
          language: 'typescript',
          metadata: { lineStart, lineEnd, signature: `class ${className}` }
        });

        edges.push({
          id: `${fileNodeId}->${classId}:defines`,
          tenantId,
          repoId,
          sourceNodeId: fileNodeId,
          targetNodeId: classId,
          relationType: 'defines'
        });

        node.members.forEach(member => {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;
            const methodId = this.generateId(tenantId, repoId, `${relativePath}::${className}.${methodName}`);
            const mStart = getLineAndChar(member.getStart(sourceFile));
            const mEnd = getLineAndChar(member.getEnd());

            nodes.push({
              id: methodId,
              tenantId,
              repoId,
              name: `${className}.${methodName}`,
              type: 'function',
              filePath: relativePath,
              language: 'typescript',
              metadata: { lineStart: mStart, lineEnd: mEnd, signature: `${methodName}()` }
            });

            edges.push({
              id: `${classId}->${methodId}:contains`,
              tenantId,
              repoId,
              sourceNodeId: classId,
              targetNodeId: methodId,
              relationType: 'contains'
            });
          }
        });
      } else if (ts.isInterfaceDeclaration(node) && node.name) {
        const interfaceName = node.name.text;
        const interfaceId = this.generateId(tenantId, repoId, `${relativePath}::interface::${interfaceName}`);
        const lineStart = getLineAndChar(node.getStart(sourceFile));
        const lineEnd = getLineAndChar(node.getEnd());

        nodes.push({
          id: interfaceId,
          tenantId,
          repoId,
          name: interfaceName,
          type: 'interface',
          filePath: relativePath,
          language: 'typescript',
          metadata: { lineStart, lineEnd, signature: `interface ${interfaceName}` }
        });

        edges.push({
          id: `${fileNodeId}->${interfaceId}:defines`,
          tenantId,
          repoId,
          sourceNodeId: fileNodeId,
          targetNodeId: interfaceId,
          relationType: 'defines'
        });
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const funcName = node.name.text;
        const funcId = this.generateId(tenantId, repoId, `${relativePath}::function::${funcName}`);
        const lineStart = getLineAndChar(node.getStart(sourceFile));
        const lineEnd = getLineAndChar(node.getEnd());

        nodes.push({
          id: funcId,
          tenantId,
          repoId,
          name: funcName,
          type: 'function',
          filePath: relativePath,
          language: 'typescript',
          metadata: { lineStart, lineEnd, signature: `function ${funcName}()` }
        });

        edges.push({
          id: `${fileNodeId}->${funcId}:defines`,
          tenantId,
          repoId,
          sourceNodeId: fileNodeId,
          targetNodeId: funcId,
          relationType: 'defines'
        });
      } else if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        const importedSymbols: string[] = [];

        if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          node.importClause.namedBindings.elements.forEach(el => {
            importedSymbols.push(el.name.text);
          });
        } else if (node.importClause?.name) {
          importedSymbols.push(node.importClause.name.text);
        }

        importedPaths.push({
          importedModule: moduleSpecifier,
          symbols: importedSymbols
        });
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return { nodes, edges, importedPaths };
  }

  public async indexRepository(options: IndexerOptions): Promise<{ totalFiles: number; totalNodes: number; totalEdges: number }> {
    const { tenantId, repoId, rootDir, branch = 'main', ignorePatterns = ['node_modules', '.git', 'dist', 'build', 'out'], concurrencyLimit = 20 } = options;

    logger.info(`Starting async AST background indexing for tenant '${tenantId}', repo '${repoId}' at path '${rootDir}'`);
    this.storage.registerRepository(tenantId, repoId, repoId, branch);

    let totalFiles = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const fileList: string[] = [];

    const scanDirectory = async (dirPath: string) => {
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch (err: any) {
        logger.warn(`Failed reading directory ${dirPath}: ${err.message}`);
        return;
      }

      for (const entry of entries) {
        if (ignorePatterns.includes(entry.name) || entry.name.startsWith('.')) continue;

        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          const dirNodeId = this.generateId(tenantId, repoId, relativePath);

          this.storage.upsertNode({
            id: dirNodeId,
            tenantId,
            repoId,
            name: entry.name,
            type: 'directory',
            filePath: relativePath
          });
          totalNodes++;

          await scanDirectory(fullPath);
        } else if (entry.isFile()) {
          fileList.push(fullPath);
        }
      }
    };

    if (!fsSync.existsSync(rootDir)) {
      logger.error(`Repository directory path does not exist: ${rootDir}`);
      return { totalFiles: 0, totalNodes: 0, totalEdges: 0 };
    }

    await scanDirectory(rootDir);

    const fileNodeMap = new Map<string, string>();
    const pendingImports: Array<{ sourceFileId: string; sourceRelativePath: string; importedModule: string; symbols: string[] }> = [];

    for (let i = 0; i < fileList.length; i += concurrencyLimit) {
      const batch = fileList.slice(i, i + concurrencyLimit);

      await Promise.all(
        batch.map(async fullPath => {
          const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          const fileNodeId = this.generateId(tenantId, repoId, relativePath);
          fileNodeMap.set(relativePath, fileNodeId);

          const ext = path.extname(fullPath).toLowerCase();
          totalFiles++;

          const fileNode: GraphNode = {
            id: fileNodeId,
            tenantId,
            repoId,
            name: path.basename(fullPath),
            type: 'file',
            filePath: relativePath,
            language: ext.replace('.', '')
          };
          this.storage.upsertNode(fileNode);
          totalNodes++;

          const parentDir = path.dirname(relativePath).replace(/\\/g, '/');
          if (parentDir && parentDir !== '.') {
            const parentId = this.generateId(tenantId, repoId, parentDir);
            this.storage.upsertEdge({
              id: `${parentId}->${fileNodeId}:contains`,
              tenantId,
              repoId,
              sourceNodeId: parentId,
              targetNodeId: fileNodeId,
              relationType: 'contains'
            });
            totalEdges++;
          }

          if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
            try {
              const rawContent = await fs.readFile(fullPath, 'utf-8');
              const sanitized = this.sanitizeContent(rawContent);

              const astResult = this.parseTypeScriptAST(sanitized, relativePath, tenantId, repoId, fileNodeId);

              astResult.nodes.forEach(n => {
                this.storage.upsertNode(n);
                totalNodes++;
              });

              astResult.edges.forEach(e => {
                this.storage.upsertEdge(e);
                totalEdges++;
              });

              astResult.importedPaths.forEach(imp => {
                pendingImports.push({
                  sourceFileId: fileNodeId,
                  sourceRelativePath: relativePath,
                  importedModule: imp.importedModule,
                  symbols: imp.symbols
                });
              });
            } catch (err: any) {
              logger.warn(`AST Parse error for ${relativePath}: ${err.message}`);
            }
          }
        })
      );

      await new Promise(resolve => setImmediate(resolve));
    }

    for (const imp of pendingImports) {
      if (imp.importedModule.startsWith('.')) {
        const sourceDir = path.dirname(imp.sourceRelativePath);
        const resolvedBase = path.normalize(path.join(sourceDir, imp.importedModule)).replace(/\\/g, '/');

        const possiblePaths = [
          resolvedBase,
          `${resolvedBase}.ts`,
          `${resolvedBase}.tsx`,
          `${resolvedBase}.js`,
          `${resolvedBase}/index.ts`,
          `${resolvedBase}/index.js`
        ];

        let targetFileId: string | undefined;
        for (const p of possiblePaths) {
          if (fileNodeMap.has(p)) {
            targetFileId = fileNodeMap.get(p);
            break;
          }
        }

        if (targetFileId) {
          const importEdgeId = `${imp.sourceFileId}->${targetFileId}:imports`;
          this.storage.upsertEdge({
            id: importEdgeId,
            tenantId,
            repoId,
            sourceNodeId: imp.sourceFileId,
            targetNodeId: targetFileId,
            relationType: 'imports',
            metadata: { importedSymbols: imp.symbols }
          });
          totalEdges++;
        }
      }
    }

    logger.info(`Async AST Indexing complete for repo '${repoId}'. Total files: ${totalFiles}, nodes: ${totalNodes}, edges: ${totalEdges}`);
    return { totalFiles, totalNodes, totalEdges };
  }
}
