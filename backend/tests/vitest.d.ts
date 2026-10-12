import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}
