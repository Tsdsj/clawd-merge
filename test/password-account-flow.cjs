// Run with Playwright CLI --filename against test/password-account-browser.mjs.
// This driver refuses non-loopback origins and never returns credentials.
async page => {
 const url=new URL(page.url()),api=new URL(url.searchParams.get('api')||'https://invalid.example');
 if(!['127.0.0.1','localhost'].includes(url.hostname)||!['127.0.0.1','localhost'].includes(api.hostname))throw Error('Use the isolated loopback fixture');
 const check=(value,message)=>{if(!value)throw Error(message);};const passed=[];
 const password='UI-password-2026-with-spaces',changed='Changed-password-2026',recovered='Recovered-password-2026';
 await page.setViewportSize({width:390,height:844});
 await page.locator('#join-btn').click();await page.getByRole('button',{name:'创建密码账号',exact:true}).click();
 await page.getByRole('textbox',{name:'注册名',exact:true}).fill('界面验证');await page.getByRole('button',{name:'确认名字，获取编号'}).click();
 await page.getByRole('heading',{name:'设置密码',exact:true}).waitFor();const handle=(await page.locator('.auth-credentials strong').textContent()).trim();
 await page.locator('#auth-pass').fill(password);await page.locator('#auth-confirm').fill('wrong-confirmation');await page.getByRole('button',{name:'创建账号并保留成绩'}).click();
 check((await page.locator('.auth-error-text').innerText()).includes('不一致'),'password confirmation');
 await page.locator('#auth-confirm').fill(password);await page.getByRole('button',{name:'创建账号并保留成绩'}).click();
 await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();const recovery=(await page.locator('.auth-code').textContent()).trim();check(recovery.length===43,'recovery code shown');
 check(await page.evaluate(pw=>!JSON.stringify(Object.entries(localStorage)).includes(pw),password),'password was not persisted');
 await page.keyboard.press('Escape');await page.getByRole('heading',{name:'还没有保存恢复信息'}).waitFor();await page.getByRole('button',{name:'返回保存信息'}).click();
 await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();await page.locator('#auth-modal').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.getElementById('round-status').textContent==='本局参与排名');passed.push('registration, recovery acknowledgement and password privacy');
 await page.locator('#board').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>window.clawd.drops>0);const before=await page.evaluate(()=>({drops:window.clawd.drops,score:window.clawd.score}));
 await page.locator('#pause-btn').click();const physical=await page.evaluate(()=>JSON.stringify(window.clawd.snapshot().bodies));await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();
 await page.screenshot({path:'test-results/account-a04/account.png'});
 await page.locator('[data-action="rename"]').click();await page.locator('#auth-name').fill('公开新昵称');await page.getByRole('button',{name:'保存公开昵称'}).click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();
 check((await page.locator('.auth-credentials strong').textContent()).trim()===handle,'fixed handle after rename');passed.push('rename keeps login handle');
 await page.locator('[data-action="change"]').click();await page.locator('#auth-old').fill(password);await page.locator('#auth-pass').fill(changed);await page.locator('#auth-confirm').fill(changed);
 let starts=0;const listener=request=>{if(new URL(request.url()).pathname==='/api/session'&&request.method()==='POST')starts++;};page.on('request',listener);
 await page.getByRole('button',{name:'确认修改密码'}).click();await page.getByRole('heading',{name:'操作已完成'}).waitFor();
 check(await page.locator('.auth-code').count()===0,'password change does not rotate code');await page.getByRole('button',{name:'继续玩',exact:true}).click();
 const after=await page.evaluate(()=>({drops:window.clawd.drops,score:window.clawd.score,paused:window.clawd.paused}));
 check(after.drops===before.drops&&after.score===before.score,'board preserved');check(after.paused,'manual pause preserved');check(await page.evaluate(()=>JSON.stringify(window.clawd.snapshot().bodies))===physical,'physical board unchanged');check(starts===0,'no replacement game ticket');page.off('request',listener);passed.push('password rotation keeps board, ticket and manual pause');
 await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();await page.getByRole('button',{name:'退出当前账号'}).click();
 await page.getByRole('heading',{name:'先处理当前对局'}).waitFor();await page.getByRole('button',{name:'已了解，继续'}).click();await page.locator('#auth-modal').waitFor({state:'hidden'});
 await page.locator('#join-btn').click();await page.getByRole('button',{name:'登录已有账号',exact:true}).click();await page.getByRole('button',{name:'忘记账号或密码'}).click();
 await page.locator('#auth-handle').fill(handle);await page.locator('#auth-code').fill(recovery);await page.locator('#auth-pass').fill(recovered);await page.locator('#auth-confirm').fill(recovered);await page.getByRole('button',{name:'验证并设置新密码'}).click();
 await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();check((await page.locator('.auth-code').textContent()).trim()!==recovery,'recovery code rotated');
 await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();passed.push('original recovery code survives password change and is replaced on recovery');
 await page.locator('#player-chip').click();await page.getByRole('heading',{name:'我的账号',exact:true}).waitFor();
 for(const [width,height]of [[320,740],[390,844],[844,390],[390,380],[1280,900]]){
  await page.setViewportSize({width,height});const dim=await page.locator('.auth-sheet').evaluate(el=>{const r=el.getBoundingClientRect(),body=el.querySelector('.auth-content');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:body.clientWidth,scroll:body.scrollWidth};});
  check(dim.left>=0&&dim.right<=width+1&&dim.top>=0&&dim.bottom<=height+1&&dim.scroll<=dim.width+1,'viewport '+width+'x'+height);
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/account-a04/account-final.png'});passed.push('five viewport sizes without horizontal overflow');
 const counts=await (await page.request.get(api.origin+'/api/__fixture/counts')).json();check(counts.players===1&&counts.passwords===1,'one account through entire lifecycle');
 return {passed,counts};
}
