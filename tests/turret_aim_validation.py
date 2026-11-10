#!/usr/bin/env python3
"""Exercise rendered turret joints and projectile launch in Chromium against Vite."""
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173/'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader'])
    page = browser.new_page(viewport={'width':1280, 'height':720})
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#newgame').wait_for(state='visible', timeout=120000)
    page.click('#newgame')
    page.wait_for_function('game.started', timeout=60000)
    results = page.evaluate('''async () => {
      const {Turret} = await import('/src/entities.ts');
      const THREE = await import('/node_modules/three/build/three.module.js');
      game.renderer.setAnimationLoop(null);
      const g=game, oldEnemies=g.entities.enemies, oldRay=g.world.raycast, oldBounds=g.world.inBounds;
      const oldProjectile={...g.projectiles}, oldParticle=g.particles.muzzle, oldShot=g.audio.shot;
      g.world.raycast=()=>({hit:false}); g.world.inBounds=()=>true; g.particles.muzzle=()=>{}; g.audio.shot=()=>{};
      let fired=[];
      for(const name of ['bullet','defenseCannon','defenseRocket','defenseShell']) g.projectiles[name]=(origin,velocity)=>fired.push({origin:origin.clone(),velocity:velocity.clone()});
      const results=[];
      for(const id of ['auto','cannon','twin','rocket','artillery']) for(const heading of [0,Math.PI/2]) {
        const origin=g.player.pos.clone().add(new THREE.Vector3(0,15,0));
        const t=new Turret(g,origin.x,origin.y,origin.z,id); t.physics=()=>{};
        const distance=id==='artillery'?24:14;
        const e={dead:false,r:.6,pos:origin.clone().add(new THREE.Vector3(Math.sin(heading)*distance,5,Math.cos(heading)*distance)),vel:new THREE.Vector3(),center(v){return v.copy(this.pos)}};
        g.entities.enemies=[e]; t.yaw=heading; t.head.rotation.y=heading;
        fired=[]; const ammo=t.ammo; t.update(.01);
        const pitchGate=fired.length===0 && t.ammo===ammo;
        t.yaw=heading+Math.PI; t.head.rotation.y=t.yaw; t.pitch=0; t.barrel.rotation.x=0;
        t.update(.01); const yawGate=fired.length===0 && t.ammo===ammo;
        for(let i=0;i<500 && !fired.length;i++) t.update(.01);
        const forward=new THREE.Vector3(0,0,1).transformDirection(t.barrel.matrixWorld);
        const tips=t.muzzles.map(m=>m.getWorldPosition(new THREE.Vector3()));
        const valid=fired.length===(id==='twin'?2:1) && fired.every(s=>tips.some(tip=>tip.distanceTo(s.origin)<1e-6) && s.velocity.normalize().dot(forward)>0.999999);
        results.push({id,heading,pitchGate,yawGate,valid,pitch:t.pitch, count:fired.length}); t.disposeModel();
      }
      {
        const origin=g.player.pos.clone().add(new THREE.Vector3(0,15,0));
        const t=new Turret(g,origin.x,origin.y,origin.z,'twin'); t.physics=()=>{};
        const e={dead:false,r:.6,pos:origin.clone().add(new THREE.Vector3(0,1.5,4)),vel:new THREE.Vector3(),center(v){return v.copy(this.pos)}};
        g.entities.enemies=[e]; fired=[]; t.yaw=Math.PI; t.update(.01);
        const yawGate=fired.length===0;
        for(let i=0;i<500&&!fired.length;i++) t.update(.01);
        const forward=new THREE.Vector3(0,0,1).transformDirection(t.barrel.matrixWorld);
        const valid=fired.length===2 && fired.every(s=>s.velocity.normalize().dot(forward)>0.999999);
        results.push({id:'close twin',heading:0,pitchGate:true,yawGate,valid,pitch:t.pitch,count:fired.length}); t.disposeModel();
      }
      g.entities.enemies=oldEnemies; g.world.raycast=oldRay; g.world.inBounds=oldBounds;
      for(const name of ['bullet','defenseCannon','defenseRocket','defenseShell']) g.projectiles[name]=oldProjectile[name];
      g.particles.muzzle=oldParticle; g.audio.shot=oldShot;
      // Exercise real voxel raycasts with a clear elevated target and a parapet
      // placed directly in the launch path after acquisition.
      const w=g.world, p=g.player.pos, X=Math.floor(p.x)+12, Z=Math.floor(p.z)-12;
      w.generateAround(X,Z,3); let Y=0;
      for(let x=X-8;x<=X+8;x+=4) for(let z=Z-8;z<=Z+20;z+=4) Y=Math.max(Y,w.surfaceY(x,z));
      Y+=3;
      for(let x=X-8;x<=X+8;x++) for(let z=Z-8;z<=Z+20;z++) {
        w.set(x,Y-1,z,1); for(let y=Y;y<Y+15;y++) w.set(x,y,z,0);
      }
      const t=new Turret(g,X+.5,Y,Z+.5,'cannon'); t.physics=()=>{};
      const e={dead:false,pos:new THREE.Vector3(X+.5,Y+6,Z+15.5),vel:new THREE.Vector3(),center(v){return v.copy(this.pos)}};
      g.entities.enemies=[e]; fired=[];
      for(const name of ['bullet','defenseCannon','defenseRocket','defenseShell']) g.projectiles[name]=(o,v)=>fired.push({origin:o.clone(),velocity:v.clone()});
      g.particles.muzzle=()=>{}; g.audio.shot=()=>{};
      for(let i=0;i<300&&!fired.length;i++) t.update(.01);
      const clear=fired.length===1 && t.pitch>0;
      fired=[]; t.cd=0; t.scanT=100; t.target=e;
      // A solid wall intercepts the actual elevated barrel axis.
      for(let x=X-2;x<=X+2;x++) for(let y=Y;y<=Y+10;y++) w.set(x,y,Z+4,3);
      const ammo=t.ammo; for(let i=0;i<30;i++) t.update(.01);
      const blocked=fired.length===0 && t.ammo===ammo;
      results.push({id:'real terrain',heading:0,pitchGate:clear,yawGate:blocked,valid:clear&&blocked,pitch:t.pitch,count:fired.length});
      w.rebuildAround(X,Z,2);
      p.set(X-6,Y+4,Z+7); const dx=X+.5-p.x,dy=Y+1.5-(p.y+1.55),dz=Z+.5-p.z;
      g.camYaw=g.camYawT=Math.atan2(-dx,-dz); g.camPitch=Math.atan2(dy,Math.hypot(dx,dz)); g.updateCamera(0);
      g.camera.position.set(X-5,Y+4,Z+6); g.camera.lookAt(X+.5,Y+1.3,Z+.5); g.camera.updateMatrixWorld();
      g.scene.add(new THREE.AmbientLight(0xffffff, 2)); g.renderer.render(g.scene,g.camera);
      window.aimFixture=t;
      return results;
    }''')
    for result in results: print(result, flush=True)
    browser.close()
    if not all(r['pitchGate'] and r['yawGate'] and r['valid'] for r in results): sys.exit(1)
