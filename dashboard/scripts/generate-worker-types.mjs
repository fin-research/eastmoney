import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const wrangler = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const command = fileURLToPath(
  new URL(`../node_modules/.bin/${wrangler}`, import.meta.url),
);

await new Promise((resolve, reject) => {
  const child = spawn(command, ["types", "--include-runtime", "false"], {
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`wrangler types exited with code ${code}`));
  });
});

const declarationUrl = new URL("../worker-configuration.d.ts", import.meta.url);
const generated = await readFile(declarationUrl, "utf8");
const withoutBuildImport = generated.replace(
  /\n\t\tmainModule: typeof import\("[^"]+"\);/,
  "",
).replace(
  /\n\tinterface GlobalProps \{\n\t\tmainModule: typeof import\("[^"]+"\);\n\t\}\n/,
  "\n",
);
await writeFile(declarationUrl, withoutBuildImport
  .replace(/Workflow<Parameters<import\("\.\/worker\/entry"\)\.MarketBriefingWorkflow\['run'\]>\[0\]\['payload'\]>/,
    'Workflow<import("./src/lib/market-briefing-types").MarketBriefingParams>')
  .replaceAll('import("./worker/entry").CreditAgent', 'import("agents").Agent<Cloudflare.Env>'));
