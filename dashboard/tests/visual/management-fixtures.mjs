import {PERMISSION_CODES} from '../../src/lib/permissions.ts';
export const managementAudit={
 account:{name:'测试用户',department:'资金管理部'},email:'test@18.cn',session:null,auth0:true,
 user:{id:'auth0|test',personId:'fixture',email:'test@18.cn',personName:'测试用户',roles:[],role:'admin',picture:''},
 roles:[{id:'role-admin',name:'admin',description:'管理员'},{id:'role-research',name:'研究业务组',description:'研究员'},{id:'role-empty',name:'新建只读角色',description:''}],
 configurations:{'role-admin':{permissions:[...PERMISSION_CODES]},'role-research':{permissions:PERMISSION_CODES.filter(code=>code.startsWith('research.'))},'role-empty':{permissions:[]}},
 permissions:[...PERMISSION_CODES],mode:/** @type {'enforce'} */ ('enforce'),updatedAt:1789441200000,
 people:[{id:'auth0|test',name:'测试用户',department:'资金管理部',email:'test@18.cn',active:true,roles:[]},
   {id:'auth0|colleague',name:'同事',department:'研究部',email:'colleague@18.cn',active:true,roles:[]}],
};
export const profileAudit={name:'测试用户',department:'资金管理部',email:'test@18.cn',emailVerified:true,roles:[{name:'admin',description:'管理员'}],permissions:[]};
export const notificationAudit={email:'test@18.cn',telegramChatId:'12345678',subscriptions:{workflow:['email'],trading:['email','telegram'],financing:['email','webpush']},devices:[{id:'test-desktop',createdAt:1789441200000},{id:'test-laptop',createdAt:1789354800000}],vapidPublicKey:'',categories:['workflow','trading','financing']};
