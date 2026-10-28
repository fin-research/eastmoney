import { redirect } from "@sveltejs/kit";

export function GET(): never {
  redirect(308, "/bond");
}
