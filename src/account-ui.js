import { drawCrabIcon } from './crabs.js';
import { nameEl } from './player-identity.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(text,action,primary=false)=>`<button type="button" class="auth-button ${primary?'auth-primary':''}" data-action="${action}">${text}</button>`;
const notice=(text,type='')=>`<p class="auth-notice ${type}" ${type==='auth-error'?'role="alert"':''}>${esc(text)}</p>`;
const field=(label,id,value='',hint='',autocomplete='off')=>`<label class="auth-field" for="auth-${id}">${label}</label><input id="auth-${id}" name="${autocomplete==='username'?'username':id}" value="${esc(value)}" autocomplete="${autocomplete}" ${autocomplete==='username'?'autocapitalize="none" spellcheck="false"':''} required>${hint?`<p class="auth-hint">${hint}</p>`:''}`;
const password=(id,label,fresh=false)=>`<label class="auth-field" for="auth-${id}">${label}</label><div class="auth-password"><input id="auth-${id}" name="${id}" type="password" autocomplete="${fresh?'new-password':'current-password'}" required><button type="button" data-show="auth-${id}" aria-label="显示${label}" aria-pressed="false">显示</button></div>${fresh?'<p class="auth-hint">6—128 个字符，保留空格和大小写。支持粘贴。</p>':''}`;
const form=(kind,body,label)=>`<form method="post" data-form="${kind}">${body}<p class="auth-error-text" role="alert"></p><button class="auth-button auth-primary" type="submit">${label}</button></form>`;
const kindOf=p=>p?.account?.kind||(p?.linuxdo?'linuxdo':p?'guest':'anonymous');
export function createAccountUI({client,oauth,identity,setOpen,onChanged,guard,onLinuxdo,onPending,onReload,notify}){
 const element=document.createElement('div');element.id='auth-modal';element.className='modal hidden';element.setAttribute('role','dialog');element.setAttribute('aria-modal','true');element.setAttribute('aria-labelledby','auth-title');
 element.innerHTML='<div class="sheet auth-sheet"><header class="auth-head"><div><span class="auth-eyebrow">你的 Clawd 身份</span><h2 id="auth-title"></h2></div><button type="button" class="auth-close" aria-label="关闭账号面板">×</button></header><div class="auth-content"></div></div>';
 document.body.append(element);const content=element.querySelector('.auth-content'),title=element.querySelector('h2'),closeButton=element.querySelector('.auth-close');
 let visible=false,screen='entry',revision=0,busy=false,busyOwner=0,result=null,me=null,capabilities={passwordEnabled:false,registrationEnabled:false,linuxdoEnabled:true},continuation=null,returnScreen='entry',tempConfirmed=false;
 let oauthGrant=null,bindGrant=null;
 const value=id=>element.querySelector('#auth-'+id)?.value||'';
 const handle=()=>client.intent?.loginHandle||identity.player?.account?.loginHandle||'';
 const handleCard=()=>handle()?`<div class="auth-credentials"><span class="auth-hint">固定登录账号 · 改昵称不会改变它</span><strong>${esc(handle())}</strong>${button('复制完整账号','copy-handle')}</div>`:'';
 const hiddenHandle=()=>`<input type="text" name="username" autocomplete="username" value="${esc(handle())}" hidden>`;
 function render(next,message=''){
  screen=next;revision++;const p=identity.player,kind=kindOf(p);let html='';const titles={entry:'加入排行榜',guest:'先用游客玩',register:'创建密码账号',password:'设置密码',login:'登录已有账号',recover:'找回账号',account:'我的账号',change:'修改密码',rotate:'更换恢复码',rename:'修改公开昵称',success:'请保存账号信息',done:'操作已完成',uncertain:'检查上次操作',guard:'先处理当前对局',leave:'还没有保存恢复信息',identity:'账号已在其他页面变化',expired:'请使用完整账号登录',loading:'我的账号'};
  title.textContent=next==='register'&&p?'设置密码登录':titles[next]||'账号管理';
  const oauthTitles={bind:'绑定 Linux.do',bindConfirm:'确认绑定 Linux.do',oauthPending:'检查 Linux.do 授权',oauthConflict:'无法完成这次绑定',oauthReset:'重新设置密码',reauthExpired:'请重新验证',relogin:'重新登录原账号'};
  if(oauthTitles[next])title.textContent=oauthTitles[next];
  if(next==='cleanup')title.textContent='结束本次操作';
  if(next==='entry')html=`<p>换设备，也能找回你的成绩。</p>${capabilities.passwordEnabled?button('登录已有账号','login',true):notice('密码服务暂不可用。你仍可使用游客或 Linux.do。')}${capabilities.registrationEnabled?button('创建密码账号','register'):''}<div class="auth-divider">也可以</div>${capabilities.linuxdoEnabled?button('使用 Linux.do 继续','linuxdo'):''}<div class="auth-row">${button('先用游客玩','guest')}${button('暂不加入，继续本地玩','close')}</div><p class="auth-hint">账号保存排行榜成绩与历史，不同步棋盘。</p>`;
  if(next==='loading')html=notice('正在读取账号信息…')+button('重试读取','account');
  if(next==='guest')html=`<p>游客可以参加排行；换设备或清除浏览器数据后，可能无法找回。</p>${form('guest',field('游客名字','name','', '2—12 个字符，可以同名，系统会加上编号。'),'以游客身份加入')}${button('返回','entry')}`;
  if(next==='register')html=`<p>名字可以相同，系统会分配专属编号。</p>${form('register',field('注册名','name',p?.name||'','2—12 个字符；名字和编号一起构成固定登录账号。'),'确认名字，获取编号')}<p class="auth-hint">${p?'当前玩家身份与历史成绩会保留。':'账号记录成绩与历史，不同步棋盘。'}</p>${button('返回','back')}`;
  if(next==='password')html=`<p>请记住完整账号，包括 # 后的四位编号。</p>${handleCard()}${!client.intentDurable?notice('未能保存操作准备信息。请先另行保存完整账号，再确认本次临时继续。','auth-error'):''}${form('password',hiddenHandle()+password('pass','设置密码',true)+password('confirm','再次输入密码',true)+(!client.intentDurable?'<label class="auth-check"><input id="auth-temporary" type="checkbox" required>我已另行保存完整账号，了解关闭本页后需用它登录。</label>':''),p?'设置密码并保留成绩':'创建账号并保留成绩')}${button('取消这次登记','cancel-intent')}`;
  if(next==='login')html=`<p>输入完整账号，包括 # 后的四位编号。</p>${form('login',field('登录账号','handle',handle(),'例如：小螃蟹#4821','username')+password('pass','密码'),'登录')}<div class="auth-row">${button('忘记账号或密码','recover')}${button('返回','back')}</div>${capabilities.linuxdoEnabled?button('使用 Linux.do 登录','linuxdo'):''}`;
  if(next==='recover')html=`<p>不使用邮箱或短信。请使用之前保存的恢复码。</p>${form('recover',field('完整登录账号','handle',handle(),'','username')+field('一次性恢复码','code','','请完整粘贴，不要添加空格。')+password('pass','新密码',true)+password('confirm','再次输入新密码',true),'验证并设置新密码')}<details><summary>忘记编号，或没有恢复方式？</summary><p class="auth-hint">请检查密码管理器或注册时保存的信息。本页不会查询同名账号或列出编号。已绑定 Linux.do 的账号可以用它登录；没有恢复方式时，无法凭昵称、分数或截图找回。</p></details>${capabilities.linuxdoEnabled?button('用已绑定的 Linux.do 登录','linuxdo'):''}${button('返回登录','login')}`;
  if(next==='account'){
    const a=me?.account||p?.account,c=me?.capabilities||p?.capabilities||{canRename:!p?.linuxdo,canBindLinuxdo:!p?.linuxdo&&capabilities.linuxdoEnabled},labels={guest:'游客 · 仅当前设备',password:'密码账号',linuxdo:'Linux.do 账号',linked:'密码 + Linux.do'};
    html=`<div class="auth-identity"><canvas id="auth-avatar" aria-hidden="true"></canvas><div><strong id="auth-name-label"></strong><span class="auth-hint">${labels[kind]}</span></div></div>${kind==='guest'?notice('游客没有密码。换设备或清除浏览器数据后，可能无法找回。'):''}${a?.loginHandle?`<div class="auth-credentials"><span class="auth-hint">固定登录账号 · 公开改名不影响登录</span><strong>${esc(a.loginHandle)}</strong>${button('复制完整账号','copy-handle')}</div>`:''}<div class="auth-list"><div><span>经典最佳<strong>${me?.best??'—'} 分</strong></span><span>已上传经典对局<strong>${me?.games??'—'} 局</strong></span></div><div><span>公开昵称<small>${kind==='linuxdo'?'跟随 Linux.do 名字':'修改后可能分配新的公开编号'}</small></span>${c.canRename?button('修改','rename'):''}</div><div><span>密码登录<small>${['password','linked'].includes(kind)?'已设置':'尚未设置'}</small></span>${c.canSetPassword?button('设置','register'):c.canChangePassword?button('修改','change'):''}</div><div><span>Linux.do<small>${p?.linuxdo?'已连接 · 不支持解绑':'尚未绑定'}</small></span>${c.canBindLinuxdo?button('绑定',capabilities.oauthAccountActions?'bind':'linuxdo'):p?.linuxdo?'<span class="auth-badge">已连接</span>':''}</div>${c.canRotateRecoveryCode?`<div><span>一次性恢复码<small>旧码不再显示，更换后失效</small></span>${button('更换','rotate')}</div>`:''}</div>${button('退出当前账号','logout')}<p class="auth-hint">退出不会删除历史成绩，其他设备保持登录。</p>`;
  }
  if(next==='rename')html=`<p>公开昵称用于排行榜和新分享卡，不改变登录账号。</p>${form('rename',field('公开昵称','name',p?.name||''),'保存公开昵称')}${button('返回账号','account')}`;
  if(next==='bind')html=`<p>先验证当前密码，确认是你本人添加登录方式。</p>${form('bind',hiddenHandle()+password('old','当前密码'),'验证并继续')}${button('返回账号','account')}`;
  if(next==='bindConfirm')html=`${notice(kind==='guest'?'若此 Linux.do 已有账号，当前游客历史将合入该账号；否则保留当前玩家身份。未完成正式局与待提交记录需要先处理。':'绑定后，密码与 Linux.do 将进入同一玩家身份。固定登录账号、昵称和历史成绩保留。其他正式账号之间不会合并。')}<p class="auth-hint">请在授权页选择正确的 Linux.do 账号。暂不支持解绑或更换。</p>${button('确认，前往 Linux.do 授权','bind-go',true)}${button('返回账号','account')}`;
  if(next==='oauthPending'||next==='oauthConflict')html=`${notice(next==='oauthConflict'?'当前账号保持不变，未合并其他正式账号。':'请先检查原授权结果，避免重复绑定或切换身份。')}${button('检查这次授权结果','oauth-inspect',true)}${!oauth?.pending?.code&&!['oauth_cancelled','operation_stale','operation_expired','identity_changed','unauthorized'].includes(oauth?.lastError)?button('继续原授权','oauth-resume'):''}${button('取消未完成的授权','oauth-discard')}${button('先回游戏','close')}`;
  if(next==='relogin')html=`${notice('登录凭据已失效，原局与待提交记录仍保留。请使用原账号重新登录，不能直接换到另一个玩家。')}${handleCard()}${['password','linked'].includes(kind)?button('使用密码重新登录','login',true):''}${p?.linuxdo&&capabilities.oauthAccountActions?button('用 Linux.do 重新登录原账号','oauth-relogin',kind==='linuxdo'):''}${kind==='guest'?notice('游客没有其他登录方式；原凭据失效时，无法凭昵称或分数找回。'):''}${button('退出本页账号','logout')}${button('返回游戏','close')}`;
  if(next==='reauthExpired')html=`${notice('近期验证已失效，请从账号面板重新完成验证。')}${button('返回账号重新验证','account',true)}`;
  if(next==='oauthReset')html=`${notice('已通过绑定的 Linux.do 验证。保存后，旧密码、旧会话和旧恢复码都将失效。')}${form('oauth-reset',hiddenHandle()+password('pass','新密码',true)+password('confirm','再次输入新密码',true),'确认并保存新密码')}${button('返回账号','account')}`;
  if(next==='change')html=`${notice('修改后，所有旧会话会退出；原恢复码保持有效。')}${form('change',hiddenHandle()+password('old','当前密码')+password('pass','新密码',true)+password('confirm','再次输入新密码',true),'确认修改密码')}${p?.capabilities?.canRecoverPasswordWithLinuxdo?button('用 Linux.do 验证并重设密码','oauth-recover'):''}${button('返回账号','account')}`;
  if(next==='rotate')html=`${notice(kind==='linuxdo'?'当前仍需 Linux.do 登录；恢复码不能代替完整本地账号。建议先设置密码登录。':'更换后旧恢复码立即失效，请在下一步保存新码。')}${kind==='linuxdo'?button('先设置密码登录','register'):''}${oauthGrant?.purpose==='rotate_recovery'?button('验证已完成，生成新恢复码','oauth-rotate-commit',true):`${kind!=='linuxdo'?form('rotate',hiddenHandle()+password('old','当前密码'),'验证并更换恢复码'):''}${p?.linuxdo&&capabilities.oauthAccountActions?button('使用 Linux.do 重新验证','oauth-rotate',kind==='linuxdo'):''}`}${button('返回账号','account')}`;
  if(next==='success')html=`${kind==='linuxdo'?notice('此账号尚未设置本地密码账号，目前仍需 Linux.do 登录。若要通过完整账号和恢复码找回，请先设置密码登录，届时会生成新的恢复码。'):''}<div class="auth-success-mark" aria-hidden="true">✓</div><h3>${client.intent?.action==='recover_password'?'密码已重设':client.intent?.action==='rotate_recovery'?'恢复码已更换':'账号准备好了'}</h3>${identity.memoryOnly?notice('未能保存登录状态。本页可以继续使用，刷新或关闭后需重新登录。请先保存下面的信息。','auth-error'):''}${handleCard()}<div class="auth-credentials"><span class="auth-hint">一次性恢复码</span><strong class="auth-code">${esc(result?.recoveryCode)}</strong>${button('复制恢复码','copy-code')}</div><p class="auth-hint">请现在保存在密码管理器或其他安全位置。恢复码使用后失效。</p><label class="auth-check"><input id="auth-saved" type="checkbox">${kind==='linuxdo'?'我已保存恢复码，了解仍需 Linux.do 登录':'我已保存完整账号和恢复码'}</label><button class="auth-button auth-primary" data-action="finish" disabled>保存好了，继续玩</button>${identity.memoryOnly?button('重试保存登录状态','retry-storage'):''}`;
  if(next==='done')html=`${notice(client.intent?.action==='change_password'?'密码已修改，原恢复码仍然有效。':'登录成功。','auth-success')}${identity.memoryOnly?notice('未能保存登录状态。本页可用，刷新后请重新登录。','auth-error'):''}${handleCard()}${identity.memoryOnly?button('重试保存登录状态','retry-storage'):''}${button('继续玩','finish',true)}`;
  if(next==='uncertain')html=`${notice('操作可能已经完成。请先检查原操作结果，避免重复创建账号。')}${handleCard()}${button('检查本次结果','inspect',true)}${client.intent?.operationTicket?button('取消仍未完成的操作','cancel-intent'):''}${button('先继续本地玩','close')}`;
  if(next==='cleanup')html=`${notice('服务器已确认取消；浏览器尚未更新本机记录。请重试结束操作，原账号保持不变。')}${button('重试结束操作','cancel-intent',true)}${button('先回游戏','close')}`;
  if(next==='expired')html=`${notice('本次结果已无法重新读取。请用保存的完整账号和设置的密码尝试登录；不要直接重复注册。','auth-error')}${handleCard()}${button('前往登录','expired-login',true)}`;
  if(next==='guard')html=`${notice(message)}${continuation?button('已了解，继续','guard-confirm',true):''}${button('查看待处理记录','pending')}${button('返回','guard-back')}`;
  if(next==='leave')html=`${notice('关闭后将不再显示这份恢复码。建议先保存完整账号和恢复码。','auth-error')}${button('返回保存信息','success',true)}${button('知道了，仍然关闭','force-close')}`;
  if(next==='identity')html=`${notice('为避免旧响应覆盖新账号，已暂停本页操作。原局仍保存在本机，请刷新后核对原身份或选择本地继续。')}${button('刷新并检查存档','reload',true)}`;
  content.innerHTML=(message&&next!=='guard'?notice(message,'auth-error'):'')+html;
  if(next==='account'){content.querySelector('#auth-name-label').replaceChildren(nameEl(p,''));drawCrabIcon(content.querySelector('#auth-avatar'),1,48,42,devicePixelRatio||1);}
  if(next==='success')content.querySelector('#auth-saved').onchange=e=>content.querySelector('[data-action=finish]').disabled=!e.target.checked;
  content.scrollTop=0;const focus=content.querySelector('input:not([hidden]),button:not(:disabled),summary');focus?.focus({preventScroll:true});
 }
 async function cancelRejectedIntent(){try{await client.cancelPending();return true;}catch(error){render(error.operationCancelled?'cleanup':'uncertain',error.message);return false;}}
 async function run(work,after){
  if(busy)return;busy=true;const owner=++busyOwner,frame=revision;const submit=content.querySelector('button[type=submit]');if(submit)submit.disabled=true;const status=content.querySelector('.auth-error-text');if(status){status.setAttribute('role','status');status.classList.add('auth-waiting');status.textContent='正在确认，请稍候…';}
  try{const value=await work();if(!visible||revision!==frame)return;await after?.(value);}
  catch(error){if(!visible||revision!==frame)return;if(oauth?.pending)oauth.lastError=error.code;
    if(error.code==='local_cleanup_failed'&&error.operationCancelled)render('cleanup',error.message);
    else if(oauth?.pending&&['binding_conflict','identity_mismatch'].includes(error.code))render('oauthConflict',error.message);
    else if(oauth?.pending)render('oauthPending',error.message);
    else if(error.status===401&&error.code==='unauthorized'&&identity.player){identity.sessionExpired=true;render('relogin',error.message);}
    else if(oauthGrant&&['invalid_reauth','reauth_required'].includes(error.code)){oauthGrant=null;if(await cancelRejectedIntent())render('reauthExpired',error.message);}
    else if(client.intent?.submitted&&['timeout','offline','auth_busy','internal','bad_response'].includes(error.code))render('uncertain',error.message);
    else if(['operation_expired','operation_stale'].includes(error.code))render('expired',error.message);
    else{const message=content.querySelector('.auth-error-text');if(message){message.setAttribute('role','alert');message.classList.remove('auth-waiting');message.textContent=error.message||'暂时无法完成，请稍后重试';}else content.insertAdjacentHTML('afterbegin',notice(error.message||'暂时无法完成，请稍后重试','auth-error'));
      if(error.code==='invalid_credentials'&&client.intent)await cancelRejectedIntent();
      if(error.retryAfterMs&&submit){const until=Date.now()+error.retryAfterMs;const tick=()=>{if(!visible||revision!==frame)return;const seconds=Math.max(0,Math.ceil((until-Date.now())/1000));submit.textContent=seconds?`${seconds} 秒后重试`:'重试';submit.disabled=Boolean(seconds);if(seconds)setTimeout(tick,1000);};setTimeout(tick,0);}
    }
  }finally{if(owner===busyOwner)busy=false;if(submit&&revision===frame)submit.disabled=false;}
 }
 async function protectedAction(action,work,after,confirmed=false){
  const check=await guard?.(action,{confirmed});
  if(check){returnScreen=screen;continuation=check.confirm?()=>protectedAction(action,work,after,true):null;render('guard',check.message);return;}
  return run(work,after);
 }
 function success(data){oauthGrant=null;bindGrant=null;result=data;onChanged?.();render(data.recoveryCode?'success':'done');}
 async function showAccount(){me=null;render('loading');await run(()=>client.profile(),data=>{me=data;render('account');});}
 function presentOAuth(data){if(data.kind==='reauth'){oauthGrant=data;oauth.clear();render(data.purpose==='set_password'?'register':data.purpose==='recover_password'?'oauthReset':'rotate');}else{oauth.clear();success(data);}}
 function clearIntent(){try{client.clear();return true;}catch(error){const saved=Boolean(content.querySelector('#auth-saved')?.checked);render(screen,error.message);if(saved){content.querySelector('#auth-saved').checked=true;content.querySelector('[data-action=finish]').disabled=false;}return false;}}
 function close(force=false){
  if(!force&&screen==='leave'){render('success');return;}
  if(!force&&screen==='success'&&!content.querySelector('#auth-saved')?.checked){render('leave');return;}
  if(busy&&!force)notify?.('操作可能仍在进行，可在账号面板检查结果。',5000);
  if(force&&screen==='leave'&&!clearIntent())return;
  visible=false;revision++;busyOwner++;busy=false;client.cancel();oauthGrant=null;bindGrant=null;for(const input of content.querySelectorAll('input'))input.value='';result=null;setOpen(false);
 }
 closeButton.onclick=()=>close();element.addEventListener('click',e=>{if(e.target===element)close();});
 content.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.show){const input=document.getElementById(b.dataset.show),show=input.type==='password';input.type=show?'text':'password';b.textContent=show?'隐藏':'显示';b.setAttribute('aria-label',show?'隐藏密码':'显示密码');b.setAttribute('aria-pressed',String(show));return;}
  const action=b.dataset.action;if(!action||busy)return;
  if(action==='copy-handle'||action==='copy-code'){const text=action==='copy-code'?result?.recoveryCode:handle();navigator.clipboard?.writeText(text).then(()=>{b.textContent='已复制';}).catch(()=>{b.textContent='复制失败，请手动选择上方文本';});return;}
  if(action==='close')return close();if(action==='force-close')return close(true);
  if(action==='finish'){if(screen==='success'&&!content.querySelector('#auth-saved')?.checked)return;if(!clearIntent())return;return close(true);}
  if(action==='retry-storage')return void run(()=>identity.retryAccountStorage(),()=>render(screen));
  if(action==='account'){oauthGrant=null;bindGrant=null;return void showAccount();}
  if(action==='bind')return kindOf(identity.player)==='guest'?render('bindConfirm'):render('bind');
  if(action==='bind-go')return void protectedAction(kindOf(identity.player)==='guest'?'oauth-switch':'oauth-same',()=>oauth.start('bind',{reauthProof:bindGrant?.reauthProof}));
  if(action==='register'&&kindOf(identity.player)==='linuxdo'&&!oauthGrant)return void protectedAction('oauth-same',()=>oauth.start('reauth',{purpose:'set_password'}));
  if(action==='oauth-relogin')return void protectedAction('oauth-same',()=>oauth.start('login',{samePlayerOnly:true}));
  if(action==='oauth-recover'||action==='oauth-rotate')return void protectedAction('oauth-same',()=>oauth.start('reauth',{purpose:action==='oauth-recover'?'recover_password':'rotate_recovery'}));
  if(action==='oauth-rotate-commit'){const grant=oauthGrant;return void protectedAction('mutation',async()=>{if(!client.intent)await client.prepare('rotate_recovery');return client.commit({reauthProof:grant.reauthProof},{temporaryConfirmed:true});},success);}
  if(action==='oauth-inspect')return void run(()=>oauth.inspect(),data=>data.kind==='pending'?render('oauthPending','尚未收到完成结果。请继续原授权，或取消未完成的授权。'):presentOAuth(data));
  if(action==='oauth-resume')return void protectedAction(oauth.pending?.actorKind==='guest'?'oauth-switch':'oauth-same',()=>oauth.resume());
  if(action==='oauth-discard')return void run(()=>oauth.discard(),async data=>{if(data.kind==='completed')presentOAuth(data.result);else{const message=data.kind==='expired'?'授权记录已过期或失效，已清除本页记录；服务端已经完成的操作不会撤销。':data.kind==='not_adopted'?'原授权已经完成，但返回的账号未被本页采用。当前身份保持不变，已清除这份本页记录。':'';if(identity.player){me=await client.profile();render('account',message);}else render('entry',message);}});
  if(action==='back')return identity.player?void showAccount():render('entry');
  if(action==='guard-back')return render(returnScreen);
  if(action==='guard-confirm'){const next=continuation;continuation=null;render(returnScreen);return void next?.();}
  if(action==='pending'){close(true);onPending?.();return;}
  if(action==='reload'){onReload?.();return;}
  if(action==='linuxdo'){if(!capabilities.oauthAccountActions)return void protectedAction('navigate',()=>onLinuxdo(b));const k=kindOf(identity.player);if(!['anonymous','guest'].includes(k))return render('account','请先退出当前账号再登录；验证或绑定请使用账号面板的对应入口。');return void protectedAction('oauth-switch',()=>oauth.start(k==='guest'?'bind':'login'));}
  if(action==='logout')return void protectedAction('logout',async()=>{client.clear();return identity.logout();},outcome=>{close(true);onChanged?.();notify?.(!outcome.storageCleared?'已退出本页，但未能清除本机登录信息；请检查浏览器存储权限。':!outcome.remoteConfirmed?'已退出本机；暂时无法确认服务器退出。':'已退出，本局可继续本地游玩。',6000);});
  if(action==='inspect')return void run(()=>client.inspect(),data=>{if(data.kind==='pending'){render('uncertain','服务器尚未确认完成。可以稍后检查，或先取消这份未完成的操作。');}else success(data);});
  if(action==='cancel-intent')return void run(()=>client.cancelPending(),async data=>{if(data.kind==='completed')success(data.result);else if(identity.player&&kindOf(identity.player)!=='guest'){me=await client.profile();render('account','已取消未完成的操作。');}else render(identity.player?'register':'entry','已取消未完成的操作。');});
  if(action==='expired-login'){const saved=handle();if(!clearIntent())return;render('login');const input=content.querySelector('#auth-handle');if(input)input.value=saved;return;}
  render(action);
 });
 content.addEventListener('submit',e=>{
  e.preventDefault();if(busy)return;const type=e.target.dataset.form;
  const issue=text=>{e.target.querySelector('.auth-error-text').textContent=text;};
  if(['password','change','recover','oauth-reset'].includes(type)){if(value('pass')!==value('confirm'))return issue('两次输入的密码不一致。');const n=[...value('pass')].length;if(n<6||n>128)return issue('密码需为 6—128 个字符。');}
  if(type==='guest')return void protectedAction('join',()=>identity.register(value('name')),()=>{close(true);onChanged?.();});
  if(type==='register')return void protectedAction('mutation',()=>client.prepare(identity.player?'set_password':'register',{name:value('name')}),()=>render('password'));
  if(type==='password'){const pw=value('pass'),grant=oauthGrant;tempConfirmed=Boolean(content.querySelector('#auth-temporary')?.checked);return void protectedAction('mutation',()=>client.commit({password:pw,...(grant?{reauthProof:grant.reauthProof}:{})},{temporaryConfirmed:tempConfirmed}),success);}
  if(type==='login'){const user=value('handle'),pw=value('pass');return void protectedAction('login',()=>client.login(user,pw),success);}
  if(type==='recover'){const user=value('handle'),code=value('code'),pw=value('pass');return void protectedAction('login',async()=>{if(!client.intent)await client.prepare('recover_password',{loginHandle:user});return client.commit({loginHandle:user,recoveryCode:code,newPassword:pw},{temporaryConfirmed:true});},success);}
  if(type==='change'){const old=value('old'),pw=value('pass');return void protectedAction('mutation',async()=>{if(!client.intent)await client.prepare('change_password');return client.commit({oldPassword:old,newPassword:pw},{temporaryConfirmed:true});},success);}
  if(type==='rotate'){const pw=value('old');return void protectedAction('mutation',async()=>{const reauth=await client.reauth(pw,'rotate_recovery');if(!client.intent)await client.prepare('rotate_recovery');return client.commit({reauthProof:reauth.reauthProof},{temporaryConfirmed:true});},success);}
  if(type==='bind'){const pw=value('old');return void protectedAction('mutation',()=>client.reauth(pw,'bind_linuxdo'),grant=>{bindGrant=grant;render('bindConfirm');});}
  if(type==='oauth-reset'){const pw=value('pass'),grant=oauthGrant;return void protectedAction('mutation',async()=>{if(!client.intent)await client.prepare('recover_password',{loginHandle:identity.player.account.loginHandle,recoveryMethod:'linuxdo'});return client.commit({newPassword:pw,reauthProof:grant?.reauthProof},{temporaryConfirmed:true});},success);}
  if(type==='rename'){const name=value('name');return void run(()=>identity.rename(name),async()=>{onChanged?.();me=await client.profile();render('account','公开昵称已更新，固定登录账号不变。');});}
 });
 return {
  element,
  async open(mode='entry',message=''){
    visible=true;result=null;tempConfirmed=false;setOpen(true);render('entry',message);
    const frame=revision;const features=await client.features();if(!visible||frame!==revision)return;capabilities=features;
    if(oauth?.pending||oauth?.unreadable){render('oauthPending',message);return;}
    if(client.intent||client.intentError){render(client.intent?'uncertain':'expired',client.intentError?'无法读取之前的账号操作记录，请使用保存的完整账号登录。':'');return;}
    if(mode==='account'&&identity.player)await showAccount();else render('entry',message);
  },
  async receiveOAuth(data,error){visible=true;setOpen(true);render('oauthPending');const frame=revision;const features=await client.features();if(!visible||frame!==revision)return;capabilities=features;if(error)oauth.lastError=error.code;if(error)render(['binding_conflict','identity_mismatch'].includes(error.code)?'oauthConflict':'oauthPending',error.message);else presentOAuth(data);},
  close,
  hostClosed(){visible=false;revision++;busyOwner++;busy=false;client.cancel();oauthGrant=null;bindGrant=null;result=null;for(const input of content.querySelectorAll('input'))input.value='';},
  externalIdentityChanged(){client.cancel();busyOwner++;busy=false;result=null;oauthGrant=null;bindGrant=null;if(visible)render('identity');},
 };
}
