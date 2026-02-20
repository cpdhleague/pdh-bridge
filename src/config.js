// =============================================================
// config.js - Configuration manager
// =============================================================
// This file loads your environment variables and manages the
// server/channel mapping that tells the bot which channels to bridge.
//
// LEARNING NOTE: "require" is how Node.js imports code from other files
// or packages. Think of it like an #include in C or import in Python.
// =============================================================

require('dotenv').config(); // Loads values from your .env file into process.env
const fs = require('fs');   // File system module - lets us read/write files
const path = require('path'); // Helps build file paths that work on any OS

// Path to the bridge configuration file
// __dirname means "the folder this file lives in"
const CONFIG_PATH = path.join(__dirname, '..', 'bridge-config.json');

// Default configuration structure
const DEFAULT_CONFIG = {
  // Each server in the bridge gets an entry here.
  // The setup wizard and /pdh-admin commands populate this.
  servers: {},
  
  // Global settings
  settings: {
    filterLinks: process.env.FILTER_LINKS === 'true',
    lfgExpiryMinutes: parseInt(process.env.LFG_EXPIRY_MINUTES) || 60,
    rssPollInterval: parseInt(process.env.RSS_POLL_INTERVAL) || 10,
    rssFeedUrl: process.env.RSS_FEED_URL || '',
  }
};

// =============================================================
// What the servers object looks like when populated:
// 
// "servers": {
//   "123456789012345678": {        <-- Server (Guild) ID
//     "name": "My PDH Server",
//     "channels": {
//       "news": "111111111111111111",      <-- Channel ID
//       "lfg": "222222222222222222",
//       "discussion": "333333333333333333"
//     },
//     "webhooks": {
//       "news": "https://discord.com/api/webhooks/...",
//       "lfg": "https://discord.com/api/webhooks/...",
//       "discussion": "https://discord.com/api/webhooks/..."
//     },
//     "roles": {
//       "news": "444444444444444444",       <-- @news role ID
//       "lfg": "555555555555555555"          <-- @lfg role ID
//     }
//   }
// }
// =============================================================

/**
 * Load the bridge config from disk, or create a default one.
 * This is called every time the bot starts up.
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const loaded = JSON.parse(raw);
      // Merge with defaults so new settings are always present
      return { ...DEFAULT_CONFIG, ...loaded, settings: { ...DEFAULT_CONFIG.settings, ...loaded.settings } };
    }
  } catch (err) {
    console.error('[Config] Error loading config, using defaults:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save the bridge config to disk.
 * JSON.stringify with (null, 2) makes it human-readable with 2-space indentation.
 */
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Add or update a server in the bridge config.
 */
function setServer(config, guildId, serverData) {
  config.servers[guildId] = serverData;
  saveConfig(config);
}

/**
 * Remove a server from the bridge config.
 */
function removeServer(config, guildId) {
  delete config.servers[guildId];
  saveConfig(config);
}

/**
 * Get all channel IDs for a specific channel type (news, lfg, discussion)
 * across all servers, EXCEPT the one specified by excludeGuildId.
 * This is used when relaying: "send to everyone except the server it came from."
 */
function getRelayTargets(config, channelType, excludeGuildId) {
  const targets = [];
  for (const [guildId, server] of Object.entries(config.servers)) {
    if (guildId === excludeGuildId) continue;
    if (server.channels[channelType] && server.webhooks[channelType]) {
      targets.push({
        guildId,
        channelId: server.channels[channelType],
        webhookUrl: server.webhooks[channelType],
        rolePing: server.roles?.[channelType] || null,
      });
    }
  }
  return targets;
}

/**
 * Find which server and channel type a message came from.
 * Returns { guildId, channelType } or null if the channel isn't bridged.
 */
function identifyChannel(config, guildId, channelId) {
  const server = config.servers[guildId];
  if (!server) return null;
  
  for (const [type, id] of Object.entries(server.channels)) {
    if (id === channelId) {
      return { guildId, channelType: type };
    }
  }
  return null;
}

// Export everything so other files can use it
// LEARNING NOTE: module.exports is how Node.js shares code between files.
// Whatever you put here becomes available when another file does require('./config')
module.exports = {
  loadConfig,
  saveConfig,
  setServer,
  removeServer,
  getRelayTargets,
  identifyChannel,
  CONFIG_PATH,
  // Also export raw env vars that other files need
  env: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    ownerId: process.env.OWNER_ID,
    rssFeedUrl: process.env.RSS_FEED_URL,
    convokeToken: process.env.CONVOKE_TOKEN,
  }
};
