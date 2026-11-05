/** Injected by the build; / for a domain root, /repository/ for a Pages project. */
declare const __PUBLIC_BASE_PATH__: string;

export const PUBLIC_BASE_PATH = __PUBLIC_BASE_PATH__;

/**
 * Resolve a project-owned path without rewriting frozen source JSON.
 * Existing base-prefixed paths are idempotent. External URLs, hash-only links,
 * query strings, and already-relative links keep their original meaning.
 * Never decode the path: %2F, query parameters and hashes are not file separators.
 */
export function publicUrl(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  if (PUBLIC_BASE_PATH === '/' || value.startsWith(PUBLIC_BASE_PATH)) return value;
  return PUBLIC_BASE_PATH + value.slice(1);
}
