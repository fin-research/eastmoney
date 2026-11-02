export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\r\n]/.test(decoded)) return '/';
    const normalized = new URL(decoded, 'https://eastmoney.hasbai.xyz');
    if (/^\/(auth|cdn-cgi)(\/|$)/.test(normalized.pathname)) return '/';
  } catch { return '/'; }
  const target = new URL(value, 'https://eastmoney.hasbai.xyz');
  if (target.origin !== 'https://eastmoney.hasbai.xyz') return '/';
  return target.pathname + target.search + target.hash;
}

export function loginUrl(returnTo: string): string {
  return `/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}
