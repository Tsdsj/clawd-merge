// Isolated browser fixture, started with CLAWD_FIXTURE_DROP_REGISTRATION=1.
async page => {
 const url=new URL(page.url());if(url.hostname!=='127.0.0.1')throw Error('loopback fixture required');
 const api=new URL(url.searchParams.get('api'));if(api.hostname!=='127.0.0.1')throw Error('loopback API required');
 await page.locator('#join-btn').click();await page.getByRole('button',{name:'创建密码账号',exact:true}).click();
 await page.locator('#auth-name').fill('响应丢失验证');await page.getByRole('button',{name:'确认名字，获取编号'}).click();
 await page.locator('#auth-pass').fill('Isolated-password-2026');await page.locator('#auth-confirm').fill('Isolated-password-2026');
 await page.getByRole('button',{name:'创建账号并保留成绩'}).click();await page.getByRole('heading',{name:'检查上次操作'}).waitFor({timeout:15000});
 await page.reload();await page.locator('#join-btn').click();await page.getByRole('heading',{name:'检查上次操作'}).waitFor();
 await page.getByRole('button',{name:'检查本次结果'}).click();await page.getByRole('heading',{name:'请保存账号信息'}).waitFor();
 const counts=await(await page.request.get(api.origin+'/api/__fixture/counts')).json();if(counts.players!==1||counts.passwords!==1)throw Error('duplicate account');
 await page.getByRole('checkbox',{name:'我已保存完整账号和恢复码'}).check();await page.getByRole('button',{name:'保存好了，继续玩'}).click();
 return {passed:'committed response lost, reload, original receipt recovered without duplicate account',counts};
}
