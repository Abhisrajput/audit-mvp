import { inject } from 'vitest';
import { connectPg, type Db } from '../src/db';
import { withDatabase } from './db-url';

const open: Db[] = [];
let counter = 0;

/** A fresh, migrated database cloned from the template, with its connection URL. */
export async function testDbWithUrl(): Promise<{ db: Db; url: string }> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${process.pid}_${Date.now()}_${counter++}`;
  const admin = connectPg(adminUrl, { max: 1 });
  try {
    await admin.execScript(`CREATE DATABASE ${name} TEMPLATE audit_template`);
  } finally {
    await admin.close();
  }
  const url = withDatabase(adminUrl, name);
  const db = connectPg(url);
  open.push(db);
  return { db, url };
}

/** A fresh, migrated database cloned from the template. */
export async function testDb(): Promise<Db> {
  return (await testDbWithUrl()).db;
}

/** A database with no migrations applied. */
export async function emptyDb(): Promise<Db> {
  const adminUrl = inject('pgAdminUrl');
  const name = `e_${process.pid}_${Date.now()}_${counter++}`;
  const admin = connectPg(adminUrl, { max: 1 });
  try {
    await admin.execScript(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }
  const db = connectPg(withDatabase(adminUrl, name));
  open.push(db);
  return db;
}

export async function closeTestDbs() {
  await Promise.all(open.splice(0).map((d) => d.close()));
}
