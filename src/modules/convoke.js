// =============================================================
// convoke.js - Convoke Games API integration
// =============================================================
// This module handles creating game rooms on Convoke Games,
// a webcam Magic: The Gathering platform (convoke.games).
//
// HOW THIS WORKS:
// When 4 players join an LFG post, this module calls the Convoke
// API to automatically create a private room with PDH settings
// (4 players, Pauper Commander format, 30 starting life).
// It returns a URL that players can click to join the game.
//
// LEARNING NOTE ON API INTEGRATIONS:
// When your bot talks to another service's API, the typical flow is:
//   1. You send an HTTP request (usually POST to create something)
//   2. You include authentication (in this case, inside the payload)
//   3. You send a JSON body describing what you want
//   4. The service responds with JSON containing what it created
//
// Different APIs authenticate differently:
//   - Some use "Bearer tokens" in headers (Authorization: Bearer xxx)
//   - Some use API keys in the URL query string (?apiKey=xxx)
//   - Some (like Convoke) put the key inside the request body
// Always check the docs or reference code to see which pattern to use!
//
// The token proves you have permission to use the API.
// That's why it goes in your .env file and NEVER in source code.
// =============================================================

// =============================================================
// CONFIGURATION
// =============================================================
// These come from the Convoke API. The base URL is api.convoke.gg
// (not convoke.games — that's the player-facing website).
//
// LEARNING NOTE: Many services separate their API domain from
// their main website. For example:
//   - Website:  convoke.games     (what users see)
//   - API:      api.convoke.gg    (what bots/code talk to)
// This is a very common pattern in web development.
// =============================================================

const CONVOKE_API_BASE = 'https://api.convoke.gg';
const CONVOKE_CREATE_GAME_ENDPOINT = `${CONVOKE_API_BASE}/game/create-game`;

// =============================================================
// CREATE A CONVOKE ROOM
// =============================================================
// Calls the Convoke API to create a new private game room.
//
// Parameters:
//   - token:     Your Convoke API key (from .env)
//   - gameId:    A unique identifier for this game (our LFG post ID)
//   - guildId:   The Discord server ID where the game originated
//   - channelId: The Discord channel ID where the /lfg was used
//   - players:   Array of { userId, username } objects
//
// Returns: The room URL string on success, or null on failure.
//
// LEARNING NOTE ON FUNCTION DESIGN:
// Notice how this function takes simple, generic parameters
// instead of a Discord interaction object. This is called
// "decoupling" — the Convoke module doesn't need to know
// anything about Discord. It just needs an ID, some player
// info, and an API key. This makes it easier to test and
// reuse in other contexts.
// =============================================================

async function createConvokeRoom(token, gameId, guildId, channelId, players) {
  if (!token) {
    console.error('[Convoke] No API token configured! Add CONVOKE_TOKEN to your .env file.');
    return null;
  }

  try {
    // LEARNING NOTE: The payload structure here was determined by
    // reading your team's existing bot.py. Key fields:
    //
    //   apiKey:          Authentication — proves we have permission
    //   isPublic:        false = private room (only invited players)
    //   name:            Room name shown in Convoke's UI
    //   spellbotGameId:  Convoke expects this field (SpellBot compat)
    //   seatLimit:       How many players can join (always 4 for PDH)
    //   format:          The game format — "commander" for PDH
    //   discordGuild:    Which Discord server this game came from
    //   discordChannel:  Which channel it came from
    //   discordPlayers:  Array of player objects with id + name
    //
    // All IDs must be strings (even though Discord IDs are numbers).
    // This is because JavaScript can lose precision with very large
    // numbers, and Discord IDs are huge (18+ digit snowflakes).

    const payload = {
      apiKey: token,
      isPublic: false,
      name: `PDH Game #${gameId}`,
      spellbotGameId: String(gameId),
      seatLimit: 4,
      format: 'commander',           // Convoke's format name for Commander/PDH
      discordGuild: String(guildId),
      discordChannel: String(channelId),
      discordPlayers: players.map(p => ({
        id: String(p.userId),
        name: p.username,
      })),
    };

    // LEARNING NOTE: Unlike many APIs that use "Authorization: Bearer"
    // headers, Convoke puts the API key inside the JSON body. The only
    // header we send is a User-Agent to identify our bot. This is a
    // courtesy — it helps the Convoke team see who's using their API
    // and reach out if there's an issue.

    const response = await fetch(CONVOKE_CREATE_GAME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'pdh-bridge-bot/1.0',
      },
      body: JSON.stringify(payload),
    });

    // LEARNING NOTE on HTTP status codes:
    //   200 = OK, 201 = Created (both mean success)
    //   400 = Bad request (our data was wrong)
    //   401/403 = Auth failed (bad API key)
    //   429 = Rate limited (too many requests too fast)
    //   500 = Server error (Convoke's problem, not ours)

    if (response.status === 200 || response.status === 201) {
      const data = await response.json();
      const gameUrl = data.url;

      if (gameUrl) {
        console.log(`[Convoke] Room created successfully: ${gameUrl}`);
        return gameUrl;
      } else {
        // API returned success but no URL — log the full response
        // so you can diagnose what happened
        console.error('[Convoke] Success response but no URL found!');
        console.error('[Convoke] Full response:', JSON.stringify(data, null, 2));
        return null;
      }
    } else {
      // Non-success status code — log the error details
      const errorText = await response.text().catch(() => 'No error details');
      console.error(`[Convoke] API returned status ${response.status}: ${errorText}`);

      // Helpful hints for common errors
      if (response.status === 401 || response.status === 403) {
        console.error('[Convoke] → Your API key may be invalid or expired. Check CONVOKE_TOKEN in .env');
      } else if (response.status === 429) {
        console.error('[Convoke] → Rate limited! Creating rooms too quickly.');
      }
      return null;
    }

  } catch (err) {
    // Network errors, JSON parse failures, DNS issues, etc.
    console.error('[Convoke] Failed to create room:', err.message);

    if (err.message.includes('fetch failed') || err.code === 'ENOTFOUND') {
      console.error('[Convoke] → Could not reach api.convoke.gg — check your internet connection.');
    }
    return null;
  }
}

// =============================================================
// EXPORTS
// =============================================================

module.exports = {
  createConvokeRoom,
  CONVOKE_API_BASE,
  CONVOKE_CREATE_GAME_ENDPOINT,
};
