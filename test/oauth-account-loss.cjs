// Fresh fixture: CLAWD_FIXTURE_OAUTH=1 CLAWD_FIXTURE_DROP_EXCHANGE=1.
async page => {
 const url=new URL(page.url()),api=new URL(url.searchParams.get('api'));if(url.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1')throw Error('loopback fixture only');
 await page.locator('#join-btn').click();await page.getByRole('button',{name:'使用 Linux.do 继续'}).click();await page.getByRole('link',{name:'授权测试甲',exact:true}).click();
 await page.getByRole('heading',{name:'检查 Linux.do 授权'}).waitFor({timeout:15000});await page.getByText('请求超时，尚未收到服务器确认',{exact:true}).waitFor({timeout:15000});
 await page.reload();await page.getByRole('heading',{name:'操作已完成'}).waitFor();await page.getByRole('button',{name:'继续玩',exact:true}).click();
 const counts=await(await page.request.get(api.origin+'/api/__fixture/counts')).json();if(counts.players!==1||counts.linuxdo!==1)throw Error('duplicate provider account');
 return {passed:'OAuth exchange committed then response lost; reloaded tab uses protected original result without another provider login',counts};
}
