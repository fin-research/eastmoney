<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { globalMessages, type GlobalMessage } from '$lib/global-messages';

  let visible: GlobalMessage[] = [];
  onMount(() => {
    const published = new Map<string, GlobalMessage>();
    const unsubscribe = globalMessages.subscribe((messages) => {
      visible = messages;
      const ids = new Set(messages.map(message => message.id));
      for (const id of published.keys()) if (!ids.has(id)) { toast.dismiss(id); published.delete(id); }
      for (const message of messages) {
        if (published.get(message.id) === message) continue;
        toast[message.kind](message.title, {
          id: message.id, description: message.message, duration: Infinity,
          onDismiss: () => globalMessages.dismiss(message.id),
        });
        published.set(message.id, message);
      }
    });
    return () => { unsubscribe(); for (const id of published.keys()) toast.dismiss(id); globalMessages.clear(); };
  });
  function pause(reason: 'pointer' | 'focus') { for (const item of visible) globalMessages.pause(item.id, reason); }
  function resume(reason: 'pointer' | 'focus') { for (const item of visible) globalMessages.resume(item.id, reason); }
</script>

<div class="global-message-region" role="region" aria-label="系统消息交互"
  onpointerenter={() => pause('pointer')} onpointerleave={() => resume('pointer')}
  onfocusin={() => pause('focus')}
  onfocusout={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume('focus'); }}
>
  <Toaster position="top-center" visibleToasts={4} closeButton richColors
    containerAriaLabel="系统消息" closeButtonAriaLabel="关闭通知" />
</div>

<style>
  .global-message-region :global([data-sonner-toaster]) { --width: min(560px, calc(100vw - 32px)) !important; }
  .global-message-region :global([data-sonner-toast][data-styled='true']) { padding: 16px 64px 16px 18px; min-height: 76px; font-family: var(--font); font-size: 1rem; border-radius: 1rem; }
  .global-message-region :global([data-sonner-toast][data-styled='true'] [data-close-button]) { left: auto; right: 8px; top: 8px; transform: none; width: 44px; height: 44px; border: 0; border-radius: 50%; background: transparent; }
  .global-message-region :global([data-sonner-toast] [data-close-button] svg) { width: 18px; height: 18px; }
  .global-message-region :global([data-description]) { overflow-wrap: anywhere; }
</style>
