# TFC client-side weapon events

What TFC's own `tfc/cl_dlls/client.dll` plays when an event arrives (reverse-engineered with Ghidra, client.dll
sha256 dd7abd2b…2971). The viewer's `web/fx.js` follows this table. Sound calls are
`EV_PlaySound(ent, origin, channel, sample, volume, attenuation, flags, pitch)`; attenuation is 0.8 (ATTN_NORM)
unless noted. `rand(a,b)` is the engine's RandomLong.

Event hooks are registered in `FUN_1000e340`.

| Event | Handler | Sound (channel, volume, pitch) | Visuals |
|---|---|---|---|
| wpn/tf_sg | 10006300 | weapons/sbarrel1.wav (1, 0.95-1.0, 93+rand(0,31)) | shotgunshell.mdl shell, 6 pellets, spread 0.04 |
| wpn/tf_ssg | 10006890 | weapons/shotgn2.wav (1, 0.95-1.0, 93+rand(0,31)) | shell, 14 pellets, spread 0.04 |
| wpn/tf_sgpump | 10006a90 | weapons/scock1.wav (3, 1.0, 95+rand(0,31)) | |
| wpn/tf_sgreload | 10006b30 | weapons/reload1.wav or reload3.wav (3, 1.0, 85+rand) | |
| wpn/tf_sniper | 10006500 | ambience/rifle1.wav (1, 0.9, 100) | trace 8192, impact |
| wpn/tf_ar (auto rifle) | 10005fa0 | weapons/sniper.wav (1, 0.9, 100) | trace 8192, impact |
| wpn/tf_sniperhit | 10008c50 | weapons/ric3.wav / bullet_hit2.wav (bparam1) / common/bodysplat.wav (bparam2), volume iparam1/100 (6) | |
| wpn/tf_nail | 10006170 | weapons/airgun_1.wav (1, 0.95-1.0, 93+rand(0,31)) | nail.mdl projectile, 1000 u/s |
| wpn/tf_snail | 10006720 | weapons/spike2.wav (1, 1.0, 94+rand(0,15)) | nail.mdl projectile, 1000 u/s |
| wpn/tf_rpg | 10007f60 | weapons/rocketfire1.wav (1, 0.9) + weapons/glauncher.wav (3, 0.7) | |
| wpn/tf_ic | 10007ec0 | weapons/sgun1.wav (1, 0.9) | |
| wpn/tf_gl, wpn/tf_pipel | 100084a0, 10008960 | weapons/glauncher.wav (3, 0.7) | |
| wpn/tf_acwu | 100070a0 | stops asscan2/asscan4 (6), asscan3 (1); weapons/asscan1.wav (1, 0.98, 125) | |
| wpn/tf_acstart | 10006e50 | stops 6; weapons/asscan2.wav (6, 0.98, 125) | |
| wpn/tf_acsspin | 10006f00 | stops 6; weapons/asscan4.wav (6, 0.98, 125) | |
| wpn/tf_acwd | 10006fa0 | stops 6 and asscan1 (1); weapons/asscan3.wav (1, 0.98, 125) unless bparam1 | |
| wpn/tf_acfire | 10006c00 | none (asscan2 loops) | shell.mdl, 5 bullets, spread 0.1 |
| wpn/tf_flame | 10008030 | weapons/flmfire2.wav (1, 0.9) when not under water (bparam1 = 0) | sprites/fthrow.spr, 600 u/s; bubble.spr under water |
| wpn/tf_rail | 10008a00 | weapons/railgun.wav (1, 0.9) | rail projectile, 1500 u/s |
| wpn/tf_tranq | 10008e20 | weapons/dartgun.wav (1, 0.9) | nail.mdl dart, 1500 u/s |
| wpn/tf_axe (also spanner, knife, medikit: iparam1) | 10007180 → 10004260 | miss: weapons/cbar_miss1.wav (1, 1.0, 94+rand(0,15)); body: cbar_hitbod1-3.wav (1); world: cbar_hit1-2.wav (3, 98+rand) | |
| wpn/tf_mednormal / medsuper / medsteam | 10008900 / 10008dc0 / 10008d60 | items/medshot4.wav / items/medshot5.wav / ambience/steamburst1.wav (3, 1.0) | |
| explode/tf_pipe, tf_gren | 10007df0, 100083d0 | explosion, magnitude 120 | |
| explode/tf_normalgren, tf_engrgren, tf_ng, tf_mirv, tf_mirvmain | 10008830, 10007d20, 10008550 | explosion, magnitude 180 (scale 7.8) | |
| explode/tf_fire | 10008770 → 10002f40 | explosion at scale 3.0 | |
| explode/tf_burn | 10008710 | | sprites/playerflame.spr on the target |
| explode/tf_gas | 100082a0 | | particle burst (radius 240, colour 195, 2 s) |
| explode/tf_concuss | 100078b0 | weapons/concgren_blast1-3.wav (2, 1.0) | sprites/shockwave.spr ring (beam cylinder, 600 up, 0.2 s) |
| explode/tf_emp | 10007b70 | weapons/emp_1.wav (2, 1.0) | sprites/shockwave.spr ring |
| explode/tf_nailgren | 10008560 | weapons/airgun_1.wav / spike2.wav | nail.mdl spray |
| misc/gibs | 100082f0 | common/bodysplat.wav (1, 1.0) | gibs |

**Explosion** (`FUN_10002ce0`): `sprites/explode01.spr` through the engine's R_Explosion at scale
`(magnitude - 50) * 0.06`, 15 fps, flags 3 (not additive, no dynamic light), so the engine also plays
`weapons/explode3/4/5.wav`; then `weapons/debris1-3.wav` (2, 0.55), a `{scorch1`/`{scorch2` decal, and up to 3 spark
showers when not in water.
