/** Cutover remains explicit; finalized ledgers can receive later migrations. */
export function creditMigrationPlan(names, appliedNames, finalize = false) {
  const finalized = appliedNames.has('0019_finalize_credit_entries.sql');
  return names.filter(name => finalize || name < '0019_' || finalized && name > '0019_finalize_credit_entries.sql');
}
