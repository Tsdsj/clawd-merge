// Fresh browser context on the OAuth fixture. Uses its second synthetic user.
async page => {
 const url=new URL(page.url()),api=new URL(url.searchParams.get('api'));if(url.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1')throw Error('loopback fixture only');
 const counts=async()=>await(await page.request.get(api.origin+'/api/__fixture/counts')).json();let originalSessions;
 const authorize=async()=>{await page.getByRole('link',{name:'授权测试乙',exact:true}).click();};
 await page.locator('#join-btn').click();await page.getByRole('button',{name:'使用 Linux.do 继续'}).click();await authorize();await page.getByRole('heading',{name:'操作已完成'}).waitFor();await page.getByRole('button',{name:'继续玩',exact:true}).click();
 await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();if(!(await page.locator('.auth-content').innerText()).includes('Linux.do 账号'))throw Error('missing Linux.do-only kind');
 originalSessions=(await counts()).classicSessions;await page.locator('[data-action="register"]').click();await authorize();await page.getByRole('heading',{name:'设置密码登录',exact:true}).waitFor();await page.locator('#auth-name').fill('外部设密验收');await page.getByRole('button',{name:'确认名字，获取编号'}).click();await page.locator('#auth-pass').fill('External-local-password-2026');await page.locator('#auth-confirm').fill('External-local-password-2026');await page.getByRole('button',{name:'设置密码并保留成绩'}).click();
 await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();await page.getByRole('heading',{name:'继续上一局？'}).waitFor();await page.locator('#restore-primary').click();await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();
 if(!(await page.locator('.auth-content').innerText()).includes('密码 + Linux.do'))throw Error('missing linked kind');
 const privateKeys=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.endsWith(':oauth-intent')).length);if(privateKeys)throw Error('OAuth context should have been cleared');
 if((await counts()).classicSessions!==originalSessions)throw Error('even an empty original round must retain its ticket');
 return {passed:'Linux.do-only login, fresh OAuth proof, local password setup, linked account with scoped grant kept out of storage'};
}
