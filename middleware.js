/** TradePilot AI security middleware blueprint (server-side). */
export function securityPolicy({ allowedOrigins = [] } = {}) {
  return { allowedOrigins, csrf: true, rateLimit: true, validation: true, secureHeaders: true };
}
export function requireAuth(request) {
  if (!request?.user?.id) throw new Error('AUTH_REQUIRED');
  return request.user;
}
export function requireEntitlement(request, entitlement) {
  requireAuth(request);
  if (!request.user.entitlements?.includes(entitlement)) throw new Error('ENTITLEMENT_REQUIRED');
  return true;
}
export function verifyWebhookSignature({ valid, eventId, seenIds = new Set() }) {
  if (!valid) throw new Error('INVALID_WEBHOOK_SIGNATURE');
  if (seenIds.has(eventId)) return { duplicate: true };
  seenIds.add(eventId);
  return { duplicate: false };
}
