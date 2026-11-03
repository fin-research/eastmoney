export interface MessengerBinding { fetch(input: Request): Promise<Response> }
export type { Delivery, DeliveryList, DeliveryDetail } from '../messenger/types';
export async function messengerRequest(binding: MessengerBinding, path: string, body?: unknown) {
  if (!binding) throw new Error('消息中台未配置');
  return binding.fetch(new Request('https://messenger.internal' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
export async function messengerJson<T>(binding: MessengerBinding, path: string, body?: unknown): Promise<T> {
  const response = await messengerRequest(binding, path, body);
  if (!response.ok) throw new Error(`消息中台请求失败（${response.status}）`);
  return response.json() as Promise<T>;
}
