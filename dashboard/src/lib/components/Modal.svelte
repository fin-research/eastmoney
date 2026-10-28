<script lang="ts">
  import { getContext, type Snippet } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { cn } from '$lib/utils';

  let { children, open = $bindable(false), class: className, oncancel, onclose, ...rest }: {
    children: Snippet;
    open?: boolean;
    class?: string;
    'aria-labelledby'?: string;
    'aria-label'?: string;
    oncancel?: (event: Event) => void;
    onclose?: (event: Event) => void;
  } = $props();
  const scope = getContext<() => string>('ui-scope');
  let returnFocus: HTMLElement | SVGElement | null = null;

  let closeNotified = false;
  function notifyClose() {
    if (closeNotified) return;
    closeNotified = true;
    onclose?.(new Event('close'));
  }

  export function showModal() {
    closeNotified = false;
    returnFocus = (document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement) ? document.activeElement : null;
    open = true;
  }
  export function isOpen() { return open; }
  export function close() {
    if (!open) return;
    open = false;
    notifyClose();
  }
  function cancel(event: Event) {
    const request = new Event('cancel', { cancelable: true });
    oncancel?.(request);
    if (request.defaultPrevented) event.preventDefault();
  }
</script>

<Dialog.Root bind:open={open} onOpenChange={(open) => { if (open) closeNotified = false; else notifyClose(); }}>
  <Dialog.Content
    {...rest}
    class={cn('business-dialog sm:max-w-[min(64rem,calc(100vw-3rem))] w-fit min-w-[min(28rem,calc(100vw-3rem))]', scope?.(), className)}
    showCloseButton={false}
    onOpenAutoFocus={() => { closeNotified = false; returnFocus = (document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement) ? document.activeElement : null; }}
    onEscapeKeydown={cancel}
    onInteractOutside={cancel}
    onCloseAutoFocus={(event) => { if (returnFocus?.isConnected) { event.preventDefault(); returnFocus.focus(); } }}
  >
    {@render children()}
  </Dialog.Content>
</Dialog.Root>
