export type ErrorCode =
  | 'VALIDATION'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_INTEGRITY'
  | 'RETENTION_EXPIRED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VERSION_CONFLICT'
  | 'FINDING_BLOCKED'
  | 'FINDING_LOCKED'
  | 'SOD_VIOLATION'
  | 'RUN_NOT_ACTIVE'
  | 'CSRF_FAILED'
  | 'PENDING_ACCESS'
  | 'REAUTH_REQUIRED'
  | 'REAUTH_STALE'
  | 'REAUTH_USER_MISMATCH'
  | 'INTENT_EXPIRED'
  | 'CONTENT_CHANGED'
  | 'CANCELLED'
  | 'RECORD_IMMUTABLE'
  | 'RATE_LIMITED'
  | 'RUN_ACTIVE'
  | 'AGENT_DISABLED'
  | 'GATE_STALE'
  | 'AGENT_FORBIDDEN'
  | 'INTERNAL';

const DEFAULT_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

/** An error the API returns to the client with a stable, machine-readable code. */
export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(public status: number, message: string, code?: ErrorCode) {
    super(message);
    this.code = code ?? DEFAULT_CODES[status] ?? 'INTERNAL';
  }
}
