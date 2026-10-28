import { z } from 'zod';
import type { SiteIdentity } from '../identity';
import type { DirectoryPerson } from './auth0-directory';

export const isNotificationAdmin = (user: SiteIdentity | null | undefined) =>
  !!user?.authorization?.roles.some(role => role.name === 'admin');
const schema = z.object({
  requestId: z.string().uuid(), mode: z.enum(['single','multiple']),
  userIds: z.array(z.string().regex(/^auth0\|[^\s]{1,249}$/)).min(1).max(50),
  channels: z.array(z.enum(['email','telegram','webpush'])).min(1).max(3),
  title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(1000),
}).refine(value => value.mode !== 'single' || value.userIds.length === 1);
export function parseTestMessage(form: FormData, people: DirectoryPerson[]) {
  const parsed = schema.safeParse({requestId:form.get('requestId'),mode:form.get('mode'),
    userIds:[...new Set(form.getAll('userIds'))],channels:[...new Set(form.getAll('channels'))],
    title:form.get('title'),text:form.get('text')});
  if (!parsed.success) throw new Error('请选择用户和渠道，并填写标题与消息（最多 50 人、1000 字）');
  const active = new Set(people.filter(person => person.active).map(person => person.id));
  if (parsed.data.userIds.some(id => !active.has(id))) throw new Error('所选用户已停用或不存在，请刷新后重试');
  const {mode: _mode, ...value} = parsed.data;
  return value;
}
