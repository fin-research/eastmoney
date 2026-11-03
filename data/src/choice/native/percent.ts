import { ChoiceWireError, decodeChoiceSheets, encodeChoiceFrame, choiceCodesCommand } from './wire.ts';
export type PercentFunction = 'CSD' | 'CSS' | 'CSES';
export type PercentMetadata = Record<PercentFunction, Map<string, Set<number>>>;
export const percentMetadataRequest = (): { serverType: 3; frame: Uint8Array } => ({
  serverType: 3, frame: encodeChoiceFrame('$-rpt\r\n$name=EM_API_PERCENTFLAG\r\n$ifWriteWithNetStream=0'),
});
/** cpercentflag::handleresult. STYPE is a delimited enclosed string; SDK strips
 * its first/last characters when length>2, then applies decimal strtol to tokens.
 * No endpoint or flags are guessed for indicators absent from recovered metadata.
 */
export function decodePercentMetadata(body: Uint8Array): PercentMetadata {
  const result: PercentMetadata = { CSD: new Map(), CSS: new Map(), CSES: new Map() };
  for (const sheet of decodeChoiceSheets(body)) {
    const indexes = ['ENGNAME_API', 'EOIFUNCTION', 'STYPE'].map(name => sheet.columns.findIndex(column => column.toUpperCase() === name));
    if (indexes.some(index => index < 0 || sheet.types[index] !== 12)) throw new ChoiceWireError('Invalid Choice percentage metadata schema');
    for (const row of sheet.rows) {
      const values = indexes.map(index => row[index]);
      if (values.some(value => typeof value !== 'string')) throw new ChoiceWireError('Invalid Choice percentage metadata row');
      const [indicator, functionName, rawTypes] = values as [string, string, string];
      const name = functionName.toUpperCase();
      if (name !== 'EM_CSD' && name !== 'EM_CSS' && name !== 'EM_CSES') continue;
      const key = indicator.toUpperCase().replaceAll(' ', '');
      if (!key || rawTypes.length <= 2) continue;
      const types = result[name.slice(3) as PercentFunction].get(key) ?? new Set<number>();
      for (const part of rawTypes.slice(1, -1).split(',')) {
        const match = /^\s*([+-]?\d+)/.exec(part);
        const number = match ? Number(match[1]) : 0;
        if (!Number.isSafeInteger(number) || number < -0x80000000 || number > 0x7fffffff) throw new ChoiceWireError('Invalid Choice percentage security type');
        types.add(number);
      }
      result[name.slice(3) as PercentFunction].set(key, types);
    }
  }
  return result;
}
export function percentFlags(metadata: PercentMetadata, functionName: PercentFunction, indicators: readonly string[], securityType: number): boolean[] {
  return indicators.map(indicator => metadata[functionName].get(indicator.toUpperCase())?.has(securityType) ?? false);
}
/** cgetcodeinfo::checkparams, ctor server3. Its prehook returns0; no token or quota hook. */
export function codeTypeRequest(codes: string[]): { serverType: 3; frame: Uint8Array } {
  const normalized = [...new Set(codes.map(code => code.trim().toUpperCase()))];
  if (!normalized.length || normalized.some(code => !/^[A-Z0-9][A-Z0-9._-]{0,18}$/.test(code))) throw new ChoiceWireError('Invalid Choice code-type lookup codes');
  return { serverType: 3, frame: encodeChoiceFrame('$-rpt\r\n$name=Code_Type\r\n' + choiceCodesCommand(normalized) + '$type=0') };
}
/** cgetcodeinfo::handleresult uses column positions, not header names:
 * exactly3 wire12 strings per row = EM code, SecurityID, STYPE.
 * Synthetic fixture and request were replayed against the SDK with connect() blocked.
 */
export function decodeCodeTypes(body: Uint8Array): Map<string, number> {
  const result = new Map<string, number>();
  for (const sheet of decodeChoiceSheets(body)) {
    if (sheet.columns.length !== 3 || sheet.types.some(type => type !== 12)) throw new ChoiceWireError('Invalid Choice code-type metadata schema');
    for (const row of sheet.rows) {
      const [rawCode, securityId, rawType] = row;
      if (typeof rawCode !== 'string' || typeof securityId !== 'string' || typeof rawType !== 'string' || !/^[+-]?\d+$/.test(securityId) || !/^[+-]?\d+$/.test(rawType)) throw new ChoiceWireError('Invalid Choice code-type metadata row');
      const code = rawCode.toUpperCase(), type = Number(rawType), id = BigInt(securityId);
      if (!code || code.length > 19 || !Number.isInteger(type) || type < -0x80000000 || type > 0x7fffffff || id < -0x8000000000000000n || id > 0x7fffffffffffffffn) throw new ChoiceWireError('Invalid Choice code-type metadata values');
      if (result.has(code) && result.get(code) !== type) throw new ChoiceWireError('Conflicting Choice code types');
      result.set(code, type);
    }
  }
  return result;
}
