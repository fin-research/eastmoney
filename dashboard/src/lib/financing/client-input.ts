import { z } from 'zod';
export const clientTypes=['银行','理财子','券商','基金','营业部客户','其它'] as const;
const name=z.string().trim().min(1).max(500);
export const clientInputSchema=z.object({name,fullname:z.string().trim().max(500).nullable(),type:z.enum(clientTypes),subtype:z.string().trim().max(100).nullable(),aliases:z.array(name).max(200),version:z.string().max(100).optional()}).strict();
export type ClientRecord=z.infer<typeof clientInputSchema>&{id:string;version:string};
