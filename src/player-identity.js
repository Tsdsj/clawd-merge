// LINUX DO avatar, or an orange dot for guests.
export function avatarEl(p) {
  if (p.linuxdo && p.avatar) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = p.avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener("error", () => { const dot=document.createElement("span");dot.className="chip-dot";img.replaceWith(dot); }, {once:true});
    return img;
  }
  const dot = document.createElement('span');
  dot.className = 'chip-dot';
  return dot;
}

// Name with a muted #tag for guests and a small "L" badge for LINUX DO accounts.
export function nameEl(p, className) {
  const span = document.createElement('span');
  span.className = className;
  span.append(p.name);
  if (p.tag) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `#${p.tag}`;
    span.append(tag);
  }
  if (p.linuxdo) {
    const badge = document.createElement('span');
    badge.className = 'ld-badge';
    badge.textContent = 'L';
    badge.title = `LINUX DO · 信任等级 ${p.trustLevel ?? 0}`;
    span.append(badge);
  }
  return span;
}


const signatures=new WeakMap();
export function renderPlayerChip(element, player, anonymousText='选择身份 · 游客也可正式挑战') {
  const signature=JSON.stringify(player?[player.id,player.name,player.tag,player.linuxdo,player.avatar,player.trustLevel]:[anonymousText]);
  if(signatures.get(element)===signature)return;
  signatures.set(element,signature);
  element.classList.toggle('player-chip',Boolean(player));
  element.classList.toggle('link-btn',!player);
  element.replaceChildren(...(player?[avatarEl(player),nameEl(player,'chip-name')]:[document.createTextNode(anonymousText)]));
}
