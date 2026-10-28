import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("统一 AI 面板自动进入详情、轮替思考摘要并保留结果与任务列表", async () => {
  await promisify(execFile)(process.execPath, ["--conditions=browser", "tests/helpers/ai-panel-lifecycle.mjs"], {
    cwd: new URL("../", import.meta.url), timeout: 20_000, maxBuffer: 20_000,
  });
});

test("实际授信助手组件切换标签后清理聊天 DOM、页头操作和迟到响应", async () => {
  await promisify(execFile)(process.execPath, ["--conditions=browser", "tests/helpers/credit-chat-lifecycle.mjs"], {
    cwd: new URL("../", import.meta.url), timeout: 20_000, maxBuffer: 20_000,
  });
});

test("授信工作台四个路由视图复用报表状态和公共布局，旧政策链接保留锚点", async () => {
  await promisify(execFile)(process.execPath, ["--conditions=browser", "tests/helpers/credit-workbench-navigation.mjs"], {
    cwd: new URL("../", import.meta.url), timeout: 30_000, maxBuffer: 20_000,
  });
});

test("市场热点和政策跟踪嵌入工作台后不重复主标题、main 或遗留页面", async () => {
  await promisify(execFile)(process.execPath, ["--conditions=browser", "tests/helpers/research-pages-navigation.mjs"], {
    cwd: new URL("../", import.meta.url), timeout: 30_000, maxBuffer: 20_000,
  });
});
