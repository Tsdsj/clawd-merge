// Continue after oauth-account-flow.cjs on the same disposable fixture.
async page => {
 const url=new URL(page.url()),api=new URL(url.searchParams.get('api'));if(url.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1')throw Error('loopback fixture only');
 const counts=async()=>await(await page.request.get(api.origin+'/api/__fixture/counts')).json(),check=(v,m)=>{if(!v)throw Error(m);};
 if(await page.locator('#daily-app').isHidden())await page.locator('#daily-open').click();
 await page.getByRole('button',{name:'开始正式挑战',exact:true}).click();await page.getByRole('button',{name:'开始正式挑战 · 消耗 1 次'}).click();await page.locator('#daily-board').waitFor();
 await page.locator('#daily-board').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.getElementById('daily-remaining').textContent.includes('99'));await page.locator('#daily-pause').click();
 const before=await counts();await page.locator('#daily-identity').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();await page.getByRole('button',{name:'退出当前账号'}).click();await page.getByRole('heading',{name:'先处理当前对局'}).waitFor();
 check(await page.locator('[data-action="guard-confirm"]').count()===0,'unfinished formal round forbids logout');await page.locator('[data-action="guard-back"]').click();
 await page.locator('[data-action="rotate"]').click();await page.getByRole('button',{name:'使用 Linux.do 重新验证'}).click();await page.getByRole('link',{name:'授权测试甲',exact:true}).click();
 await page.getByRole('heading',{name:'更换恢复码',exact:true}).waitFor();await page.getByRole('button',{name:'验证已完成，生成新恢复码'}).click();await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();
 await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();await page.locator('#daily-resume-btn').waitFor();await page.locator('#daily-resume-btn').click();
 await page.waitForFunction(()=>document.getElementById('daily-remaining').textContent.includes('99'));check((await counts()).challengeSessions===before.challengeSessions,'OAuth must not allocate another formal chance');
 await page.locator('#daily-identity').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();await page.locator('[data-action="change"]').click();await page.locator('#auth-old').fill('Browser-linked-password-2026 changed');await page.locator('#auth-pass').fill('Browser-linked-password-2026 again');await page.locator('#auth-confirm').fill('Browser-linked-password-2026 again');await page.getByRole('button',{name:'确认修改密码'}).click();await page.getByRole('heading',{name:'操作已完成'}).waitFor();await page.getByRole('button',{name:'继续玩',exact:true}).click();
 check((await counts()).challengeSessions===before.challengeSessions,'password rotation must not allocate another formal chance');check((await page.locator('#daily-remaining').textContent()).includes('99'),'daily board preserved');
 await page.locator('#daily-home').click();await page.waitForFunction(()=>document.getElementById('daily-app').textContent.includes('2 / 3'));
 await page.screenshot({path:'test-results/account-a05/daily-preserved.png'});
 return {passed:['unfinished formal round blocks account switch','OAuth reauth returns to original daily mode and ticket','same-player password rotation rechecks daily session without consuming chance'],counts:await counts()};
}
