// A fixed nine-body pile. Every body settles through the real solver; no
// sleeping, contact, frozen, velocity or merge result is fabricated here.
const PILE = [[4,50,590],[5,145,590],[4,250,590],[5,350,590],[3,100,500],[2,195,490],[3,295,500],[1,130,410],[1,330,410]];
export const STACK_SCENES = {
 'pile-pull':{level:1,x:345,special:'magnet'},
 'pile-control':{level:1,x:345,special:null},
 'pile-blocked':{level:2,x:300,special:'magnet'},
 'pile-consumed':{level:2,x:240,special:'magnet'},
 'pile-empty':{level:2,x:60,special:'magnet'},
};
export function prepareStack(g,scene){
 const spec=STACK_SCENES[scene];if(!spec)throw new Error('unknown_stack_scene');
 for(const [level,x,y] of PILE)g.spawnCrab(level,x,y);
 for(let i=0;i<360;i++)g.update(1/120);
 g.current=spec.level;g.currentSpecial=spec.special;g.setAim(spec.x);
 return {initialBodies:g.world.bodies.length,observed:new Set()};
}
