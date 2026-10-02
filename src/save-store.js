import { SCHEMA_VERSION, RULES_VERSION, validateGameState } from './game-state.js';
import { resultFields } from './score-result.js';

export class SaveStore {
  constructor({ scope, storage, locks, channelFactory }) {
    this.scope=scope;this.storage=storage;this.locks=locks;
    this.key=`clawd-merge:save:${scope}`;
    this.owned=false;this.closed=false;this.onYield=()=>false;this.onLost=()=>{};
    try { this.channel=channelFactory?.(this.key); } catch { this.channel=null; }
    this.supported=Boolean(locks?.request && this.channel);
    if(this.channel)this.channel.onmessage=event=>{ void this.message(event.data); };
  }
  validate(r) {
    if(!r || r.schemaVersion!==SCHEMA_VERSION || r.rulesVersion!==RULES_VERSION || r.scope!==this.scope ||
      typeof r.roundId!=='string' || !r.roundId.length || r.roundId.length>100 ||
      !Number.isSafeInteger(r.savedAt) || r.savedAt<0)throw new Error('invalid_save');
    if(r.terminal) {
      resultFields(r.terminal);
      if(r.terminal.roundId!==r.roundId)throw new Error('invalid_result');
      return r;
    }
    if(r.online!==null && (!r.online || typeof r.online.playerId!=='string' ||
      (r.online.sessionId!==null && typeof r.online.sessionId!=='string')))throw new Error('invalid_ticket');
    if(r.game?.challenge)throw new Error('wrong_save_mode');
    validateGameState(r.game);return r;
  }
  record(roundId, game, online) {
    return { schemaVersion:SCHEMA_VERSION,rulesVersion:RULES_VERSION,scope:this.scope,roundId,savedAt:Date.now(),game,online };
  }
  read() {
    let raw;
    try { if(!this.storage)throw new Error();raw=this.storage.getItem(this.key); }
    catch { return { kind:'unavailable' }; }
    if(raw===null)return { kind:'empty' };
    try {
      if(raw.length>2_000_000)throw new Error();
      const record=this.validate(JSON.parse(raw));
      return {kind:record.terminal?'terminal':'saved',record};
    }
    catch { return { kind:'invalid' }; }
  }
  write(record) {
    if(!this.owned)throw new Error('not_owner');
    this.validate(record);
    const raw=JSON.stringify(record);
    if(raw.length>2_000_000)throw new Error('save_too_large');
    this.storage.setItem(this.key,raw);
  }
  remove() {
    if(!this.owned)throw new Error('not_owner');
    this.storage.removeItem(this.key);
  }
  stageResult(value) {
    const terminal=resultFields(value);
    this.write({schemaVersion:SCHEMA_VERSION,rulesVersion:RULES_VERSION,scope:this.scope,
      roundId:terminal.roundId,savedAt:Date.now(),terminal});
  }
  async acquire() {
    if(this.owned)return true;
    if(!this.supported || this.closed)return false;
    if(this.acquiring)return this.acquiring;
    this.acquiring=new Promise(resolve=>{
      this.holding=this.locks.request(this.key,{ifAvailable:true},async lock=>{
        if(!lock || this.closed){resolve(false);return;}
        this.owned=true;
        await new Promise(release=>{this.unlock=release;resolve(true);});
      }).catch(()=>{this.supported=false;resolve(false);});
    });
    const acquired=await this.acquiring;this.acquiring=null;return acquired;
  }
  async release() {
    this.owned=false;
    this.unlock?.();this.unlock=null;
    await this.holding;
  }
  async message(data) {
    if(!data || this.closed)return;
    if(data.type==='released'){this.pending?.(data.id);return;}
    if(data.type!=='takeover' || !this.owned || this.yielding)return;
    this.yielding=true;
    try {
      if(await this.onYield()) {
        await this.release();this.onLost();
        this.channel.postMessage({type:'released',id:data.id});
      }
    } catch { /* Keep the lock when saving/hand-off fails. */ }
    finally { this.yielding=false; }
  }
  async takeover(timeout=3000) {
    if(await this.acquire())return true;
    if(!this.supported)return false;
    const id=crypto.randomUUID();
    await new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending=null;resolve();},timeout);
      this.pending=received=>{if(received===id){clearTimeout(timer);this.pending=null;resolve();}};
      this.channel.postMessage({type:'takeover',id});
    });
    // No steal or lease timeout: a live non-responsive owner keeps its lock.
    return this.acquire();
  }
  close() { this.closed=true;void this.release();this.channel?.close(); }
}
