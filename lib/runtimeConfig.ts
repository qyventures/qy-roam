export function getAdminCredentials() {
  return {
    user: process.env.ADMIN_USER || process.env.ADMIN_BASIC_USER,
    password: process.env.ADMIN_PASSWORD || process.env.ADMIN_BASIC_PASSWORD,
  };
}

export function getMetaCapiToken() {
  return process.env.META_CAPI_ACCESS_TOKEN || process.env.META_CAPI_TOKEN;
}
