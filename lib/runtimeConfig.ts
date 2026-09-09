export function getAdminCredentials() {
  return {
    user: process.env.ADMIN_USER || process.env.ADMIN_BASIC_USER,
    password: process.env.ADMIN_PASSWORD || process.env.ADMIN_BASIC_PASSWORD,
  };
}

export function getMetaCapiToken() {
  return process.env.META_CAPI_ACCESS_TOKEN || process.env.META_CAPI_TOKEN;
}

// Keep the server-side Purchase delivery boundary in one place. A truthy
// placeholder Pixel id or access token is not a configured CAPI destination:
// attempting delivery with either would make a paid Stripe webhook retry as
// though Meta were temporarily unavailable, and an admin retry could report a
// no-op as a completed recovery.
export function hasRequiredMetaCapiPurchaseConfig() {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim();
  const configuredToken = getMetaCapiToken();
  const accessToken = configuredToken?.trim();
  return Boolean(
    pixelId && /^\d{6,25}$/.test(pixelId) &&
    accessToken && accessToken.length >= 20 && !/[\r\n]/.test(configuredToken || ''),
  );
}
