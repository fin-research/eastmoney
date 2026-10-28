import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { compile, compileModule } from "svelte/compiler";
import { existsSync, readFileSync } from "node:fs";
import { Window } from "happy-dom";

// Vite accepts extensionless TypeScript imports; reproduce that resolution in
// the DOM-test subprocess without changing production modules for Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("$lib/")) specifier = new URL("../../src/lib/" + specifier.slice(5), import.meta.url).href;
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") || specifier.startsWith("file:")) {
        if (specifier.endsWith(".svelte")) return nextResolve(specifier + ".js", context);
        if (specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context);
        if (!/\.[a-z]+$/.test(specifier)) return nextResolve(specifier + ".ts", context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('.svelte')) return { format: 'module', source: compile(readFileSync(new URL(url), 'utf8'), { filename: new URL(url).pathname, generate: 'client', dev: false }).js.code, shortCircuit: true };
    if (/\.svelte\.[jt]s$/.test(url)) return { format: 'module', source: compileModule(
      stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'strip' }),
      { filename: new URL(url).pathname, generate: 'client', dev: false },
    ).js.code, shortCircuit: true };
    return nextLoad(url, context);
  }
});

export function installDom() {
  const window = new Window({ url: "http://localhost/credit-workbench/assistant" });
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLDialogElement", "Document", "DocumentFragment", "NodeFilter", "PointerEvent", "FocusEvent", "HTMLMediaElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLDetailsElement", "SVGElement", "Text", "Comment", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? window : typeof window[key] === "function" && /^[a-z]/.test(key) ? window[key].bind(window) : window[key] });
  }
  return window;
}

const root = new URL("../../", import.meta.url);
const cache = new Map();

export async function componentUrl(file, sourceOverride) {
  const url = file instanceof URL ? file : new URL(file, root);
  if (!sourceOverride && cache.has(url.href)) return cache.get(url.href);
  const source = sourceOverride ?? await readFile(url, "utf8");
  let { js } = compile(source, { filename: url.pathname, generate: "client", dev: false });
  let code = js.code;
  // Compile only the imported Lucide icons instead of loading its uncompiled
  // Svelte barrel. DOM tests exercise the real component tree, including icons.
  for (const match of [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@lucide\/svelte["'];?/g)]) {
    const packageRoot = new URL('.', import.meta.resolve('@lucide/svelte'));
    const index = await readFile(new URL('icons/index.js', packageRoot), 'utf8');
    const statements = [];
    for (const name of match[1].split(',').map(name => name.trim())) {
      const [exported, local = exported] = name.split(/\s+as\s+/);
      const target = index.match(new RegExp(`export \\{ default as ${exported} \\} from './([^']+)';`))?.[1];
      if (!target) throw new Error(`DOM test icon is not registered: ${exported}`);
      statements.push(`import ${local} from '${await componentUrl(new URL('icons/' + target, packageRoot))}';`);
    }
    code = code.replace(match[0], statements.join('\n'));
  }
  const imports = [...code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)];
  for (const match of imports) {
    const specifier = match[1];
    if (specifier.endsWith(".css")) { code = code.replace(match[0], ""); continue; }
    let resolved;
    if (specifier.startsWith('file:')) resolved = new URL(specifier);
    else if (specifier === "$app/navigation") {
      resolved = new URL(".svelte-kit/dom-tests/app-navigation.mjs", root);
      await mkdir(new URL(".", resolved), { recursive: true });
      await writeFile(resolved, "export function afterNavigate(callback) { globalThis.domAfterNavigations?.push(callback); } export async function goto(url, options) { globalThis.domNavigations?.push({url, options}); } export function replaceState(url) { window.history.replaceState(window.history.state, '', url); } export async function invalidate() {}");
    } else if (specifier.startsWith("$lib/")) resolved = new URL("src/lib/" + specifier.slice(5), root);
    else if (specifier.startsWith(".")) resolved = new URL(specifier, url);
    else resolved = new URL(import.meta.resolve(specifier));
    if (resolved.pathname.endsWith(".svelte") && !existsSync(resolved) && existsSync(new URL(resolved.href + ".ts"))) {
      resolved = new URL(resolved.href + ".ts");
    } else if (!/\.[a-z]+$/.test(resolved.pathname)) resolved = new URL(resolved.href + ".ts");
    const target = resolved.pathname.endsWith(".svelte") ? await componentUrl(resolved) : resolved.href;
    code = code.replace(match[0], match[0].replace(specifier, target));
  }
  const output = new URL(`.svelte-kit/dom-tests/${createHash("sha256").update(code).digest("hex")}.mjs`, root);
  await mkdir(new URL(".", output), { recursive: true });
  await writeFile(output, code);
  const result = output.href;
  if (!sourceOverride) cache.set(url.href, result);
  return result;
}

export async function loadComponent(file, sourceOverride) {
  return (await import(await componentUrl(file, sourceOverride))).default;
}
