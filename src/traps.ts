import * as THREE from 'three';
import { B } from './blocks';
import type { Game } from './main';

export type TrapId = 'spikes' | 'trapdoor' | 'arrow' | 'flame' | 'mine';
export interface TrapSpec { id: TrapId; name: string; inventoryKey: string; footprint: readonly [number, number]; height: number; range: number; minRange: number; recipe: Record<string, number>; capacity: number; resource?: string }
export const TRAPS: Record<TrapId, TrapSpec> = {
  spikes: { id:'spikes', name:'Spike trap', inventoryKey:'spikeTrap', footprint:[1,1], height:.3, range:1, minRange:0, recipe:{wood:3, metal:2}, capacity:0 },
  trapdoor: { id:'trapdoor', name:'Trapdoor', inventoryKey:'trapdoor', footprint:[1,1], height:1, range:0, minRange:0, recipe:{wood:4, metal:1}, capacity:0 },
  arrow: { id:'arrow', name:'Arrow trap', inventoryKey:'arrowTrap', footprint:[1,1], height:1, range:12, minRange:1, recipe:{wood:4, metal:4}, capacity:20, resource:'ammo' },
  flame: { id:'flame', name:'Flame trap', inventoryKey:'flameTrap', footprint:[1,1], height:1, range:7, minRange:1, recipe:{metal:6, stone:2}, capacity:30, resource:'goo' },
  mine: { id:'mine', name:'Blast mine', inventoryKey:'blastMine', footprint:[1,1], height:.2, range:2.5, minRange:0, recipe:{metal:3, stone:2}, capacity:0 },
};
export interface TrapSave { id: TrapId; x:number; y:number; z:number; rotation:number; open:boolean; ammo:number }
interface Trap extends TrapSave { model:THREE.Group; cooldown:number; hits:WeakMap<object,number> }
const directions = [[0,1],[1,0],[0,-1],[-1,0]] as const;
const box = new THREE.BoxGeometry(1,1,1), cone = new THREE.ConeGeometry(.13,.35,4);
const metal = new THREE.MeshLambertMaterial({color:0x737d80}), wood = new THREE.MeshLambertMaterial({color:0x82512c}), dark = new THREE.MeshLambertMaterial({color:0x2d3031}), fire = new THREE.MeshBasicMaterial({color:0xff7a19});
const arrowShaft = new THREE.BoxGeometry(.045,.045,.65), arrowHead = new THREE.ConeGeometry(.1,.2,4), arrowFeather = new THREE.BoxGeometry(.18,.02,.17);

export class TrapManager {
  readonly traps: Trap[] = [];
  private clock = 0;
  private flames: { mesh:THREE.Mesh; life:number }[] = [];
  private flameGeometry = new THREE.ConeGeometry(.28, 1, 6);
  private flameMaterial = new THREE.MeshBasicMaterial({color:0xff8b18, transparent:true, opacity:.8, depthWrite:false});
  constructor(private game: Game) {}
  blocksCell(x:number,y:number,z:number): boolean { return this.traps.some(t => t.x===x && t.y===y && t.z===z); }
  validate(id:TrapId, _rotation:number, x:number,y:number,z:number): string {
    const w=this.game.world;
    if (!TRAPS[id] || ![x,y,z].every(Number.isInteger) || !w.inBounds(x,y-1,z) || !w.inBounds(x,y,z)) return 'Outside world bounds';
    if (!w.isGenerated(x,z) || !w.chunkAt(x,y,z)) return 'Terrain not loaded';
    if (w.solid(x,y,z) || this.blocksCell(x,y,z) || this.game.entities.blocksCell(x,y,z,true)) return 'Footprint is occupied';
    if (id==='trapdoor') {
      if (!directions.some(([dx,dz]) => w.inBounds(x+dx,y,z+dz) && w.solid(x+dx,y,z+dz))) return 'Trapdoor needs a solid edge';
    } else if (!w.solid(x,y-1,z)) return 'Trap needs solid support';
    return '';
  }
  place(id:TrapId, rotation:number, x:number,y:number,z:number): boolean {
    const err=this.validate(id,rotation,x,y,z), spec=TRAPS[id];
    if (err || !spec) { this.game.ui.toast(err || 'Unknown trap'); return false; }
    if (!this.game.sandbox && (this.game.inv[spec.inventoryKey] | 0)<=0) { this.game.ui.toast(`Need ${spec.name}`); return false; }
    if (id==='trapdoor') this.game.world.set(x,y,z,B.PLANKS);
    this.add({id,x,y,z,rotation:((Math.round(rotation)%4)+4)%4,open:false,ammo:spec.capacity});
    if (!this.game.sandbox) this.game.inv[spec.inventoryKey]--; return true;
  }
  private add(s:TrapSave):void {
    const model=new THREE.Group(); model.position.set(s.x+.5,s.y,s.z+.5); model.rotation.y=s.rotation*Math.PI/2;
    const part=(geo:THREE.BufferGeometry, mat:THREE.Material, x:number,y:number,z:number,sx:number,sy:number,sz:number) => { const m=new THREE.Mesh(geo,mat); m.position.set(x,y,z); m.scale.set(sx,sy,sz); model.add(m); };
    if (s.id==='spikes') { part(box,wood,0,.05,0,.95,.1,.95); for (const x of [-.27,.27]) for(const z of [-.27,.27]) part(cone,metal,x,.24,z,1,1,1); }
    else if(s.id==='trapdoor') { part(box,metal,0,1.015,0,.9,.03,.07); part(box,metal,0,1.02,.4,.9,.04,.06); }
    else if(s.id==='mine') { part(box,dark,0,.07,0,.7,.14,.7); part(box,fire,0,.16,0,.14,.05,.14); }
    else { part(box,s.id==='flame'?metal:wood,0,.38,0,.8,.76,.8); part(box,dark,0,.48,.43,.35,.35,.12); if(s.id==='flame') part(box,fire,0,.48,.5,.15,.15,.04); }
    this.game.scene.add(model); this.traps.push({...s, model, cooldown:0,hits:new WeakMap()}); this.visual(this.traps[this.traps.length-1]);
  }
  private visual(t:Trap):void { if(t.id==='trapdoor') { t.model.position.y=t.y+(t.open ? -.85:0); t.model.rotation.z=t.open ? Math.PI/2:0; } }
  private remove(i:number):void { this.game.scene.remove(this.traps[i].model); this.traps.splice(i,1); }
  onBlockRemoved(x:number,y:number,z:number):void { const i=this.traps.findIndex(t=>t.id==='trapdoor'&&!t.open&&t.x===x&&t.y===y&&t.z===z); if(i>=0) this.remove(i); }
  private target():Trap|undefined {
    const p=this.game.player, eye=p.pos.clone().add(new THREE.Vector3(0,1.4,0)); let best:Trap|undefined, score=.7, distance=Infinity;
    for(const t of this.traps) { if(t.id!=='trapdoor' && !TRAPS[t.id].resource) continue; const v=new THREE.Vector3(t.x+.5,t.y+.5,t.z+.5).sub(eye), d=v.length(); if(d>3.5 || d<.001) continue; const dot=v.clone().normalize().dot(p.aimDir); if(dot<score-1e-6 || (Math.abs(dot-score)<=1e-6 && d>=distance)) continue; const hit=this.game.world.raycast(eye,v.normalize(),d); if(hit.hit && !(hit.x===t.x&&hit.y===t.y&&hit.z===t.z)) continue; score=dot; distance=d; best=t; }
    return best;
  }
  interactionHint():string { const t=this.target(); if(!t) return ''; return t.id==='trapdoor' ? `E · ${t.open?'Close':'Open'} trapdoor` : TRAPS[t.id].resource ? `E · Reload ${TRAPS[t.id].name} (${t.ammo}/${TRAPS[t.id].capacity})` : ''; }
  interact():boolean {
    const t=this.target(); if(!t) return false; const spec=TRAPS[t.id], w=this.game.world;
    if(t.id==='trapdoor') {
      if(t.open) { if(w.solid(t.x,t.y,t.z)||this.game.entities.blocksCell(t.x,t.y,t.z,true)) { this.game.ui.toast('Trapdoor path obstructed'); return true; } w.set(t.x,t.y,t.z,B.PLANKS); t.open=false; }
      else { if(w.get(t.x,t.y,t.z)!==B.PLANKS) return false; t.open=true; w.set(t.x,t.y,t.z,B.AIR); }
      this.visual(t); this.game.ui.toast(t.open?'Trapdoor opened':'Trapdoor closed'); return true;
    }
    if(!spec.resource) return false;
    const n=Math.min(spec.capacity-t.ammo,this.game.inv[spec.resource] | 0); if(n<=0) { this.game.ui.toast(t.ammo===spec.capacity?'Trap is full':`Need ${spec.resource}`); return true; }
    this.game.inv[spec.resource]-=n; t.ammo+=n; this.game.ui.toast(`${spec.name}: ${t.ammo}/${spec.capacity}`); return true;
  }
  update(dt:number):void {
    if(!Number.isFinite(dt) || dt<=0) return;
    this.clock+=dt; const w=this.game.world, player=this.game.player;
    for (let i=this.flames.length-1;i>=0;i--) { const f=this.flames[i]; f.life-=dt; if(f.life<=0) { this.game.scene.remove(f.mesh); this.flames.splice(i,1); } }
    for(let i=this.traps.length-1;i>=0;i--) {
      const t=this.traps[i], spec=TRAPS[t.id]; if(!w.chunkAt(t.x,t.y,t.z)) { t.model.visible=false; continue; }
      t.model.visible=true;
      if(t.id==='trapdoor') { if((!t.open && w.get(t.x,t.y,t.z)!==B.PLANKS) || (t.open && w.get(t.x,t.y,t.z)!==B.AIR)) this.remove(i); continue; }
      if(!w.solid(t.x,t.y-1,t.z) || w.solid(t.x,t.y,t.z)) { this.remove(i); continue; }
      if(player.pos.distanceToSquared(t.model.position)>80*80) continue;
      t.cooldown-=dt;
      if(t.id==='spikes'||t.id==='mine') {
        for(const e of this.game.entities.enemies) { if(e.dead || Math.abs(e.pos.x-t.x-.5)>.5+e.r || Math.abs(e.pos.z-t.z-.5)>.5+e.r || e.pos.y>t.y+.4 || e.pos.y+e.h<t.y) continue;
          if(t.id==='mine') { for(const victim of this.game.entities.enemies) { const d=victim.pos.distanceTo(t.model.position); if(!victim.dead&&d<spec.range && (d<.01||!w.raycast(t.model.position,victim.pos.clone().sub(t.model.position).normalize(),d).hit)) victim.damage(65*(1-d/spec.range),null,'trap'); } this.remove(i); break; }
          if((t.hits.get(e)??0)<=this.clock) { e.damage(18,null,'trap'); t.hits.set(e,this.clock+.8); }
        } continue;
      }
      if(t.cooldown>0||t.ammo<=0) continue;
      const [dx,dz]=directions[t.rotation], origin=new THREE.Vector3(t.x+.5+dx*.5,t.y+.55,t.z+.5+dz*.5); let target:typeof this.game.entities.enemies[number]|undefined, nearest=Infinity;
      for(const e of this.game.entities.enemies) { if(e.dead) continue; const v=e.pos.clone().add(new THREE.Vector3(0,e.h*.5,0)).sub(origin), forward=v.x*dx+v.z*dz, side=Math.abs(v.x*dz-v.z*dx), d=v.length(); if(forward<spec.minRange||d>spec.range||side>forward*.5+e.r||d>=nearest||w.raycast(origin,v.clone().normalize(),d).hit) continue; nearest=d; target=e; }
      if(target) { t.ammo--; t.cooldown=t.id==='arrow'?.8:.35; const direction=target.pos.clone().add(new THREE.Vector3(0,target.h*.5,0)).sub(origin); if(t.id==='arrow') { const projectile=this.game.projectiles.bullet(origin,direction.normalize(),{dmg:22,speed:45,blockDmg:0,owner:player,hostilesOnly:true}); const mesh=projectile.mesh!; mesh.geometry=arrowShaft; mesh.material=wood; const head=new THREE.Mesh(arrowHead,metal); head.rotation.x=Math.PI/2; head.position.z=.4; mesh.add(head); const feather=new THREE.Mesh(arrowFeather,metal); feather.position.z=-.27; mesh.add(feather); } else { target.damage(12,null,'trap'); if(this.flames.length<32) { const mesh=new THREE.Mesh(this.flameGeometry,this.flameMaterial), length=direction.length(); mesh.position.copy(origin).addScaledVector(direction,.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()); mesh.scale.set(1,length,1); this.game.scene.add(mesh); this.flames.push({mesh,life:.2}); } } }
    }
  }
  snapshot():TrapSave[] { return this.traps.map(({id,x,y,z,rotation,open,ammo})=>({id,x,y,z,rotation,open,ammo})); }
  restore(data?:TrapSave[]):void {
    for(let i=this.traps.length-1;i>=0;i--) this.remove(i);
    if(!Array.isArray(data)) return;
    for(const s of data.slice(0,1024)) { if(!s||!TRAPS[s.id]||![s.x,s.y,s.z,s.rotation].every(Number.isInteger)||!this.game.world.inBounds(s.x,s.y,s.z)||this.blocksCell(s.x,s.y,s.z)) continue; const block=this.game.world.get(s.x,s.y,s.z); if(s.id==='trapdoor' ? block!==(s.open?B.AIR:B.PLANKS) : block!==B.AIR) continue; this.add({...s,rotation:((s.rotation%4)+4)%4,open:!!s.open,ammo:Math.max(0,Math.min(TRAPS[s.id].capacity,Number.isFinite(s.ammo)?Math.floor(s.ammo):0))}); }
  }
}
