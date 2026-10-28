<script lang="ts">
  import { resolveInstitutionLogo } from "$lib/sell-side-institutions";

  interface Props {
    institution: string;
  }

  let { institution }: Props = $props();

  let logo = $derived(resolveInstitutionLogo(institution));
</script>

{#if logo}
  <span class="institution-logo" aria-hidden="true">
    <img
      src={logo.src}
      alt=""
      width="24"
      height="24"
      loading="lazy"
      decoding="async"
    />
  </span>
{/if}

<style>
  .institution-logo {
    display: inline-flex;
    box-sizing: border-box;
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 4px;
    border: 1px solid color-mix(in srgb, var(--brand) 12%, var(--line));
    border-radius: 7px;
    background: #fff;
  }

  .institution-logo img {
    display: block;
    width: 24px;
    height: 24px;
    object-fit: contain;
  }
</style>
