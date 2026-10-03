// Use the disposable fixture with CLAWD_FIXTURE_OAUTH=1.
async page => {
 const home=page.url(),url=new URL(home),api=new URL(url.searchParams.get('api'));
 if(url.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1')throw Error('isolated fixture only');
 const check=(v,m)=>{if(!v)throw Error(m);},passed=[];
 const pw='Browser-linked-password-2026';
 const counts=async()=>await(await page.request.get(api.origin+'/api/__fixture/counts')).json();
 const authorize=async(name='授权测试甲')=>{await page.getByRole('heading',{name:'隔离 OAuth 测试服务'}).waitFor();await page.getByRole('link',{name,exact:true}).click();};
 await page.setViewportSize({width:390,height:844});await page.locator('#join-btn').click();await page.getByRole('button',{name:'创建密码账号',exact:true}).click();
 await page.locator('#auth-name').fill('双方式验收');await page.getByRole('button',{name:'确认名字，获取编号'}).click();await page.locator('#auth-pass').fill(pw);await page.locator('#auth-confirm').fill(pw);await page.getByRole('button',{name:'创建账号并保留成绩'}).click();
 await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();const handle=(await page.locator('.auth-credentials strong').first().textContent()).trim();await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();
 await page.waitForFunction(()=>document.getElementById('round-status').textContent==='本局参与排名');await page.locator('#board').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>window.clawd.drops>0);await page.locator('#pause-btn').click();
 const before=await counts(),board=await page.evaluate(()=>({drops:window.clawd.drops,score:window.clawd.score}));
 await page.locator('#player-chip').click();await page.locator('[data-action="bind"]').click();await page.locator('#auth-old').fill(pw);await page.getByRole('button',{name:'验证并继续'}).click();await page.getByRole('heading',{name:'确认绑定 Linux.do'}).waitFor();
 await page.getByRole('button',{name:'确认，前往 Linux.do 授权'}).click();await authorize();await page.getByRole('heading',{name:'操作已完成'}).waitFor();await page.getByRole('button',{name:'继续玩',exact:true}).click();
 await page.getByRole('heading',{name:'继续上一局？'}).waitFor();await page.locator('#restore-primary').click();await page.waitForFunction(()=>window.clawd.drops>0);
 check((await counts()).classicSessions===before.classicSessions,'binding must not replace original ticket');check(await page.evaluate(()=>window.clawd.paused),'manual pause across OAuth');
 check(await page.evaluate(b=>window.clawd.drops===b.drops&&window.clawd.score===b.score,board),'board survives provider navigation');passed.push('password binding, callback, original board/ticket/manual pause');
 await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();check((await page.locator('.auth-content').innerText()).includes('密码 + Linux.do'),'linked account UI');check((await page.locator('.auth-credentials strong').textContent()).trim()===handle,'fixed login handle');
 await page.screenshot({path:'test-results/account-a05/linked.png'});
 await page.locator('[data-action="change"]').click();await page.getByRole('button',{name:'用 Linux.do 验证并重设密码'}).click();await authorize();await page.getByRole('heading',{name:'重新设置密码',exact:true}).waitFor();await page.locator('#auth-pass').fill(pw+' changed');await page.locator('#auth-confirm').fill(pw+' changed');await page.getByRole('button',{name:'确认并保存新密码'}).click();
 await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();await page.getByRole('heading',{name:'继续上一局？'}).waitFor();await page.locator('#restore-primary').click();
 check((await counts()).classicSessions===before.classicSessions,'recovery must preserve original ticket');passed.push('linked OAuth recovery and original round restoration');
 return {passed,counts:await counts()};
}
