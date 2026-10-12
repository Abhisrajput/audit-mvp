import { escapeIdentifier, escapeLiteral } from 'pg';
import { sql } from 'kysely';
import type { Db } from './index';

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates (or re-passwords) a login role that is a member of audit_api: the identity the API connects as in production.
 * Refuses names that are not plain identifiers, short passwords, and any existing role that is not already an unprivileged
 * login whose only membership is audit_api (so it can never re-password the owner or any other role by mistake).
 */
export async function createApiLogin(db: Db, name: string, password: string): Promise<'created' | 'updated'> {
  if (!NAME.test(name) || name === 'audit_api') throw new Error('The login name must be a plain lowercase identifier (letters, digits, _) other than audit_api');
  if (password.length < 16) throw new Error('API_DB_PASSWORD must be at least 16 characters');
  const existing = (await sql<{ ok: boolean }>`
    SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication)
           AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
           AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid AND g.rolname <> 'audit_api')
           AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid AND g.rolname = 'audit_api') AS ok
    FROM pg_roles r WHERE r.rolname = ${name}`.execute(db.kysely)).rows[0];
  if (existing && !existing.ok) {
    throw new Error(`Role ${name} is not an API login made by this tool (it is privileged, owns database objects, or has memberships other than audit_api); choose a new name for the API login`);
  }
  await assertMayManage(db, name, Boolean(existing));
  // Role names and passwords can't be bound as parameters in DDL; both are escaped by node-postgres.
  const role = escapeIdentifier(name);
  const secret = escapeLiteral(password);
  if (existing) await db.execScript(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${secret};`);
  else await db.execScript(`CREATE ROLE ${role} LOGIN PASSWORD ${secret} IN ROLE audit_api;`);
  return existing ? 'updated' : 'created';
}

/**
 * Checks, before any DDL, that the current login can run the CREATE or ALTER ROLE. A refused statement is written to the
 * server log in full (log_min_error_statement), password included, so it must never be sent just to fail.
 * Postgres 16 also wants ADMIN OPTION: on audit_api to grant it, and on the login to change its password.
 */
async function assertMayManage(db: Db, name: string, existing: boolean): Promise<void> {
  const me = (await sql<{ me: string; superuser: boolean; createrole: boolean; pg16: boolean; api: boolean }>`
    SELECT current_user AS me, r.rolsuper AS superuser, r.rolcreaterole AS createrole,
           current_setting('server_version_num')::int >= 160000 AS pg16,
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_api') AS api
    FROM pg_roles r WHERE r.rolname = current_user`.execute(db.kysely)).rows[0];
  const unchanged = 'nothing was changed';
  if (!me.api) throw new Error(`Role audit_api does not exist: run migrate first (migration 009 creates it); ${unchanged}`);
  if (me.superuser) return;
  if (!me.createrole) {
    throw new Error(`The database login ${me.me} cannot create or change roles: it needs CREATEROLE (run create-api-login as an administrator with CREATEROLE); ${unchanged}`);
  }
  if (!me.pg16) return;
  const target = existing ? name : 'audit_api';
  const admin = (await sql<{ ok: boolean }>`SELECT pg_has_role(current_user, ${target}, 'MEMBER WITH ADMIN OPTION') AS ok`.execute(db.kysely)).rows[0].ok;
  if (admin) return;
  if (existing) {
    throw new Error(`The database login ${me.me} has CREATEROLE but not ADMIN OPTION on ${name}, which Postgres 16 needs to change its password (the login that created it has it); ${unchanged}`);
  }
  throw new Error(`The database login ${me.me} has CREATEROLE but not ADMIN OPTION on audit_api, which Postgres 16 needs to grant it (GRANT audit_api TO ${me.me} WITH ADMIN OPTION); ${unchanged}`);
}
