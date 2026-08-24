import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export type Role = 'admin' | 'developer' | 'auditor' | 'readonly';

export type Permission = 
  | 'graph:read' 
  | 'graph:write' 
  | 'graph:admin' 
  | 'audit:read' 
  | 'repo:index';

export interface TenantContext {
  tenantId: string;
  userId: string;
  roles: Role[];
  accessibleRepos: string[]; // List of repo IDs or '*' for all
}

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['graph:read', 'graph:write', 'graph:admin', 'audit:read', 'repo:index'],
  developer: ['graph:read', 'graph:write', 'repo:index'],
  auditor: ['graph:read', 'audit:read'],
  readonly: ['graph:read']
};

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function verifyJwtToken(token: string): TenantContext {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as any;
    if (!decoded.tenantId || !decoded.userId || !decoded.roles) {
      throw new AuthenticationError('Invalid JWT token payload: missing required tenant claims.');
    }
    return {
      tenantId: decoded.tenantId,
      userId: decoded.userId,
      roles: decoded.roles,
      accessibleRepos: decoded.accessibleRepos || ['*']
    };
  } catch (err: any) {
    throw new AuthenticationError(`Token verification failed: ${err.message}`);
  }
}

export function generateJwtToken(context: TenantContext, expiresIn = '8h'): string {
  const options: jwt.SignOptions = { expiresIn: expiresIn as any };
  return jwt.sign(
    {
      tenantId: context.tenantId,
      userId: context.userId,
      roles: context.roles,
      accessibleRepos: context.accessibleRepos
    },
    config.jwtSecret,
    options
  );
}

export function hasPermission(context: TenantContext, permission: Permission, repoId?: string): boolean {
  const userPermissions = new Set<Permission>();
  for (const role of context.roles) {
    const permissions = ROLE_PERMISSIONS[role] || [];
    permissions.forEach(p => userPermissions.add(p));
  }

  if (!userPermissions.has(permission)) {
    return false;
  }

  if (repoId && !context.accessibleRepos.includes('*') && !context.accessibleRepos.includes(repoId)) {
    return false;
  }

  return true;
}

export function assertPermission(context: TenantContext, permission: Permission, repoId?: string): void {
  if (!hasPermission(context, permission, repoId)) {
    throw new AuthorizationError(
      `Permission denied: User '${context.userId}' in tenant '${context.tenantId}' lacks permission '${permission}'` +
      (repoId ? ` for repository '${repoId}'` : '')
    );
  }
}
