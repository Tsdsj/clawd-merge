// Continue after oauth-account-conflict.cjs. Both pages share one isolated origin.
async page => {
 const home=page.url(),url=new URL(home),api=new URL(url.searchParams.get('api'));if(url.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1')throw Error('loopback fixture only');
 await page.locator('[data-action="bind"]').click();await page.locator('#auth-old').fill('Conflict-password-2026');await page.getByRole('button',{name:'验证并继续'}).click();await page.getByRole('button',{name:'确认，前往 Linux.do 授权'}).click();await page.getByRole('heading',{name:'隔离 OAuth 测试服务'}).waitFor();
 const other=await page.context().newPage();await other.goto(home);
 const newer=await other.evaluate(async origin=>{const key='clawd-merge:player:dev:'+origin,p=JSON.parse(localStorage.getItem(key));const response=await fetch(origin+'/api/auth/password/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginHandle:p.account.loginHandle,password:'Conflict-password-2026'})});if(!response.ok)throw Error('fixture login');const data=await response.json();localStorage.setItem(key,JSON.stringify({...data.player,token:data.token,account:data.account,capabilities:data.capabilities}));return data.token;},api.origin);
 await page.getByRole('link',{name:'授权测试甲',exact:true}).click();await page.getByRole('heading',{name:'检查 Linux.do 授权'}).waitFor();if(!(await page.locator('.auth-content').innerText()).includes('账号已变化'))throw Error('stale source was not rejected');
 const matches=await page.evaluate(({origin,token})=>JSON.parse(localStorage.getItem('clawd-merge:player:dev:'+origin)).token===token,{origin:api.origin,token:newer});if(!matches)throw Error('stale callback overwrote another tab');
 await other.close();return {passed:'a different token saved by another tab survives the original OAuth callback; stale flow cannot bind or replace it'};
}
