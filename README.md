# GoldSrc HLTV Tools

Record HLTV demos from Half-Life servers without opening the game, then replay them in 3D in your browser: watch through any player's eyes, look through walls, check what the server's hitboxes saw, scan for wallhack-style aiming, and cut the demo into a video with camera paths, picture in picture and the game's own sound.

Built and tested on **Team Fortress Classic**. Half-Life, Counter-Strike 1.6, Day of Defeat and other GoldSrc mods use the same demo format, so recording and the basic replay work there too. The TFC-specific parts (player classes, weapon effects, flags) won't be as complete.

Everything is Python's standard library plus a web page. Nothing is installed into the game, and the game's files are read straight from your own Half-Life folder (none are included here).

## What it does

**Recorder** (`Record HLTV.bat`)
- Runs Valve's own `hltv.exe` hidden, joins a game server (or someone else's HLTV proxy), and records every map.
- Files each finished demo as `<date>_<time>_<map>.dem` with a player list next to it: names and name changes, SteamIDs and Steam profile links, teams, classes, time on the server, kills/deaths, chat and the kill log.
- Keeps `players_index.csv`, one row per player per demo, so you can find every demo someone is in by their SteamID.
- Repairs demos that were cut off (crash, power cut). If the server goes away for more than 3 minutes, it files the demo so far and reconnects on its own, starting a new demo when the server is back.
- Can record several servers at once, stop after a set number of hours, and keeps the PC from idle-sleeping while it runs.

**Demo viewer** (`Demo Viewer.bat`)
- 3D replay on the real map, with its textures and lighting, and the game's player models animated the way the TFC client does it: classes, team colours, spy disguises, weapons, running legs, crouching, dying. It also draws corpses, carried flags and glowing flags.
- Play, pause, rewind, 0.1× to 16× speed, frame stepping, bookmarks and a timeline with the kills marked.
- Views: a player's own eyes (with their first-person weapon), Follow, a free-flying camera, top-down, and **picture in picture** (a second view in a corner).
- **X-ray**: everyone glows through walls in their team colour. **Aim lines**: where each player is aiming, and whether it's at an enemy behind a wall.
- **Hitboxes** as the server tests them, including the server's **lag compensation** (where the enemies were on the shooter's screen, which can be turned off). Each bullet shows the box it went through.
- **Review** tab: scans the whole demo for *wall tracks* (the crosshair following an enemy who is behind solid wall) and *snaps* (very fast turns onto a head right before a shot), and lists per player how many bullets went through an enemy and how many were headshots.
- Game sound (footsteps, gunfire, explosions...) heard from the camera, following the engine's own volume, falloff and stereo rules. Weapon effects: explosions, rockets, grenades, sentries, flames, tracers, blood and more.
- Players, kills and chat lists. Health and armor where the demo has them (see [below](#health-and-armor)).

**Video editor** (the viewer's Edit tab)
- Shots: a player's eyes, Follow, top-down, or **dolly** camera paths through keyframes that can pan to track a player and zoom.
- Per-shot slow motion, blends between shots, and a picture-in-picture inset (for example the victim's eyes).
- **Auto POV**: cuts to the killer's eyes before each kill.
- Exports **MP4 or MOV** at up to 4K and 60 fps with the game sound and optional overlays (kill feed, names, crosshair, captions, chat, health HUD). Every frame is rendered exactly, and a quality check after each export tells you if any part came out blocky.

**HLTV Vitals server plugin** (optional, `plugin/hltv_vitals`)
- A metamod plugin for servers you run. It adds every player's health and armor to what HLTV receives, so your HLTV demos have them.

## Requirements

- **Windows 10 or 11** for the recorder (`hltv.exe` is a Windows program). The viewer itself is plain Python and a web page.
- **Python 3.9 or newer** (tested with 3.12). No extra packages.
- **Half-Life on Steam** with the mod you record (e.g. Team Fortress Classic). `hltv.exe` comes with Half-Life, in its main folder.
- A current **Chrome, Edge or Firefox** for the viewer (it needs WebGL 2). For video export Chrome or Edge give the best picture and smaller files; Firefox works too.

## Install

1. Install Python from [python.org](https://www.python.org/downloads/windows/). The installer's **py launcher** option (on by default) is enough. Also ticking "Add python.exe to PATH" does no harm.
2. Download this repository (**Code → Download ZIP**, then unzip it anywhere) or clone it:
   ```
   git clone https://github.com/lazydaydreamer12-collab/goldsrc-hltv-tools.git
   ```
3. Open `hltv_recorder.ini` in a text editor and check `halflife_dir`. It must be your Half-Life folder, the one with `hltv.exe` and `hl.exe` in it. The default is Steam's standard location. If Steam keeps your games elsewhere, it's the `steamapps\common\Half-Life` folder of that library.

That's all. Both tools find the maps, models, sounds and sprites in that folder (and its mod folders such as `tfc` and `tfc_downloads`).

## Recording

1. In `hltv_recorder.ini`, set `address` to the server to record, as `ip:port`. To join someone else's HLTV instead, use the HLTV's address (and `proxy_password` if it has one).
2. Double-click **Record HLTV.bat**. The window shows the connection and a status line every 30 seconds. `hltv.exe` itself stays hidden.
3. To stop, press **Ctrl+C** in that window. The current demo is filed straight away. If you close the window instead, HLTV still finishes the demo properly, and it gets filed the next time you start the recorder.

Finished demos go to `Recordings\`:

| File | What it is |
|---|---|
| `2026-01-31_20-15-00_2fort.dem` | The demo. It plays in the viewer, and in Half-Life with `viewdemo`. |
| `2026-01-31_20-15-00_2fort_players.txt` | Everyone seen: name changes, STEAM_0 ID, SteamID64, profile link, team, classes, time on the server, K/D, then the chat log and the kill log. |
| `players_index.csv` | One row per player per demo. Search it for a SteamID to find every demo someone is in. |

Command line options (run `py -3 -I hltv_recorder.py ...` in the folder):

| Option | |
|---|---|
| `--connect 1.2.3.4:27015` | Record this server instead of the ones in the ini. |
| `--hours 2` | Stop by itself after 2 hours and file the last demo. |
| `--finalize <demo.dem>` | Write a player list for a demo you already have (it's copied into `Recordings\`). |
| `--config <file.ini>` | Use another settings file. |

Notes:
- The recorder takes one player slot on the game server and shows on the scoreboard under `name`. The server must allow proxies (`sv_proxies 1`, the default).
- A direct connection records in real time at up to `updaterate` snapshots a second (the server's `sv_maxupdaterate` caps it). Through someone else's HLTV, their proxy sets the delay, and usually sends about 18–20 a second.
- SteamIDs come from the server's player info. Bots and LAN players have none.
- `hltv.exe`'s own console log goes to `Half-Life\valve\hltvrec_<name>_console.txt`. Lines that matter (rejected, bad password, dropped) are repeated in the recorder window.
- To record several servers at once, add more `[server:<name>]` sections to the ini, each with its own `hltv_port`.

## Viewing

Double-click **Demo Viewer.bat**. Your browser opens on `http://127.0.0.1:27500/` with a list of demos from `Recordings\` and from your Half-Life mod folders. You can also drop a `.dem` onto the page, or onto the .bat file. The first time a demo is opened it's decoded (a few seconds, up to half a minute for a long client demo) and cached in `cache\`. The viewer only listens on your own PC.

The page has the 3D view, a sidebar (Players, Kills, Chat, Review, Edit), and the timeline at the bottom: drag to scrub. Red ticks are kills, orange marks are review leads, and white lines are your bookmarks.

### Controls

| Key | |
|---|---|
| Space | Play / pause |
| R | Play backwards / forwards |
| ← → | Jump 5 s (Shift: 15 s) |
| , . | One frame back / forward |
| [ ] | Slower / faster (0.1× to 16×) |
| Home / End | Start / end |
| B | Bookmark this moment |
| 1 2 3 4 | Eyes / Follow (drag to orbit, wheel to zoom) / Free camera (drag to look, WASD to fly, Q/E down/up, Shift fast) / Top-down |
| Tab, Shift+Tab | Next / previous player (or click a player, in the 3D view or the list) |
| X | X-ray |
| L | Aim lines |
| N | Name tags |
| K | Hitboxes |
| U | Lag compensation on / off |
| J | Picture in picture on / off |
| M | Mute / unmute |
| 9 0 | Free camera: zoom out / in |
| C | Edit tab: camera keyframe |
| I O | Edit tab: video start / end |
| P | Edit tab: preview the edit |
| H | All controls |

### What you can look at

- **Players tab**: everyone in the demo, grouped by team, in an order that never changes, so rows don't move under the mouse. A row flashes gold on a kill and red on a death. Click to watch, double-click for their eyes. The card at the top has Eyes, Follow, **PiP**, Copy ID and the Steam profile.
- **Kills tab**: click a kill to watch the 4 seconds before it through the killer's eyes.
- **Picture in picture** (J): **PiP** on a player's card puts their eyes in a corner. **Target** shows whoever the main player's crosshair is on, which is handy for reviewing someone: their eyes big, the enemy they're tracking small. Hover the inset to switch it to Eyes, Follow or Top, move or resize it, swap it with the main view (or click it), or close it.
- **X-ray and aim lines**: with X-ray on, an aim line carries on through walls as a dashed line, and turns red when it crosses an enemy hidden behind that wall.
- **Hitboxes** (K): wireframes coloured by body part (head filled red). They're posed the way the server poses them for a shot, which isn't quite the model you see: in TFC the server uses the scout's skeleton for every class, the legs don't run, and the body faces where the player looks. When someone fires, the box the centre of their aim went through flashes and gets a tag ("head", "left arm"...).
  - **Lag compensation** (U): before testing a human's shot, the server moves everyone else back to where they were on that player's screen, by their ping plus about 0.1 s. The viewer does the same, and in Eyes view draws the boxes there. Bots get none. On real public-server recordings this doubles how many kill shots line up with the victim's boxes (37% → 72%).
  - Shotgun and assault cannon spread isn't modelled, only the centre of the aim, and a demo only has a snapshot every 16–55 ms. So a single "head" tag isn't proof either way.
- **Review tab**: lists wall tracks and snaps (for human players using the lag-compensated positions), and the bullets-vs-hitboxes counts. Click an entry to watch it in Eyes view with X-ray on. These are **leads to watch, not proof**: good players pre-aim corners and follow footsteps. A cheater tends to show up as many long tracks, often with shots or kills while the enemy is still hidden.
- **Sound** (slider in the header, M mutes) plays while the demo runs forward at up to 2×. Your browser only allows sound after you click somewhere on the page.

HLTV demos contain every player all the time, so they're the ones to use for reviewing someone. Client demos (recorded in the game with `record`) only contain what the recording player's game was sent.

### Health and armor

The game sends each player's health and armor only to that player:
- A **client demo** has the health and armor of the player who recorded it.
- An **HLTV demo** normally has nobody's, unless the server runs the HLTV Vitals plugin (below).

Where they're available, they show in Eyes view, in the Players list, on name tags, and as a HUD in exported videos.

## Making videos (Edit tab)

An edit is a list of shots. Each shot starts at a moment of the demo and runs until the next, and says where the camera is. Edits are saved by themselves (`edits\<demo>.json`).

1. Set up a view and press **+ Shot from this view**:
   - **Eyes**: through a player's eyes, with their weapon and crosshair.
   - **Follow**: a smoothed camera behind a player (distance, height and angle sliders).
   - **Top-down**: from above.
   - **Dolly**: in Free view, go to a moment, place the camera and press **C**. Go to a later moment, move the camera and press **C** again, and so on. The camera glides through the keys on a smooth curve, can **Track** a player (a panning shot), and keeps each key's zoom.
2. Click a shot to change its camera or player, its **speed** (0.1× slow motion to 4×), how it starts (cut, or a blend from the previous shot), and its **inset**: a picture-in-picture view of a player, of the victim of that shot's next kill, or of whoever they aim at.
3. **Auto POV** builds the shots for you. It cuts to the killer's eyes a few seconds before each kill (every kill, or one player's), with the victim's eyes in the inset, and follows the next killer through quiet stretches. A shot stays on long enough that busy fights don't flicker.
4. The bar at the top says what will be exported, e.g. *Video: 16:47 → 16:53 · 0:09 long*. Without In/Out it's your first shot to the end of your last one. **I** / **O** set the start and end, **Video = this shot** exports one shot, and **P** previews.
5. Pick the size (720p to 4K), frame rate, MP4 or MOV, quality and overlays, and press **Export video**. The file goes to `Exports\`; **Watch** plays it and **Show in folder** opens it.

About the export:
- Frames are rendered one by one at exactly the chosen size and rate, so the video is smooth on any PC. 1080p60 renders at roughly real time.
- Encoding uses the browser's built-in H.264 encoder (WebCodecs); a small Python writer puts the result into the .mp4/.mov file. The sound is mixed offline with the same rules as live playback.
- Sound is AAC in Chrome and Edge. Firefox has no AAC encoder, so there an MP4 gets Opus sound and a MOV gets uncompressed sound (the best choice for video editors).
- Firefox's encoder runs short in busy moments in its normal mode, so in Firefox the export uses a constant data rate: sharper, but bigger files. The settings show the expected size.
- After each export, a quality check reads how hard each frame was compressed and says *clean all the way through*, or where it went blocky.

## HLTV Vitals plugin (optional, servers you run)

`plugin/hltv_vitals` is a small [metamod](https://github.com/Bots-United/metamod-p) plugin:
- About 10 times a second, it sends the health and armor of every player whose values changed, and everyone's once a second.
- It sends only to connected HLTV proxies: players never receive it, and nothing is sent while no HLTV is connected.
- Every demo HLTV records then carries everyone's health and armor, and the viewer shows them.

To build it (Windows, Visual Studio with C++):
1. Put the `hltv_vitals` folder inside a metamod-p SDK checkout, next to its `metamod` and `hlsdk` folders. The project looks for headers in `..\metamod` and `..\hlsdk\{common,dlls,engine,pm_shared}`. HL SDK headers are in [ValveSoftware/halflife](https://github.com/ValveSoftware/halflife).
2. Build **Release | Win32**. If the SDK sits at `<Half-Life>\tfc\addons\metamod\metamod_sdk`, the build copies the DLL to `tfc\addons\hltv_vitals\hltv_vitals_mm.dll`. Otherwise copy `bin\Release\hltv_vitals.dll` there under that name yourself.
3. Add `win32 addons\hltv_vitals\hltv_vitals_mm.dll` to `tfc\addons\metamod\plugins.ini` and restart the server.

It only helps on servers you run, and only demos recorded while it's on have the data.

## Settings (`hltv_recorder.ini`)

| Key | |
|---|---|
| `[recorder] halflife_dir` | Your Half-Life folder (with `hltv.exe`). The viewer reads it too. |
| `[recorder] output_dir` | Where finished demos go (default `Recordings`, next to the ini). |
| `[recorder] label_in_filename` | Add the server's label to file names (when recording several servers). |
| `[server:<label>] address` | The server, or HLTV proxy, to join: `ip:port`. |
| `password` / `proxy_password` | The game server's password / the HLTV proxy's password, if any. |
| `hltv_port` | Local UDP port for this recorder's hltv.exe (different per server). |
| `name` | The name HLTV shows on the scoreboard. |
| `updaterate`, `rate`, `delay` | Snapshots per second, bandwidth, and broadcast delay for direct connections. |

## Files

| File | |
|---|---|
| `Record HLTV.bat`, `hltv_recorder.py`, `hltv_recorder.ini` | The recorder. |
| `Demo Viewer.bat`, `demo_viewer.py` | The viewer's local web server (127.0.0.1:27500). |
| `goldsrc_demo.py` | Demo decoder: delta-compressed entities, user messages, events, userinfo. `py -3 -I goldsrc_demo.py <demo>` prints a summary. |
| `bsp.py`, `mdl.py`, `gamefiles.py` | Map, studio model, sound and sprite loaders/converters. |
| `mp4mux.py`, `h264qp.py` | The video file writer, and the per-frame quality check. |
| `web/` | The viewer page: `viewer.js` (replay, review), `studio.js` (models), `fx.js` (effects), `audio.js` (sound), `editor.js` (Edit tab). |
| `docs/tfc_events.md` | What TFC's client plays for each weapon and explosion event, which the viewer follows. |
| `plugin/hltv_vitals/` | The optional server plugin. |

Created while you use it (not part of the repository): `Recordings\`, `cache\`, `edits\`, `Exports\`, `hltv_recorder.log`.

## Privacy

Recordings and player lists hold other people's names, SteamIDs and chat. They stay on your PC, in the folders above, which `.gitignore` keeps out of git. Think twice before publishing them. The viewer's server only listens on `127.0.0.1`, so nothing else on your network can reach it.

## Limitations

- Not drawn: bullet holes and scorch marks, spray logos, shell casings, gibs, dynamic lights. Recoil, view bob and sniper zoom aren't in the recording.
- The review scans give leads, not verdicts.
- The recorder is Windows-only. Other GoldSrc mods replay, but their weapon effects and class details aren't covered.

## License

The recorder, viewer and editor are under the [MIT License](LICENSE). The HLTV Vitals plugin in `plugin/hltv_vitals` is under the GNU GPL version 2, with Metamod's Half-Life linking exception (see [its license](plugin/hltv_vitals/LICENSE) and [README](plugin/hltv_vitals/README.md#license)).

## Credits

- Demo and network formats follow Valve's HLTV proxy as rebuilt in [ReHLDS](https://github.com/dreamstalker/rehlds), and the engine's rules as seen in it.
- Player model posing, studio rendering and TFC's class/disguise rules follow Valve's [Half-Life SDK](https://github.com/ValveSoftware/halflife) (`cl_dll/StudioModelRenderer.cpp`).
- TFC's client-side weapon events were reverse-engineered from the game's `client.dll` with [Ghidra](https://ghidra-sre.org/) (see `docs/tfc_events.md`).

Half-Life, Team Fortress Classic and HLTV are Valve's. This project isn't affiliated with or endorsed by Valve, and includes none of their game content: it reads your own installed copy.
