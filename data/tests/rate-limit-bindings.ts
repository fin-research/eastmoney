export function allowRateLimits() {
  const allow = { limit: async () => ({ success: true }) } as RateLimit;
  return {
    CHOICE_FAST_LIMIT: allow,
    CHOICE_OTHER_LIMIT: allow,
    DM_LIMIT: allow,
    EASTMONEY_LIMIT: allow,
    CHINAMONEY_LIMIT: allow,
    CAMEL_LIMIT: allow,
  };
}
