export class DebtImportError extends Error {
  constructor(message: string) { super(message); this.name = 'DebtImportError'; }
}
