<script lang="ts">
import { getContext } from 'svelte';
import { CLIENT_SESSION_CONTEXT, type ClientSession } from '$lib/client-session';
import PermissionExplorer from '$lib/permissions/PermissionExplorer.svelte';
import { roleLabel } from '$lib/permissions/permission-tree';
import ModuleCard from '../../../components/ModuleCard.svelte';
import PanelHeading from '$lib/trading-research/PanelHeading.svelte';
import { Button } from '$lib/components/ui/button/index.js';
const session=getContext<ClientSession>(CLIENT_SESSION_CONTEXT);
</script>
<ModuleCard><PanelHeading id="permissions-1" title="我的权限" />
<ul class="permission-roles">{#each $session?._roles ?? [] as role}<li>{roleLabel(role)}</li>{/each}</ul>
<PermissionExplorer permissions={$session?.permissions ?? []} grantedOnly />
<Button variant="outline" href="/auth/login?returnTo=%2Fmanagement%2Fpermissions">刷新权限</Button>
</ModuleCard>
