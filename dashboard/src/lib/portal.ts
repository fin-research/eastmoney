export function portal(
  node: HTMLElement,
  targetSelector: string | null | undefined,
): {
  update: (selector: string | null | undefined) => void;
  destroy: () => void;
} {
  const anchor = document.createComment("portal-anchor");
  node.before(anchor);

  function restore(): void {
    anchor.parentNode?.insertBefore(node, anchor.nextSibling);
  }

  function move(selector: string | null | undefined): void {
    if (!selector) {
      restore();
      return;
    }

    const target = document.querySelector<HTMLElement>(selector);
    if (target) target.append(node);
    else restore();
  }

  move(targetSelector);
  return {
    update: move,
    destroy(): void {
      node.remove();
      anchor.remove();
    },
  };
}
