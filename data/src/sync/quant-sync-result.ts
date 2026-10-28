export type QuantSyncFailure = {
  source: string;
  error: string;
  kind?: 'execution' | 'data_gap';
};
