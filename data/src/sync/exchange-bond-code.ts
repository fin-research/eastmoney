/** Eight-digit exchange code: market (SH=1, SZ=2), suffix (none=0, X=1, X2=2), six digits. */
export function encodeExchangeBondCode(value: string): number {
  const code = value.trim().toUpperCase();
  const match = /^(\d{6})(X([1-9])?)?\.(SH|SZ)$/.exec(code);
  if (!match) throw new Error(`Unsupported exchange bond code: ${code}`);
  const suffix = match[2] ? Number(match[3] ?? '1') : 0;
  return (match[4] === 'SH' ? 10_000_000 : 20_000_000) + suffix * 1_000_000 + Number(match[1]);
}

export function decodeExchangeBondCode(value: number): string {
  if (!Number.isInteger(value) || value < 10_000_000 || value >= 30_000_000) {
    throw new Error(`Invalid encoded exchange bond code: ${value}`);
  }
  const market = value < 20_000_000 ? 'SH' : 'SZ';
  const suffix = Math.floor(value % 10_000_000 / 1_000_000);
  return `${String(value % 1_000_000).padStart(6, '0')}${suffix === 0 ? '' : suffix === 1 ? 'X' : `X${suffix}`}.${market}`;
}
