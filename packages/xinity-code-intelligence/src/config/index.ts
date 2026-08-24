import path from 'path';

export interface AppConfig {
  enabled: boolean;
  port: number;
  environment: string;
  jwtSecret: string;
  databasePath: string;
  logLevel: string;
  enableAuditLogging: boolean;
  maxTenantConnections: number;
}

export const config: AppConfig = {
  enabled: process.env.CODE_INTELLIGENCE_ENABLED === 'true',
  port: parseInt(process.env.PORT || '3030', 10),
  environment: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'xinity-code-intelligence-secret-key-change-me',
  databasePath: process.env.DATABASE_PATH || './xinity_code_graph.db',
  logLevel: process.env.LOG_LEVEL || 'info',
  enableAuditLogging: process.env.ENABLE_AUDIT_LOGGING !== 'false',
  maxTenantConnections: parseInt(process.env.MAX_TENANT_CONNECTIONS || '50', 10)
};
