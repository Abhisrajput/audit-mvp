import { escapeIdentifier, escapeLiteral } from 'pg';
import { sql } from 'kysely';
import type { Db } from './index';

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates (or re-passwords) a login role that is a member of audit_api: the identity the API connects as in production.
 * Refuses names that are not plain identifiers, short passwords, and any existing role that owns database objects or
 * has administrative rights (so it can never demote or re-password the owner by mistake).
 */
export async function createApiLogin(db: Db, name: string, password: string): Promise<'created' | 'updated'> {
  if (!NAME.test(name) || name === 'audit_api') throw new Error('The login name must be a plain lowercase identifier (letters, digits, _) other than audit_api');
  if (password.length < 16) throw new Error('API_DB_PASSWORD must be at least 16 characters');
  const existing = (await sql<{ admin: boolean; owns: boolean }>`
    SELECT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls) AS admin,
           EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid) AS owns
    FROM pg_roles r WHERE r.rolname = ${name}`.execute(db.kysely)).rows[0];
  if (existing && (existing.admin || existing.owns)) {
    throw new Error(`Role ${name} owns database objects or has administrative rights; choose a new name for the API login`);
  }
  // Role names and passwords can't be bound as parameters in DDL; both are escaped by node-postgres.
  const role = escapeIdentifier(name);
  const secret = escapeLiteral(password);
  if (existing) await db.execScript(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${secret}; GRANT audit_api TO ${role};`);
  else await db.execScript(`CREATE ROLE ${role} LOGIN PASSWORD ${secret} IN ROLE audit_api;`);
  return existing ? 'updated' : 'created';
}
