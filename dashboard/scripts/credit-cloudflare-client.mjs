import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Local operational scripts only. Production accesses R2 and AI Search through bindings.
export async function cloudflareClient() {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const authPath = process.env.WRANGLER_AUTH_FILE ?? path.join(homedir(), process.platform === "darwin"
    ? "Library/Preferences/.wrangler/config/default.toml" : ".config/.wrangler/config/default.toml");
  const readToken = async () => process.env.CLOUDFLARE_API_TOKEN ?? (await readFile(authPath, "utf8")).match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.vars.CLOUDFLARE_ACCOUNT_ID}`;
  return async (resource, init = {}) => {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      let retryDelay = Math.min(60_000, 1000 * 2 ** attempt);
      try {
        const token = await readToken();
        if (!token) throw new Error("请先运行 wrangler login，或提供 CLOUDFLARE_API_TOKEN");
        const response = await fetch(base + resource, { ...init, headers: { authorization: `Bearer ${token}`,
          "user-agent": "wrangler/4.125.0", ...init.headers }, signal: AbortSignal.timeout(300000) });
        if (response.ok) return response;
        lastStatus = response.status;
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryDelay = Math.min(300_000, retryAfter * 1000);
        await response.body?.cancel();
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) { if (attempt === 7) throw error; }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
    throw new Error(`Cloudflare ${resource.split("/").slice(0, 4).join("/")} HTTP ${lastStatus}`);
  };
}
