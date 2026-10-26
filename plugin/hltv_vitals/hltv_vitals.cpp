// hltv_vitals.cpp - every player's health and armor for HLTV.
//
// TFC sends health and armor only to the player they belong to (the Health
// and Battery user messages), and its entity_state_player_t has no health
// field, so an HLTV proxy - and every demo it records - has nobody's. This
// plugin registers one more user message, "HltvVitals", and sends it with
// MSG_SPEC: the engine appends that buffer to the datagrams of spectator
// proxies only (client->proxy), so players never receive it.
//
// Message (variable length): per player, slot byte (1..32), health short,
// armor short. Health is clamped the way the HL SDK's Health message does it
// (player.cpp UpdateClientData): never negative, and 0 < health < 1 is 1.
//
// Sent at most VITALS_RATE times a second, listing the players whose values
// changed; every FULL_EVERY seconds everyone is listed again, because MSG_SPEC
// is unreliable and a proxy (or a demo it starts) can join at any time. When
// no proxy is connected nothing is sent at all.
//
// Decoded by goldsrc_demo.py in this repository (u_hltvvitals).
//
// Copyright (c) 2026 lazydaydreamer12-collab
//
// This program is free software; you can redistribute it and/or modify it
// under the terms of the GNU General Public License version 2 as published
// by the Free Software Foundation. It is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
// of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE
// file next to this one for the full license.
//
// In addition, as a special exception (the same one Metamod gives), the
// author gives permission to link the code of this program with the
// Half-Life Game Engine ("HL Engine") and Modified Game Libraries ("MODs")
// developed by Valve, L.L.C ("Valve"). You must obey the GNU General Public
// License in all respects for all of the code used other than the HL Engine
// and MODs from Valve. If you modify this file, you may extend this
// exception to your version of the file, but you are not obligated to do so.
// If you do not wish to do so, delete this exception statement from your
// version.

#include <extdll.h>
#include <meta_api.h>

#define VITALS_RATE  10       // updates a second, at most
#define FULL_EVERY   1.0f     // seconds between full lists
#define MAXP         33       // slots 1..32

// ---------------------------------------------------------------------------
// GiveFnptrsToDll (as metamod-p's stub_plugin/h_export.cpp)
enginefuncs_t g_engfuncs;
globalvars_t  *gpGlobals;

C_DLLEXPORT FORCE_STACK_ALIGN void WINAPI GiveFnptrsToDll(enginefuncs_t *pengfuncsFromEngine, globalvars_t *pGlobals)
{
	memcpy(&g_engfuncs, pengfuncsFromEngine, sizeof(enginefuncs_t));
	gpGlobals = pGlobals;
}

// ---------------------------------------------------------------------------
static int   s_msgId = 0;
static float s_nextSend = 0;
static float s_nextFull = 0;
static int   s_sentHealth[MAXP], s_sentArmor[MAXP];   // -1 = not sent

static void ResetSent(void)
{
	for (int i = 0; i < MAXP; i++)
		s_sentHealth[i] = s_sentArmor[i] = -1;
	s_nextSend = 0;
	s_nextFull = 0;
}

static bool IsPlayer(edict_t *e)
{
	return e && !e->free && e->pvPrivateData && (e->v.flags & FL_CLIENT) && !(e->v.flags & FL_PROXY);
}

static bool ProxyConnected(void)
{
	for (int i = 1; i <= gpGlobals->maxClients; i++)
	{
		edict_t *e = INDEXENT(i);
		if (e && !e->free && (e->v.flags & FL_PROXY))
			return true;
	}
	return false;
}

static int ClientHealth(float h)
{
	if (h <= 0)
		return 0;
	if (h <= 1)
		return 1;
	return h >= 32767 ? 32767 : (int)h;
}

static int ClientArmor(float a)
{
	if (a <= 0)
		return 0;
	return a >= 32767 ? 32767 : (int)a;
}

static void SendVitals(void)
{
	if (!s_msgId || gpGlobals->time < s_nextSend)
		return;
	s_nextSend = gpGlobals->time + 1.0f / VITALS_RATE;
	if (!ProxyConnected())
	{
		ResetSent();                       // a proxy that connects gets everyone at once
		s_nextSend = gpGlobals->time + 1.0f / VITALS_RATE;
		return;
	}
	bool full = gpGlobals->time >= s_nextFull;
	if (full)
		s_nextFull = gpGlobals->time + FULL_EVERY;

	unsigned char slot[MAXP];
	short health[MAXP], armor[MAXP];
	int n = 0;
	int maxp = gpGlobals->maxClients < MAXP - 1 ? gpGlobals->maxClients : MAXP - 1;
	for (int i = 1; i <= maxp; i++)
	{
		edict_t *e = INDEXENT(i);
		if (!IsPlayer(e))
		{
			s_sentHealth[i] = s_sentArmor[i] = -1;
			continue;
		}
		int h = ClientHealth(e->v.health), a = ClientArmor(e->v.armorvalue);
		if (!full && h == s_sentHealth[i] && a == s_sentArmor[i])
			continue;
		s_sentHealth[i] = h;
		s_sentArmor[i] = a;
		slot[n] = (unsigned char)i;
		health[n] = (short)h;
		armor[n] = (short)a;
		n++;
	}
	if (!n)
		return;
	// 32 players x 5 bytes = 160, under the engine's 192-byte user message limit
	MESSAGE_BEGIN(MSG_SPEC, s_msgId);
	for (int k = 0; k < n; k++)
	{
		WRITE_BYTE(slot[k]);
		WRITE_SHORT(health[k]);
		WRITE_SHORT(armor[k]);
	}
	MESSAGE_END();
}

// ---------------------------------------------------------------------------
// Game DLL functions, after the game's own. EVERY hook must end in RETURN_META.
static void ServerActivatePost(edict_t * /*pEdictList*/, int /*edictCount*/, int /*clientMax*/)
{
	// After TFC has registered its own messages. The engine hands new user
	// messages to connected clients (and proxies) on its next frame, and
	// returns the same id when a name is registered again.
	s_msgId = REG_USER_MSG("HltvVitals", -1);
	ResetSent();
	RETURN_META(MRES_IGNORED);
}

static void ClientPutInServerPost(edict_t *pEntity)
{
	if (pEntity && (pEntity->v.flags & FL_PROXY))
		ResetSent();                       // a new proxy: everyone, next update
	RETURN_META(MRES_IGNORED);
}

static void StartFramePost(void)
{
	SendVitals();
	RETURN_META(MRES_IGNORED);
}

static DLL_FUNCTIONS gFunctionTablePost;

C_DLLEXPORT FORCE_STACK_ALIGN int GetEntityAPI2_Post(DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion)
{
	if (!pFunctionTable)
		return FALSE;
	if (*interfaceVersion != INTERFACE_VERSION)
	{
		*interfaceVersion = INTERFACE_VERSION;
		return FALSE;
	}
	memset(&gFunctionTablePost, 0, sizeof(gFunctionTablePost));
	gFunctionTablePost.pfnServerActivate    = ServerActivatePost;
	gFunctionTablePost.pfnClientPutInServer = ClientPutInServerPost;
	gFunctionTablePost.pfnStartFrame        = StartFramePost;
	memcpy(pFunctionTable, &gFunctionTablePost, sizeof(DLL_FUNCTIONS));
	return TRUE;
}

// ---------------------------------------------------------------------------
// Plugin identity and metamod attach/detach
static META_FUNCTIONS gMetaFunctionTable =
{
	NULL,                    // pfnGetEntityAPI
	NULL,                    // pfnGetEntityAPI_Post
	NULL,                    // pfnGetEntityAPI2
	GetEntityAPI2_Post,      // pfnGetEntityAPI2_Post
	NULL,                    // pfnGetNewDLLFunctions
	NULL,                    // pfnGetNewDLLFunctions_Post
	NULL,                    // pfnGetEngineFunctions
	NULL,                    // pfnGetEngineFunctions_Post
};

plugin_info_t Plugin_info =
{
	META_INTERFACE_VERSION,
	"HLTV Vitals",
	"1.0.0",
	"2026/10/21",
	"custom",
	"",
	"HLTVVITALS",
	PT_ANYTIME,
	PT_ANYPAUSE,
};

meta_globals_t *gpMetaGlobals;
gamedll_funcs_t *gpGamedllFuncs;
mutil_funcs_t *gpMetaUtilFuncs;

C_DLLEXPORT FORCE_STACK_ALIGN int Meta_Query(char * /*ifvers*/, plugin_info_t **pPlugInfo,
		mutil_funcs_t *pMetaUtilFuncs)
{
	*pPlugInfo = &Plugin_info;
	gpMetaUtilFuncs = pMetaUtilFuncs;
	return TRUE;
}

C_DLLEXPORT FORCE_STACK_ALIGN int Meta_Attach(PLUG_LOADTIME /*now*/,
		META_FUNCTIONS *pFunctionTable, meta_globals_t *pMGlobals,
		gamedll_funcs_t *pGamedllFuncs)
{
	if (!pMGlobals || !pFunctionTable)
		return FALSE;
	gpMetaGlobals = pMGlobals;
	gpGamedllFuncs = pGamedllFuncs;
	memcpy(pFunctionTable, &gMetaFunctionTable, sizeof(META_FUNCTIONS));
	ResetSent();
	// Loaded with a map already running ("meta load"): nothing until the next
	// map. A proxy recording now has written the demo's list of user messages
	// already (HLTV's World::AddUserMessage only stores a late one), and a
	// message missing from that list breaks the demo for whoever plays it.
	return TRUE;
}

C_DLLEXPORT FORCE_STACK_ALIGN int Meta_Detach(PLUG_LOADTIME /*now*/, PL_UNLOAD_REASON /*reason*/)
{
	s_msgId = 0;
	return TRUE;
}
