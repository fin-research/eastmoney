import {assistantSession} from './audit-fixtures.mjs';

export const assistantRunning={...assistantSession,turns:[],running:true,
 pendingQuestion:'请核实公司最新流动性指标，并说明所依据的资料。',
 progress:'正在检索资料'};
export const assistantFailed={...assistantRunning,running:false,error:'资料检索暂不可用，请稍后重试。'};
export const assistantRecovered={...assistantSession,turns:[{...assistantSession.turns[0],question:assistantRunning.pendingQuestion}]};
