# HLTV Vitals (metamod plugin)

GoldSrc games send a player's health and armor only to that player. An HLTV proxy, and every demo it records, gets nobody's. This plugin fixes that on a server you run: it sends every player's health and armor to connected HLTV proxies, so the demos carry them and the demo viewer can show them.

- Players never receive it. The message goes out with `MSG_SPEC`, which the engine adds only to the datagrams of spectator proxies.
- Nothing is sent while no HLTV is connected.
- At most 10 times a second, it lists the players whose values changed. Once a second it lists everyone, because `MSG_SPEC` is unreliable and a proxy, or a demo it starts, can join at any time.
- Written for Team Fortress Classic. It uses only `pev->health` and `pev->armorvalue`, so it should work on other GoldSrc mods too (untested).

## Build (Windows)

You need Visual Studio with **Desktop development with C++**, which includes the v143 or newer toolset. Any recent version works: the project uses whatever toolset your Visual Studio has.

1. Get the headers:
   - [metamod-p](https://github.com/Bots-United/metamod-p): its `metamod` folder (`meta_api.h` and friends).
   - [Half-Life SDK](https://github.com/ValveSoftware/halflife): its `common`, `dlls`, `engine` and `pm_shared` folders, in a folder named `hlsdk`.
2. Lay them out like this, with this folder next to them:
   ```
   metamod_sdk\
     hlsdk\common, dlls, engine, pm_shared
     metamod\
     hltv_vitals\        <- this folder
   ```
3. Open `hltv_vitals.vcxproj` and build **Release | Win32** (servers are 32-bit). Or from a Developer Command Prompt:
   ```
   msbuild hltv_vitals.vcxproj /p:Configuration=Release /p:Platform=Win32
   ```
   The DLL is `bin\Release\hltv_vitals.dll`. It's statically linked, so the server doesn't need the VC++ redistributable.

If `metamod_sdk` sits inside the server's metamod folder (`<mod>\addons\metamod\metamod_sdk\`), the build also copies the DLL to `<mod>\addons\hltv_vitals\hltv_vitals_mm.dll` for you.

## Install

1. Copy the DLL to `<mod>\addons\hltv_vitals\hltv_vitals_mm.dll` (e.g. `tfc\addons\hltv_vitals\`).
2. Add this line to `<mod>\addons\metamod\plugins.ini`:
   ```
   win32 addons\hltv_vitals\hltv_vitals_mm.dll
   ```
3. Restart the server. On the server console, `meta list` shows **HLTV Vitals** as running.

The message is registered when a map starts, so HLTV must connect, or reconnect, after the plugin has loaded. Otherwise the message is missing from that map's demo.

## Message format

The user message is `HltvVitals`, with variable length. It holds one entry per player listed:

| Field | Type | |
|---|---|---|
| slot | byte | Player slot, 1–32 |
| health | short | Never negative. Between 0 and 1 counts as 1, as in the HL SDK's own Health message. |
| armor | short | `pev->armorvalue` |

`goldsrc_demo.py` decodes it (`u_hltvvitals`). Playing such a demo back in the game itself (`viewdemo`), or watching the HLTV live with a game client, hasn't been tested with the extra message.
