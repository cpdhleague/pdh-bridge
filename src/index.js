// =============================================================
// index.js - PDH Bridge Bot - Main Entry Point
// =============================================================
// Event-driven architecture: sets up listeners, then waits.
// When Discord sends events (messages, commands, buttons),
// the matching handler runs.
// =============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} = require('discord.js');

const { loadConfig, identifyChannel, env } = require('./config');
const { initDatabase } = require('./database');
const { relayMessage, ensureWebhook } = require('./bridge');
const { moderateMessage } = require('./modules/moderation');
const { startRssPolling, stopRssPolling } = require('./modules/news');
const {
  handleLfgCommand, handleTypeSelection, handleLfgModalSubmit,
  handleLfgButton, cleanupExpiredPosts, wipeLfgChannels,
} = require('./modules/lfg');
const {
  handleBan, handleUnban, handleStrikes, handleConfig,
  handleSetup, handleStatus, handlePin,
} = require('./modules/commands');

// =============================================================
// Create the Discord client
// =============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// =============================================================
// Load configuration and database
// =============================================================

let bridgeConfig = loadConfig();
initDatabase();

// =============================================================
// Bot startup
// =============================================================

client.once(Events.ClientReady, async (readyClient) => {
  console.log('═══════════════════════════════════════════');
  console.log(`  PDH Bridge Bot is online!`);
  console.log(`  Logged in as: ${readyClient.user.tag}`);
  console.log(`  Serving ${readyClient.guilds.cache.size} server(s)`);
  console.log(`  Bridge has ${Object.keys(bridgeConfig.servers).length} configured server(s)`);
  console.log('═══════════════════════════════════════════');
  
  await verifyWebhooks(readyClient);
  startRssPolling(bridgeConfig, readyClient);
  
  // LFG cleanup timer — checks every 60 seconds for expired posts
  setInterval(() => cleanupExpiredPosts(readyClient), 60 * 1000);
  
  // =============================================================
  // DAILY LFG CHANNEL WIPE — 3:00 AM Central Time
  // =============================================================
  // Checks every minute if it's 3:00 AM in the US/Central timezone.
  // When it is, wipes all non-pinned messages from every LFG channel.
  //
  // LEARNING NOTE: Instead of adding a cron library (extra dependency),
  // we use a simple "check every minute" approach. The _lastWipeDate
  // variable prevents the wipe from running more than once per day
  // (since the check runs every minute, without this guard it would
  // fire ~60 times during the 3:00 AM hour).
  // =============================================================
  let _lastWipeDate = null;
  setInterval(async () => {
    // Get the current time in US Central (handles DST automatically)
    const now = new Date();
    const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const hour = centralTime.getHours();
    const minute = centralTime.getMinutes();
    const today = centralTime.toDateString();
    
    // Trigger at 3:00 AM Central, but only once per day
    if (hour === 3 && minute === 0 && _lastWipeDate !== today) {
      _lastWipeDate = today;
      console.log('[Bot] 3:00 AM Central — starting daily LFG channel wipe');
      await wipeLfgChannels(readyClient, bridgeConfig);
    }
  }, 60 * 1000); // Check every 60 seconds
  
  // =============================================================
  // ONE-TIME AMNESTY — Clear all penalties 8 hours after boot
  // =============================================================
  // This was requested to give everyone a clean slate after
  // false positives from the profanity filter. Each affected
  // user gets a DM letting them know. This timer only runs once
  // and can be removed from the code after it fires.
  // =============================================================
  setTimeout(async () => {
    console.log('[Bot] Running one-time amnesty — clearing all strikes...');
    const db = require('./database');
    const affected = db.getAllStrikedUsers();
    const cleared = db.clearAllStrikes();
    console.log(`[Bot] Amnesty: Cleared strikes for ${cleared} users`);
    
    // DM each affected user
    for (const user of affected) {
      if (user.permanent_ban) continue; // Don't notify perma-banned users
      try {
        const discordUser = await readyClient.users.fetch(user.user_id);
        await discordUser.send(
          `**PDH Bridge Notice**\n\n` +
          `Good news! 🎉 All moderation penalties on the PDH Bridge have been reset. ` +
          `Your strike history has been cleared and any suspensions have been lifted.\n\n` +
          `We've improved our filter to reduce false flags. Thank you for being part ` +
          `of the PDH community! ❤️`
        );
      } catch (err) {
        console.log(`[Bot] Amnesty: Couldn't DM ${user.username}: ${err.message}`);
      }
    }
    console.log('[Bot] Amnesty complete.');
  }, 8 * 60 * 60 * 1000); // 8 hours in milliseconds
  console.log('[Bot] One-time amnesty scheduled for 8 hours from now');
  
  console.log('[Bot] All systems ready!');
});

// =============================================================
// Message handler (Discussion + LFG + News relay)
// =============================================================

// =============================================================
// WHITELISTED BOTS
// =============================================================
// Bots in this list are allowed to have their messages relayed
// across the bridge. All other bots are ignored to prevent loops.
//
// To find a bot's user ID: enable Developer Mode in Discord,
// right-click the bot's name, and click "Copy User ID".
//
// WHY THIS IS LOOP-SAFE: When a bot message is relayed, it
// arrives on other servers as a WEBHOOK message. Line 143 below
// always blocks webhook messages, so the relayed copy is never
// re-relayed. Bot → relay → webhook → blocked. No loop.
// =============================================================
const WHITELISTED_BOTS = new Set([
  '268547439714238465',  // Scryfall Bot
]);

client.on(Events.MessageCreate, async (message) => {
  // Ignore webhooks to prevent infinite relay loops
  if (message.webhookId) return;
  
  // Ignore bots UNLESS they're on the whitelist
  if (message.author.bot && !WHITELISTED_BOTS.has(message.author.id)) return;
  
  // Ignore our own bot's messages (even if somehow whitelisted)
  if (message.author.id === client.user.id) return;
  
  const channelInfo = identifyChannel(bridgeConfig, message.guild?.id, message.channel?.id);
  if (!channelInfo) return;
  
  const { channelType } = channelInfo;
  
  // Whitelisted bots (like Scryfall) bypass moderation entirely.
  // Their messages are relayed as-is — no profanity check, no
  // mention stripping, no link filtering. Bot output is trusted.
  const isWhitelistedBot = message.author.bot && WHITELISTED_BOTS.has(message.author.id);
  
  // --- NEWS: Never relay human messages ---
  // News channels are RSS-only. The news module (news.js) handles
  // broadcasting articles directly via webhooks — it doesn't go
  // through this message handler at all. So we simply ignore
  // everything here, regardless of who sent it.
  if (channelType === 'news') {
    return;
  }
  
  // --- LFG: Relay all messages with moderation ---
  // LFG channels now function as both a matchmaking space (via /lfg)
  // AND a chat space where players can coordinate, schedule, and
  // discuss games. Messages are relayed across all servers just
  // like the discussion channel, with profanity filtering applied.
  if (channelType === 'lfg') {
    if (isWhitelistedBot) {
      // Whitelisted bot: relay directly, no moderation
      await relayMessage(bridgeConfig, message, 'lfg');
    } else {
      const result = await moderateMessage(
        message, channelType, bridgeConfig.settings.filterLinks
      );
      if (!result.allowed) return;
      await relayMessage(bridgeConfig, message, 'lfg', {
        contentOverride: result.cleanedContent,
      });
    }
    return;
  }
  
  // --- DISCUSSION: Relay with moderation ---
  if (channelType === 'discussion') {
    if (isWhitelistedBot) {
      // Whitelisted bot: relay directly, no moderation
      await relayMessage(bridgeConfig, message, 'discussion');
    } else {
      const result = await moderateMessage(
        message, channelType, bridgeConfig.settings.filterLinks
      );
      if (!result.allowed) return;
      await relayMessage(bridgeConfig, message, 'discussion', {
        contentOverride: result.cleanedContent,
      });
    }
  }
});

// =============================================================
// Interaction handler (Slash commands, buttons, modals)
// =============================================================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // --- SLASH COMMANDS ---
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'lfg':
          await handleLfgCommand(interaction);
          break;
        case 'pdh-setup':
          await handleSetup(interaction, bridgeConfig);
          bridgeConfig = loadConfig(); // Reload after changes
          break;
        case 'pdh-ban':
          await handleBan(interaction);
          break;
        case 'pdh-unban':
          await handleUnban(interaction);
          break;
        case 'pdh-strikes':
          await handleStrikes(interaction);
          break;
        case 'pdh-config':
          await handleConfig(interaction, bridgeConfig);
          break;
        case 'pdh-status':
          await handleStatus(interaction, bridgeConfig);
          break;
        case 'pdh-pin':
          await handlePin(interaction, bridgeConfig);
          break;
      }
    }
    
    // --- MODAL SUBMISSIONS ---
    if (interaction.isModalSubmit()) {
      // LFG modal: "lfg_modal_league" or "lfg_modal_casual"
      if (interaction.customId.startsWith('lfg_modal_')) {
        await handleLfgModalSubmit(interaction, bridgeConfig, client);
      }
    }
    
    // --- BUTTON CLICKS ---
    if (interaction.isButton()) {
      // LFG game type selection: "lfg_type_league" or "lfg_type_casual"
      if (interaction.customId.startsWith('lfg_type_')) {
        await handleTypeSelection(interaction, bridgeConfig, client);
        return;
      }
      
      // LFG join/leave/cancel: "lfg_join_42", "lfg_leave_42", "lfg_cancel_42"
      if (interaction.customId.startsWith('lfg_join_') ||
          interaction.customId.startsWith('lfg_leave_') ||
          interaction.customId.startsWith('lfg_cancel_')) {
        await handleLfgButton(interaction, bridgeConfig, client);
        return;
      }
    }
    
  } catch (err) {
    console.error('[Bot] Interaction error:', err);
    const errorMsg = { content: 'Something went wrong. Please try again.', ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMsg);
      } else {
        await interaction.reply(errorMsg);
      }
    } catch (e) { /* Discord may have timed out */ }
  }
});

// =============================================================
// Webhook self-healing on startup
// =============================================================

async function verifyWebhooks(readyClient) {
  console.log('[Bot] Verifying webhooks...');
  const { setServer } = require('./config');
  let fixed = 0;
  
  for (const [guildId, server] of Object.entries(bridgeConfig.servers)) {
    const guild = readyClient.guilds.cache.get(guildId);
    if (!guild) {
      console.log(`[Bot] Warning: Not in guild ${server.name || guildId}`);
      continue;
    }
    for (const channelType of ['news', 'lfg', 'discussion']) {
      const channelId = server.channels[channelType];
      if (!channelId) continue;
      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        console.log(`[Bot] Warning: Channel ${channelType} not found in ${guild.name}`);
        continue;
      }
      try {
        const webhookUrl = await ensureWebhook(channel, readyClient.user);
        if (webhookUrl && webhookUrl !== server.webhooks[channelType]) {
          server.webhooks[channelType] = webhookUrl;
          setServer(bridgeConfig, guildId, server);
          fixed++;
          console.log(`[Bot] Fixed webhook for ${channelType} in ${guild.name}`);
        }
      } catch (err) {
        console.error(`[Bot] Webhook verify failed for ${channelType} in ${guild.name}:`, err.message);
      }
    }
  }
  
  console.log(fixed > 0 ? `[Bot] Repaired ${fixed} webhook(s)` : '[Bot] All webhooks verified ✅');
}

// =============================================================
// Graceful shutdown
// =============================================================

process.on('SIGINT', () => {
  console.log('\n[Bot] Shutting down...');
  stopRssPolling();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Bot] Received SIGTERM...');
  stopRssPolling();
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[Bot] Unhandled rejection:', err);
});

// =============================================================
// Connect to Discord!
// =============================================================

if (!env.token) {
  console.error('❌ DISCORD_TOKEN is not set! Copy .env.example to .env and fill in your token.');
  process.exit(1);
}

client.login(env.token);
