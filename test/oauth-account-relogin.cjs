// Continue on the account/daily fixture; revoke only this synthetic test token.
async page => {
 const url=new URL(page.url()),api=new URL(url.searchParams.get('api'));if(url.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1')throw Error('loopback fixture only');
 const original=await page.evaluate(async origin=>{const p=JSON.parse(localStorage.getItem('clawd-merge:player:dev:'+origin));const r=await fetch(origin+'/api/logout',{method:'POST',headers:{Authorization:'Bearer '+p.token}});if(!r.ok)throw Error('fixture logout');return p.id;},api.origin);
 const counts=async()=>await(await page.request.get(api.origin+'/api/__fixture/counts')).json(),before=await counts();
 await page.reload();await page.getByRole('heading',{name:'继续上一局？'}).waitFor();await page.locator('#restore-close').click();await page.locator('#player-chip').click();await page.getByRole('heading',{name:'重新登录原账号'}).waitFor();
 await page.getByRole('button',{name:'用 Linux.do 重新登录原账号'}).click();await page.getByRole('link',{name:'授权测试乙',exact:true}).click();await page.getByRole('heading',{name:'检查 Linux.do 授权'}).waitFor();
 if(!(await page.locator('.auth-content').innerText()).includes('另一个账号'))throw Error('wrong provider account must be rejected');
 const kept=await page.evaluate(origin=>JSON.parse(localStorage.getItem('clawd-merge:player:dev:'+origin)).id,api.origin);if(kept!==original)throw Error('wrong account adopted');
 await page.getByRole('button',{name:'取消未完成的授权'}).click();await page.getByRole('heading',{name:'重新登录原账号'}).waitFor();await page.getByRole('button',{name:'用 Linux.do 重新登录原账号'}).click();await page.getByRole('link',{name:'授权测试甲',exact:true}).click();await page.getByRole('heading',{name:'操作已完成'}).waitFor();await page.getByRole('button',{name:'继续玩',exact:true}).click();
 await page.getByRole('heading',{name:'继续上一局？'}).waitFor();await page.locator('#restore-primary').click();await page.waitForFunction(()=>window.clawd.drops>0);
 const after=await counts();if(after.classicSessions!==before.classicSessions||after.challengeSessions!==before.challengeSessions)throw Error('re-login issued a replacement game');
 return {passed:'expired session preserves original identity and saved rounds; wrong provider account rejected; correct provider re-login restores original ticket',counts:after};
}
