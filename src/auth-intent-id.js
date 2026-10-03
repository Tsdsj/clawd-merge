// UUIDv7: immutable millisecond timestamp + native random bits. The timestamp
// lets a server reject expired request IDs even after all receipt rows are gone.
export function newIntentId(timestamp) {
  if(!Number.isSafeInteger(timestamp)||timestamp<0||timestamp>0xffffffffffff)throw Error('Invalid intent time');
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  for(let i=0;i<6;i++)bytes[i]=Math.floor(timestamp/2**(8*(5-i)))&255;
  bytes[6]=(bytes[6]&15)|0x70;bytes[8]=(bytes[8]&63)|0x80;
  const hex=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function intentTime(id) {
  return typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
    ?parseInt(id.slice(0,8)+id.slice(9,13),16):null;
}
