// This marker is not a secret or an authentication credential. Its purpose is
// to distinguish an intentional API client from a cross-site HTML form when a
// browser or privacy proxy strips Origin, Referer, and Fetch Metadata headers.
// HTML forms cannot set custom request headers; non-browser operators that
// deliberately call an admin mutation can add this marker alongside Basic
// Auth.
export const ADMIN_MUTATION_HEADER = 'x-qyroam-admin-request';
export const ADMIN_MUTATION_HEADER_VALUE = '1';

export function adminMutationHeaders(json = false): Record<string, string> {
  return {
    [ADMIN_MUTATION_HEADER]: ADMIN_MUTATION_HEADER_VALUE,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}
