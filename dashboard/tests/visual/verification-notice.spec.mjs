import {test,expect} from '@playwright/test';
import {mockResources} from './fixtures.mjs';

test('desktop verification notice provides clear navigation without handling credentials',async({page},testInfo)=>{
 test.skip(testInfo.project.name!=='desktop','Desktop UI audit');
 await mockResources(page);await page.setViewportSize({width:1280,height:900});
 await page.goto('/auth/verify-email');
 await expect(page.getByRole('heading',{name:'请检查验证邮件',exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'我已验证，继续登录',exact:true})).toHaveAttribute('href','/auth/login?returnTo=%2Fprofile');
 await expect(page).toHaveScreenshot('verification-notice-desktop.png');
 await page.getByRole('link',{name:'东方财富证券 · 资金管理部',exact:true}).click();
 await expect(page).toHaveURL('/');
});
