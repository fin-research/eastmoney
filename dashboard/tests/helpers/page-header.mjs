import assert from 'node:assert/strict';
import { installDom, loadComponent } from './svelte-dom.mjs';
const window = installDom();
const { mount, unmount, flushSync } = await import('svelte');
const { notificationTab, managementPeopleTab, managementPeopleTabs } = await import('../../src/lib/workbench/navigation.ts');
assert.equal(notificationTab('test'), 'test');
assert.equal(notificationTab('invalid'), 'delivery');
assert.equal(notificationTab(null), 'delivery');
assert.equal(managementPeopleTab('roles'), 'roles');
assert.equal(managementPeopleTab('invalid'), 'people');
assert.equal(managementPeopleTab(null), 'people');
assert.deepEqual(managementPeopleTabs.map(tab => tab.href), ['/management/people?tab=people', '/management/people?tab=roles']);
const Host = await loadComponent('tests/helpers/HeaderHost.svelte', `<script>
  import PageHeader from '../../src/lib/workbench/PageHeader.svelte';
  let tabs = $state([]);
  export function setTabs(next) { tabs = next; }
</script>
<PageHeader section={{label:'管理',href:'/management'}} current={{label:'通知管理',href:'/management/messenger'}} {tabs} activeTabId="test">
  {#snippet account()}<span>个人入口</span>{/snippet}
</PageHeader>`);
const app = mount(Host, {target: document.body});
flushSync();
assert.equal(document.querySelector('h1 a').getAttribute('href'), '/management/messenger');
assert.equal(document.querySelector('.tr-breadcrumb a').getAttribute('href'), '/management');
assert.equal(document.querySelector('[aria-label="标签页"]'), null);
flushSync(() => app.setTabs([{id:'delivery',label:'消息投递',href:'?tab=delivery'}]));
assert.equal(document.querySelector('[aria-label="标签页"]'), null, 'single view must not render a tab bar');
flushSync(() => app.setTabs([{id:'delivery',label:'消息投递',href:'?tab=delivery'},{id:'test',label:'测试消息',href:'?tab=test'}]));
assert.equal(document.querySelector('[aria-label="标签页"] [aria-current="page"]').getAttribute('href'), '?tab=test');
await unmount(app);
await window.happyDOM.abort();
