export type DebtStatus = 'active' | 'matured' | 'planned' | 'closed';
export type ProjectStatus = 'planning' | 'in_progress' | 'at_risk' | 'completed' | 'cancelled';
export type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'completed';

export interface DashboardFilters {
	debtType?: string;
	personId?: string;
}

export interface ProjectFilters extends DashboardFilters {
	status?: ProjectStatus;
}

export interface DebtImportResult {
	sourceFile: string;
	unchanged: boolean;
	inserted: number;
	updated: number;
	deleted: number;
	insertedRows: number;
	newHistoryDateCount: number;
	rowsWritten: number;
}
