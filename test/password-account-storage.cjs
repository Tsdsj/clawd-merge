async page => {
 if(new URL(page.url()).hostname!=='127.0.0.1')throw Error('isolated fixture only');
 await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('fixture full','QuotaExceededError');};});
 await page.locator('#join-btn').click();await page.getByRole('button',{name:'创建密码账号',exact:true}).click();await page.locator('#auth-name').fill('临时存储验证');await page.getByRole('button',{name:'确认名字，获取编号'}).click();
 await page.locator('#auth-temporary').waitFor();await page.locator('#auth-pass').fill('Storage-password-2026');await page.locator('#auth-confirm').fill('Storage-password-2026');await page.locator('#auth-temporary').check();
 await page.getByRole('button',{name:'创建账号并保留成绩'}).click();await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();
 if(!(await page.locator('.auth-content').innerText()).includes('未能保存登录状态'))throw Error('missing memory-only notice');
 await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();
 await page.waitForFunction(()=>document.getElementById('round-status').textContent==='本局参与排名');await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();
 return {passed:'storage quota denied: explicit acknowledgement, recovery display, memory-only authenticated round and profile'};
}
