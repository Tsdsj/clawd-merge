// Inspect resolved Compose JSON from stdin without printing private env/path data.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function checkReleaseConfig(config,{expectedImage,requirePasswordAuth=false}={}){
 const errors=[],s=config?.services||{},api=s.api,web=s.web,e=api?.environment||{};
 if(!expectedImage||api?.image!==expectedImage||s.backup?.image!==expectedImage)errors.push('release_image_mismatch');
 if(!web||web.ports?.length!==1||web.ports[0].host_ip!=='127.0.0.1'||Number(web.ports[0].target)!==80||!/^\d+$/.test(String(web.ports[0].published))||Number(web.ports[0].published)<1024||Number(web.ports[0].published)>65535)errors.push('web_must_use_one_loopback_port');
 if(api?.ports?.length)errors.push('api_must_not_publish_ports');
 if(s.certbot)errors.push('certbot_must_be_inactive');
 const mount=web?.volumes?.find(v=>v.target==='/opt/clawd/nginx.conf.template');if(!mount?.source?.endsWith('/nginx-proxied.conf')||!mount.read_only)errors.push('proxied_template_missing');
 try{const origin=new URL(e.PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.host!==web?.environment?.PUBLIC_HOST||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error();}catch{errors.push('public_origin_mismatch');}
 if(e.TRUST_PROXY!=='1')errors.push('trusted_proxy_required');
 if(!['0','1'].includes(e.ACCOUNT_BINDING_ENABLED))errors.push('binding_gate_must_be_explicit');
 if(requirePasswordAuth&&e.PASSWORD_AUTH_ENABLED!=='1')errors.push('existing_password_accounts_require_service');
 if(e.PASSWORD_AUTH_ENABLED==='1'){
  if(!['0','1'].includes(e.PASSWORD_REGISTRATION_ENABLED))errors.push('registration_gate_must_be_explicit');
  if(e.PASSWORD_AUTH_KEYRING_FILE!=='/run/secrets/password_keyring'||!api.secrets?.some(x=>(typeof x==='string'?x:x.source)==='password_keyring')||!config.secrets?.password_keyring?.file)errors.push('password_keyring_mount_missing');
 }
 return errors;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const args=process.argv.slice(2),at=args.indexOf('--image');if(at<0||!args[at+1]||args.some((v,i)=>!['--image','--require-password-service'].includes(v)&&i!==at+1))throw Error();let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>1048576)throw Error();}const errors=checkReleaseConfig(JSON.parse(data),{expectedImage:args[at+1],requirePasswordAuth:args.includes('--require-password-service')});console.log(JSON.stringify({ok:errors.length===0,checks:errors},null,2));if(errors.length)process.exitCode=1;}
 catch{console.error('Release preflight failed. Pipe Compose JSON and supply --image; private configuration was not printed.');process.exitCode=1;}
}
