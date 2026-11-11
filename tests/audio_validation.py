from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage'])
 page=b.new_page(); errors=[]; requests=[]; page.on('pageerror',lambda e: errors.append(str(e))); page.on('request',lambda r: requests.append(r.url) if '/audio/' in r.url else None)
 page.goto('http://127.0.0.1:5173/',wait_until='domcontentloaded');page.locator('#newgame').wait_for(state='visible',timeout=120000)
 page.click('#title-settings');page.locator('#audio-music').fill('43');page.locator('#audio-effects').fill('65');page.locator('#settings .panel-close').click();page.click('#newgame');page.wait_for_function('game.started');page.evaluate('game.renderer.setAnimationLoop(null)');page.wait_for_function('game.audio.music.readyState >= 2 || game.audio.music.error',timeout=30000)
 result=page.evaluate('''async () => {
 const g=game,a=g.audio; await new Promise(r=>setTimeout(r,1000)); const musicPlaying=!a.music.paused && a.music.currentTime>0 && a.music.readyState>=2; const mediaDebug={paused:a.music.paused,time:a.music.currentTime,ready:a.music.readyState,network:a.music.networkState,error:a.music.error?.code,gamePaused:g.paused,hidden:document.hidden};
 const analyser=a.ctx.createAnalyser(); a.master.connect(analyser); analyser.fftSize=2048;
 const level=()=>{const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);return Math.max(...data.map(Math.abs));};
 a.setLaser(true);await new Promise(r=>setTimeout(r,100));const laserLevel=level();const laserOn=!!a.laser;a.stopLaser();await new Promise(r=>setTimeout(r,120));const laserOff=!a.laser;
 a.break_();await new Promise(r=>setTimeout(r,80));const breakLevel=level();
 const loaded=!!a.breakBuffer; a.breakBuffer=null; delete a.last.break; a.break_();await new Promise(r=>setTimeout(r,60));const fallbackLevel=level();const volume=a.master.gain.value; const saved=localStorage.getItem('blockfall-audio-music')==='0.43'&&localStorage.getItem('blockfall-audio-effects')==='0.65';
 a.toggleMute();const mute=a.master.gain.value===0 && a.music.volume===0;a.toggleMute();
 const musicElement=a.music;g.togglePause(true);g.step(.016);const timePaused=a.music.currentTime;await new Promise(r=>setTimeout(r,200));const paused=a.music.paused && !a.laser && a.music.currentTime===timePaused;
 g.togglePause(false);a.setPlaying(true);await new Promise(r=>setTimeout(r,300));const musicResumed=a.music===musicElement && !a.music.paused && a.music.currentTime>timePaused;
 const blocks=await import('/src/blocks.ts');
 g.paused=false;const x=Math.floor(g.player.pos.x),y=Math.floor(g.player.pos.y)+3,z=Math.floor(g.player.pos.z);
 g.world.set(x,y,z,blocks.B.STONE);
 g.select(g.hotbar.findIndex(s=>s.tool==='cutter'));g.input.lmb=true;
 g.laserTarget={hit:true,x,y,z,point:g.camera.position.clone(),nx:0,ny:1,nz:0};
 g.updateActions(.001);const cutting=!!a.laser;
 g.laserTarget.point.x+=100;g.updateActions(.001);const outOfRange=!a.laser;
 g.laserTarget.point.x-=100;g.world.set(x,y,z,blocks.B.BEDROCK);g.updateActions(.001);const bedrock=!a.laser;g.world.set(x,y,z,blocks.B.STONE);g.updateActions(.001);g.select(0);const switched=!a.laser;
 g.select(g.hotbar.findIndex(s=>s.tool==='cutter'));g.updateActions(.001);g.input.lmb=false;g.updateActions(.001);const released=!a.laser;
 g.input.lmb=true;g.updateActions(.001);g.togglePause(true);const pauseStops=!a.laser;
 g.paused=false;g.updateActions(.001);g.ui.craftOpen=true;g.step(.016);const modalStops=!a.laser;g.ui.craftOpen=false;g.input.lmb=false;
 let breaks=0;const original=a.break_.bind(a);a.break_=(v)=>{breaks++;original(v)};
 g.world.damageBlock(x,y,z,100000,'laser');const blockHook=breaks===1 && g.world.get(x,y,z)===blocks.B.AIR;
 return {laserLevel,laserOn,laserOff,breakLevel,fallbackLevel,loaded,volume,saved,mute,paused,musicResumed,cutting,outOfRange,bedrock,switched,released,pauseStops,modalStops,blockHook,musicPlaying,mediaDebug,musicReady:a.music.readyState,musicError:a.music.error?.code||0};
 }''');print(result);print('errors',errors,'requests',requests);assert result['laserLevel']>0 and result['breakLevel']>0 and result['fallbackLevel']>0 and all(result[k] for k in ['laserOn','laserOff','loaded','saved','mute','paused','musicResumed','cutting','outOfRange','bedrock','switched','released','pauseStops','modalStops','blockHook','musicPlaying']) and not errors and all(u.startswith('http://127.0.0.1:5173/audio/') for u in requests);print('audio requests',requests);b.close()
