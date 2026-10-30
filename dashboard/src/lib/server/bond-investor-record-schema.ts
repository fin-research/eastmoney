import { z } from 'zod';
export const investorAmount=z.number().positive().finite().refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7&&Number.isSafeInteger(Math.round(v*100)));
export const createBondInvestorSchema=z.object({bondName:z.string().min(1).max(160),investorName:z.string().min(1).max(160),channel:z.string().max(160).nullable(),account:z.string().max(500).nullable(),amount:investorAmount}).strict();
export const updateBondInvestorSchema=z.object({id:z.string().regex(/^\d+$/),oldBondName:z.string(),oldInvestorName:z.string().nullable(),oldChannel:z.string().nullable(),oldAccount:z.string().nullable(),oldAmount:investorAmount,investorName:z.string().min(1).max(160),channel:z.string().max(160).nullable(),account:z.string().max(500).nullable(),amount:investorAmount}).strict();
