// Resolve the application's extensionless TypeScript imports for node --test.
import { existsSync } from 'node:fs';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(url)) return next(url.href, context);
  }
  return next(specifier, context);
}
