const CACHE='eastmoney-public-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/offline.html','/pwa-192.png','/pwa-512.png'])).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('eastmoney-public-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 if(event.request.method==='GET'&&event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>caches.match('/offline.html')));
});
self.addEventListener('push',event=>{
 let data;try{data=event.data?.json();}catch{data={};}
 data ??={};
 event.waitUntil(self.registration.showNotification(data.title||'资金管理部',{body:data.body||'您有一条新通知',tag:data.tag||'eastmoney',icon:'/pwa-192.png',badge:'/pwa-192.png',requireInteraction:true,data:{url:data.url||'/management/notifications'}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const target=new URL(event.notification.data?.url||'/management/notifications',self.location.origin);
 if(target.origin!==self.location.origin)return;
 event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
  const client=clients.find(item=>new URL(item.url).origin===target.origin);
  if(client){await client.navigate(target.href);return client.focus();}
  return self.clients.openWindow(target.href);
 }));
});
