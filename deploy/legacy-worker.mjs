// Temporary compatibility endpoint for already-open legacy clients. The new
// site never depends on this Worker or its former database binding.
export default {
  async fetch(request, env) {
    const origin=request.headers.get('Origin');
    const allowed=(env.LEGACY_ALLOWED_ORIGINS||'').split(',');
    const cors={ 'Access-Control-Allow-Methods':'GET, POST, OPTIONS', 'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Expose-Headers':'Retry-After', Vary:'Origin' };
    if(allowed.includes(origin))cors['Access-Control-Allow-Origin']=origin;
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(env.MIGRATION_MODE!=='proxy')return Response.json({error:'migration_in_progress',message:'正在搬迁服务器，请稍后重试。已保存成绩仍会保留。'},{status:503,headers:{...cors,'Retry-After':'60','Cache-Control':'no-store'}});
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return new Response('Moved',{status:404,headers:cors});
    // A code issued for the former callback cannot be exchanged using the new
    // callback URL. Ask the player to restart OAuth at the new site instead.
    if(url.pathname==='/api/auth/linuxdo/callback') {
      const home=new URL(env.MIGRATION_TARGET);
      home.hash=new URLSearchParams({login_error:'登录入口已迁移，请在新地址重新登录'});
      return Response.redirect(home.toString(),302);
    }
    const target=new URL(url.pathname+url.search,env.MIGRATION_TARGET);
    const headers=new Headers();
    for(const name of ['Authorization','Content-Type','Origin','Accept'])if(request.headers.has(name))headers.set(name,request.headers.get(name));
    try {
      const upstream=await fetch(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual',signal:AbortSignal.timeout(15000)});
      const result=new Response(upstream.body,upstream);
      for(const [key,value] of Object.entries(cors))result.headers.set(key,value);
      result.headers.set('Cache-Control','no-store');
      return result;
    } catch {
      return Response.json({error:'migration_unavailable',message:'新服务器暂时未响应，成绩仍保留在本机，请稍后重试。'},{status:503,headers:{...cors,'Retry-After':'60'}});
    }
  },
};
