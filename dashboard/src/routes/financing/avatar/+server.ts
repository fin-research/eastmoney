import { error } from '@sveltejs/kit';
export function GET() { error(410, '请使用统一个人信息页'); }
