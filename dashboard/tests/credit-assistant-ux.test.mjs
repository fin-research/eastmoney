import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("ordinary chat sends without institution selection and ignores stale history responses", async () => {
  await promisify(execFile)(process.execPath, ["--conditions=browser", "tests/helpers/credit-chat-basic.mjs"], {
    cwd: new URL("../", import.meta.url), timeout: 30_000, maxBuffer: 20_000,
  });
});
