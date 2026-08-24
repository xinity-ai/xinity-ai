import winston from 'winston';
import { config } from '../config/index.js';
import { type TenantContext } from '../auth/rbac.js';

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

export interface AuditEvent {
  action: string;
  tenantId: string;
  userId: string;
  repoId?: string;
  details?: Record<string, any>;
  status: 'SUCCESS' | 'DENIED' | 'FAILED';
}

export function logAuditEvent(event: AuditEvent): void {
  if (!config.enableAuditLogging) return;

  logger.info({
    type: 'AUDIT_LOG',
    timestamp: new Date().toISOString(),
    ...event
  });
}

export function logSecurityViolation(context: Partial<TenantContext>, reason: string, details?: Record<string, any>): void {
  logger.warn({
    type: 'SECURITY_VIOLATION',
    timestamp: new Date().toISOString(),
    tenantId: context.tenantId || 'UNKNOWN',
    userId: context.userId || 'UNKNOWN',
    reason,
    details
  });
}

export { logger };
