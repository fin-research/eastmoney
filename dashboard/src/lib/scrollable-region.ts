/** Keep keyboard scrolling available only while the region actually overflows.
 * The caller provides role="region" and an accessible name (MDN CSS overflow).
 */
export function scrollableRegion(node: HTMLElement) {
  const originalTabIndex = node.getAttribute('tabindex');
  const update = () => {
    node.tabIndex = node.scrollWidth > node.clientWidth + 1 ? 0 : -1;
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.target !== node || node.tabIndex < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = Math.max(80, node.clientWidth / 2);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      node.scrollLeft += event.key === 'ArrowLeft' ? -step : step;
    } else if (event.key === 'Home' || event.key === 'End') {
      node.scrollLeft = event.key === 'Home' ? 0 : node.scrollWidth - node.clientWidth;
    } else return;
    event.preventDefault();
  };
  node.addEventListener('keydown', onKeydown);
  const observer = new ResizeObserver(update);
  observer.observe(node);
  if (node.firstElementChild) observer.observe(node.firstElementChild);
  update();
  return {
    destroy() {
      observer.disconnect();
      node.removeEventListener('keydown', onKeydown);
      if (originalTabIndex === null) node.removeAttribute('tabindex');
      else node.setAttribute('tabindex', originalTabIndex);
    },
  };
}
