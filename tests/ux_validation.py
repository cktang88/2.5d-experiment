#!/usr/bin/env python3
"""Browser-level checks and unmodified screenshots for the cutter/build/wave UX.

Run against the local Vite server with:
  python tests/ux_validation.py [http://127.0.0.1:5173/]

The test starts a real browser game, then uses a controlled in-memory voxel patch and
game-time stepping so the checks are repeatable. Nothing is written to the saved game.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/screenshots/controls"
OUT.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/"
checks, errors = {}, []


def require(name, result):
    checks[name] = bool(result)
    print(name, bool(result), flush=True)
    if not result:
        raise AssertionError(name)


def capture(page, name):
    page.evaluate("game.ui.update(0); game.camera.updateMatrixWorld(); game.composer.render()")
    page.screenshot(path=str(OUT / f"{name}.jpg"), type="jpeg", quality=88, timeout=90000)
    print("screenshot", name, flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        executable_path="/usr/bin/chromium", headless=True,
        args=["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-dev-shm-usage"],
    )
    page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(URL, wait_until="domcontentloaded")
        page.locator("#newgame").wait_for(state="visible", timeout=120000)
        page.click("#newgame", timeout=30000)
        page.wait_for_function("window.game?.started && document.pointerLockElement === game.canvas", timeout=60000)
        page.evaluate("game.renderer.setAnimationLoop(null); game.qualityLevel=3; game.aoOn=false; game.shaftsOn=false; game.onResize(); game.ao.configuration.intensity=0; game.step(.016)")

        startup = page.evaluate("""() => ({phase: game.waveDirector.phase, wave: game.waveDirector.wave,
          remaining: game.waveDirector.remaining, enemies: game.entities.enemies.filter(e => !e.dead).length,
          objective: document.querySelector('#objective').textContent,
          cutter: document.querySelector('#tool-cutter')?.classList.contains('sel')})""")
        print("startup", startup, flush=True)
        require("new_game_starts_in_peace_with_cutter_selected", startup["phase"] == "safe" and startup["wave"] == 0 and 119.9 <= startup["remaining"] <= 120 and startup["enemies"] == 0 and "2:00" in startup["objective"] and startup["cutter"])
        capture(page, "04-buildtime-hud")
        page.evaluate("game.simulate(1.0, 1/30)")
        require("first_active_second_has_no_enemies", page.evaluate("game.waveDirector.phase === 'safe' && game.entities.enemies.filter(e => !e.dead).length === 0"))
        page.evaluate("game.step(.016)")
        early = page.locator("#start-wave-early")
        require("early_wave_offer_is_obvious_and_uses_remaining_grace", early.is_visible() and "T · Start Wave 1 early" in early.inner_text() and "+50%" in early.inner_text())
        before_early = page.evaluate("({wood:game.inv.wood,stone:game.inv.stone,metal:game.inv.metal,goo:game.inv.goo})")
        page.keyboard.press("KeyT")
        page.wait_for_function("game.waveDirector.phase === 'wave' && game.waveDirector.wave === 1")
        page.evaluate("game.step(.016)")
        started_early = page.evaluate("({bonus:game.waveDirector.rewardBonus,alive:game.entities.enemies.filter(e=>!e.dead).length,wood:game.inv.wood,stone:game.inv.stone,metal:game.inv.metal,goo:game.inv.goo})")
        require("early_start_begins_wave_without_upfront_reward", started_early["bonus"] > 0 and started_early["alive"] == 10 and all(started_early[k] == before_early[k] for k in before_early))
        page.keyboard.press("KeyT")
        require("t_does_not_duplicate_an_active_wave", page.evaluate("game.waveDirector.wave === 1 && game.entities.enemies.filter(e=>!e.dead).length === 10"))
        require("early_start_offer_hides_during_active_wave", early.is_hidden())
        page.evaluate("game.entities.enemies.forEach(e => {e.dead=true; e.removeSprite()}); game.step(.016)")
        payout = page.evaluate("({phase:game.waveDirector.phase,remaining:game.waveDirector.remaining,bonus:game.waveDirector.rewardBonus,wood:game.inv.wood,stone:game.inv.stone,metal:game.inv.metal,goo:game.inv.goo})")
        require("early_reward_is_granted_once_on_clear", payout["phase"] == "rest" and payout["remaining"] == 120 and payout["bonus"] > 0 and payout["wood"] > before_early["wood"] and payout["stone"] > before_early["stone"] and payout["metal"] > before_early["metal"] and payout["goo"] > before_early["goo"])
        saved_wave = page.evaluate("game.waveDirector.snapshot()")
        restored_bonus = page.evaluate("(s) => { game.waveDirector.restore(s); return game.waveDirector.snapshot().rewardBonus; }", saved_wave)
        require("cleared_wave_bonus_survives_restore", restored_bonus == saved_wave["rewardBonus"])
        page.wait_for_function("!document.querySelector('#upgrade').classList.contains('hidden')")
        page.locator("#uplist .up").first.click()
        page.wait_for_function("document.querySelector('#upgrade').classList.contains('hidden') && document.pointerLockElement === game.canvas")

        # The visible Q build menu, custom box dimensions and budget feedback.
        page.keyboard.press("KeyQ")
        page.wait_for_function("game.construction.panelOpen && !document.pointerLockElement")
        print("build_picker", {"visible": page.locator("#build-menu").is_visible(), "count": page.locator("#build-shapes .buildshape").count(), "text": page.locator("#build-shapes").inner_text()}, flush=True)
        require("build_menu_visible_from_q_and_named_presets", page.locator("#build-menu").is_visible() and page.locator("#build-shapes .buildshape").count() >= 8 and "Custom wall / platform" in page.locator("#build-shapes .buildshape").nth(7).inner_text())
        page.locator('#build-shapes [data-index="7"]').click()
        page.locator("#build-width").fill("7")
        page.locator("#build-height").fill("4")
        page.locator("#build-depth").fill("2")
        require("custom_7x4x2_costs_56_and_shows_shortage", "56 planks" in page.locator("#build-cost").inner_text() and "need 32 more" in page.locator("#build-cost").inner_text())
        capture(page, "02-builder-dimensions-picker")
        page.locator("#build-width").fill("65")
        require("invalid_dimension_is_visible_and_preserves_resources", "whole number" in page.locator("#build-validation").inner_text() and page.evaluate("game.inv.planks === 24"))
        page.locator('#build-shapes [data-index="1"]').click()
        require("switching_preset_recovers_from_invalid_custom_dimensions", "Select a building block" in page.locator("#build-validation").inner_text() and page.locator("#build-width").is_hidden())
        page.locator('#build-shapes [data-index="7"]').click()
        page.locator("#build-width").fill("7")
        page.locator("#build-height").fill("4")
        page.locator("#build-depth").fill("2")
        page.locator("#build-rotate").click()
        require("custom_orientation_control_changes_rotation", page.evaluate("game.construction.rotation === 1 && game.construction.dimensions.join(',') === '7,4,2'"))
        # Build menu time is frozen even when stepping the actual game loop.
        page.evaluate("game.waveDirector.remaining = .5; game.step(1)")
        require("build_menu_freezes_wave_timer", page.evaluate("game.waveDirector.phase === 'rest' && game.waveDirector.remaining === .5 && game.entities.enemies.length === 0"))
        before_planks = page.evaluate("game.inv.planks")
        page.locator("#build-use").click()
        page.wait_for_function("!game.construction.panelOpen && document.pointerLockElement === game.canvas")

        # Create a tiny flat supported work site in memory. This does not alter saves.
        fixture = page.evaluate("""() => {
          const g=game,w=g.world,p=g.player.pos; const X=Math.floor(p.x)+7,Z=Math.floor(p.z)-8;
          w.generateAround(X,Z,2); let Y=0;
          for(let x=X-12;x<=X+12;x+=3) for(let z=Z-12;z<=Z+12;z+=3) Y=Math.max(Y,w.surfaceY(x,z)); Y+=2;
          for(let x=X-12;x<=X+12;x++) for(let z=Z-12;z<=Z+12;z++) { w.set(x,Y-1,z,1); for(let y=Y;y<=Y+18;y++)w.set(x,y,z,0); }
          w.set(X,Y-1,Z-3,3);
          for(const zz of [Z-6,Z-8]) for(let yy=Y;yy<=Y+2;yy++) w.set(X+9,yy,zz,6);
          w.set(X+9,Y+2,Z-4,5);
          w.rebuildAround(X,Z,2);
          window.site={X,Y,Z};
          window.pose=(x,y,z,tx,ty,tz)=>{g.player.pos.set(x,y,z);g.player.vel.set(0,0,0);const dx=tx-x,dy=ty-(y+1.55),dz=tz-z;g.camYaw=g.camYawT=Math.atan2(-dx,-dz);g.camPitch=Math.atan2(dy,Math.hypot(dx,dz));g.updateCamera(0);g.updateAim();g.updateReticle();};
          window.captureGame=()=>{g.ui.update(0);g.camera.updateMatrixWorld();g.composer.render();};
          pose(X+.5,Y,Z+2.5,X+.5,Y+1.55,Z-3);
          g.waveDirector.phase='safe';g.waveDirector.wave=0;g.waveDirector.remaining=120;
          return {X,Y,Z};
        }""")

        # Switch back to a custom dimension set and place it with the live build preview.
        page.keyboard.press("KeyQ")
        page.wait_for_function("game.construction.panelOpen")
        page.locator('#build-shapes [data-index="7"]').click()
        page.locator("#build-width").fill("7")
        page.locator("#build-height").fill("4")
        page.locator("#build-depth").fill("2")
        page.locator("#build-rotate").click()
        page.locator("#build-use").click()
        page.wait_for_function("!game.construction.panelOpen && document.pointerLockElement === game.canvas")
        page.evaluate("""() => { const g=game,{X,Y,Z}=site; pose(X+.5,Y,Z+2.5,X+.5,Y-.5,Z-3); g.select(5); g.construction.selectPreset(7); g.construction.setCustomDimensions(7,4,2); g.construction.rotate(); g.updateAim(); g.updateActions(0); }""")
        budget = page.evaluate("({valid:game.construction.valid,cost:game.construction.cost,available:game.inv.planks,reason:game.construction.validationMessage})")
        require("out_of_budget_custom_preview_is_rejected", not budget["valid"] and budget["cost"] == 56 and budget["available"] == 24 and "Need 56 planks" in budget["reason"])
        page.evaluate("game.input.lmbPressed=true; game.updateActions(.016)")
        require("rejected_build_attempt_spends_no_materials", page.evaluate("game.inv.planks === 24"))
        page.evaluate("game.inv.planks=999; game.inv.bricks=999; game.updateActions(0)")
        preview = page.evaluate("""() => ({visible:game.construction.preview.visible,count:game.construction.preview.count,
          valid:game.construction.valid,rotation:game.construction.rotation,material:game.construction.preview.material.color.getHex(),
          mode:game.construction.mode,selected:game.hotbar[game.sel].id,hover:game.hover&&[game.hover.x,game.hover.y,game.hover.z],
          validation:game.construction.validationMessage,craft:game.ui.craftOpen,paused:game.paused})""")
        print("live_preview", preview, flush=True)
        require("live_custom_wall_preview_visible_with_orientation", preview["visible"] and preview["count"] == 56 and preview["rotation"] == 1 and preview["valid"])
        capture(page, "03-live-wall-preview")
        page.evaluate("game.input.lmbPressed=true; game.updateActions(.016)")
        placed = page.evaluate("""() => ({spent: game.inv.planks, solid: game.construction.preview.count,
          cells: game.construction.cells?.length ?? game.construction.preview.count})""")
        require("custom_7x4x2_build_places_56_cells", placed["spent"] == 943 and placed["cells"] == 56)
        # A 192-cell preview must grow beyond the old 128-instance limit.
        capacity = page.evaluate("""() => {game.construction.setCustomDimensions(8,8,3);game.construction.update(game.hover,8,'planks');
          return {count:game.construction.preview.count,capacity:game.construction.preview.instanceMatrix.count};}""")
        require("preview_capacity_grows_above_128_cells", capacity["count"] == 192 and capacity["capacity"] >= 192)

        # Exercise the cutter through pointer lock and real mouse hold against two occluded logs.
        page.keyboard.press("KeyF")
        page.evaluate("""() => {const {X,Y,Z}=site; pose(X+9.5,Y,Z+.5,X+9.5,Y+1.55,Z-6); game.updateAim();game.updateActions(0);} """)
        context = page.locator("#toolcontext")
        require("cutter_context_names_target_range_and_hold_action", context.is_visible() and "LASER CUTTER" in context.inner_text() and "Hold LMB to cut" in context.inner_text() and "8 m range" in context.inner_text())
        require("cutter_targets_nearest_occluding_log", page.evaluate("game.laserTarget?.x === site.X+9 && game.laserTarget?.z === site.Z-6 && game.camera.position.distanceTo(game.laserTarget.point) <= 8"))
        page.mouse.down()
        page.evaluate("game.updateActions(.12)")
        page.evaluate("game.updateActions(0)")
        require("held_cut_shows_visible_beam_and_progress", page.evaluate("game.laserBeam.visible && game.laserImpact.visible && Number(document.querySelector('#toolcontext .toolprogress i').style.width.replace('%','')) > 0"))
        capture(page, "01-cutter-beam")
        page.mouse.up()
        wood_before = page.evaluate("game.inv.wood")
        page.evaluate("game.input.lmb=true; game.simulate(.3,.05); game.input.lmb=false")
        require("cutter_damages_near_log_without_touching_visible_far_log", page.evaluate("game.world.get(site.X+9,site.Y+1,site.Z-6) === 6 && game.world.get(site.X+9,site.Y+1,site.Z-8) === 6 && game.world.damage.get(game.world.idx(site.X+9,site.Y+1,site.Z-6)) > 0 && !game.world.damage.get(game.world.idx(site.X+9,site.Y+1,site.Z-8))"))
        page.evaluate("game.updateAim(); game.input.lmb=true; game.updateActions(.12); game.input.lmb=false")
        require("cutter_collects_wood_when_target_breaks", page.evaluate("(n) => game.world.get(site.X+9,site.Y+1,site.Z-6) === 0 && game.world.get(site.X+9,site.Y+1,site.Z-8) === 6 && game.inv.wood > n", wood_before))
        page.evaluate("""() => {const {X,Y,Z}=site;pose(X+9.5,Y,Z+4,X+9.5,Y+1.55,Z-6);game.updateAim();game.updateActions(0);} """)
        require("cutter_rejects_targets_past_eight_meters", "Out of range" in context.inner_text() and page.evaluate("!game.laserBeam.visible"))
        page.evaluate("""() => {const {X,Y,Z}=site; pose(X+9.5,Y+2,Z-1,X+9.5,Y+2.5,Z-4);game.updateAim();game.updateActions(0);} """)
        require("cutter_explains_bedrock_block", "Bedrock cannot be cut" in context.inner_text())

        # Use the live step path to start a finite wave, clear it, and verify the rest timer.
        page.evaluate("""() => {const g=game;g.player.pos.set(site.X+.5,site.Y,site.Z+2);g.waveDirector.remaining=.1;g.updateCamera(0);g.step(.2);} """)
        wave = page.evaluate("({phase:game.waveDirector.phase,wave:game.waveDirector.wave,alive:game.entities.enemies.filter(e=>!e.dead).length})")
        require("expired_grace_spawns_finite_wave_through_game_loop", wave["phase"] == "wave" and wave["wave"] == 1 and wave["alive"] == 10)
        page.evaluate("game.entities.enemies.forEach(e => {e.dead=true; e.removeSprite()}); game.step(.016)")
        rest = page.evaluate("({phase:game.waveDirector.phase,remaining:game.waveDirector.remaining,objective:document.querySelector('#objective').textContent})")
        require("last_enemy_clear_starts_two_minute_intermission", rest["phase"] == "rest" and rest["remaining"] == 120 and "2:00" in rest["objective"])
        boss_retry = page.evaluate("""() => {const e=game.entities.enemies.length,t=game.timers.length;game.spawnBoss();
          return {quiet:game.waveDirector.phase==='rest',enemies:game.entities.enemies.length===e,timers:game.timers.length===t};}""")
        require("delayed_boss_retry_cannot_interrupt_quiet_intermission", boss_retry["quiet"] and boss_retry["enemies"] and boss_retry["timers"])
        page.wait_for_function("!document.querySelector('#upgrade').classList.contains('hidden')")
        page.locator("#uplist .up").first.click()
        page.wait_for_function("document.querySelector('#upgrade').classList.contains('hidden') && document.pointerLockElement === game.canvas")
        page.keyboard.press("Escape")
        page.wait_for_function("game.paused && !document.pointerLockElement")
        page.evaluate("game.waveDirector.remaining=.5; game.step(1)")
        require("pause_menu_freezes_wave_timer", page.evaluate("game.waveDirector.phase === 'rest' && game.waveDirector.remaining === .5"))
        page.locator("#pause h1").click()
        require("menu_clicks_do_not_fire_or_spend_build_materials", page.evaluate("game.inv.planks === 943 && game.inv.shells === 16 && game.paused && game.input.lmb === false"))
        require("no_page_errors", not errors)
    finally:
        (OUT / "results.json").write_text(json.dumps({"url": URL, "controlled_fixture": True, "checks": checks, "pageErrors": errors}, indent=2) + "\n")
        browser.close()
