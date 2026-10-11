import { afterAll } from 'vitest';
import { closeTestDbs } from './db';

afterAll(closeTestDbs);
