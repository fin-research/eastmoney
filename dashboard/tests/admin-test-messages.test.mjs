import test from 'node:test';
import assert from 'node:assert/strict';
import {isNotificationAdmin,parseTestMessage} from '../src/lib/server/admin-test-messages.ts';
const people=[{id:'auth0|one',name:'甲',email:'login@example.com',active:true,roles:[]},{id:'auth0|disabled',active:false,roles:[]}];
const form=(overrides={})=>{
 const value={requestId:'123e4567-e89b-42d3-a456-426614174000',mode:'single',userIds:['auth0|one'],channels:['email','webpush'],title:'通知测试',text:'文本',...overrides};
 const data=new FormData();for(const [key,items] of Object.entries(value))for(const item of Array.isArray(items)?items:[items])data.append(key,item);return data;
};
test('admin-only control does not accept business permissions or email as admin',()=>{
 assert.equal(isNotificationAdmin(null),false);
 assert.equal(isNotificationAdmin({email:'shiyue@18.cn',authorization:{permissions:['messenger.delivery:retry'],roles:[]}}),false);
 assert.equal(isNotificationAdmin({authorization:{roles:[{id:'admin-id',name:'admin'}]}}),true);
});
test('single and bulk selection validates active user ids and never accepts recipient addresses or actor',()=>{
 const one=parseTestMessage(form({actor:'forged',email:'arbitrary@example.com'}),people);
 assert.deepEqual(one.userIds,['auth0|one']);assert.equal(one.actor,undefined);assert.equal(one.email,undefined);
 assert.throws(()=>parseTestMessage(form({userIds:['auth0|disabled']}),people),/停用/);
 assert.throws(()=>parseTestMessage(form({userIds:['auth0|one','auth0|other']}),people),/请选择/);
 assert.throws(()=>parseTestMessage(form({channels:['sms']}),people),/请选择/);
 assert.throws(()=>parseTestMessage(form({text:' '}),people),/请选择/);
 const others=[...people,{id:'auth0|other',active:true}];
 assert.deepEqual(parseTestMessage(form({mode:'multiple',userIds:['auth0|one','auth0|other']}),others).userIds,['auth0|one','auth0|other']);
 assert.throws(()=>parseTestMessage(form({mode:'multiple',userIds:Array.from({length:51},(_,i)=>`auth0|${i}`)}),others),/请选择/);
});
