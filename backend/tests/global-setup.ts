import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { connectPg } from '../src/db';
import { migrate } from '../src/db/migrate';
import { withDatabase } from './db-url';

// One Postgres container per test run. Migrations are applied once to a
// template database; every test service gets a fresh copy of it.

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const adminUrl = container.getConnectionUri();
  const admin = connectPg(adminUrl, { max: 1 });
  await admin.execScript('CREATE DATABASE audit_template');
  await admin.close();
  const template = connectPg(withDatabase(adminUrl, 'audit_template'), { max: 1 });
  await migrate(template);
  await template.close();
  project.provide('pgAdminUrl', adminUrl);
}

export async function teardown() {
  await container?.stop();
}
