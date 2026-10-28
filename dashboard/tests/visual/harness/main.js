import { mount } from 'svelte';
import Harness from './Harness.svelte';
const target = document.getElementById('app');
if (!target) throw new Error('Missing visual test mount');
// Wait for shipping CSS before mounting components or measuring graph geometry.
const response = await fetch('/production-styles.json');
if (!response.ok) throw new Error('Build production styles before running visual tests');
/** @type {Record<string, string[]>} */
const routes = await response.json();
const path = window.location.pathname;
const route = Object.keys(routes).sort((a, b) => b.length - a.length)
  .find(route => path === route || (route !== '/' && path.startsWith(`${route}/`)));
const styles = route ? routes[route] : undefined;
if (!styles?.length) throw new Error(`No production CSS registered for ${path}`);
await Promise.all(styles.map(href => new Promise((resolve, reject) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/${href}`;
  link.dataset.production = 'true';
  link.onload = resolve;
  link.onerror = () => reject(new Error(`Failed to load production CSS: ${href}`));
  document.head.append(link);
})));
mount(Harness, { target });
