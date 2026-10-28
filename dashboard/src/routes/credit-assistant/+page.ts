import { redirect } from "@sveltejs/kit";
export function load() { redirect(307, "/?ai=open"); }

export const ssr = false;
