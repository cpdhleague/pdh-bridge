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
  
  console.log('[Bot] All systems ready!');
});

// =============================================================
// Message handler (Discussion + News relay)
// =============================================================

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and webhooks to prevent infinite relay loops
  if (message.author.bot) return;
  if (message.webhookId) return;
  
  const channelInfo = identifyChannel(bridgeConfig, message.guild?.id, message.channel?.id);
  if (!channelInfo) return;
  
  const { channelType } = channelInfo;
  
  // --- NEWS: Never relay human messages ---
  // News channels are RSS-only. The news module (news.js) handles
  // broadcasting articles directly via webhooks — it doesn't go
  // through this message handler at all. So we simply ignore
  // everything here, regardless of who sent it.
  if (channelType === 'news') {
    return;
  }
  
  // --- LFG: Owner can post messages (for explanations, announcements) ---
  // Regular users can't type here (channel permissions block them).
  // The bot owner CAN post (useful for pinned explanations, announcements).
  // These owner messages get relayed so they appear on all servers.
  if (channelType === 'lfg') {
    if (message.author.id === env.ownerId) {
      // Relay owner's LFG channel message to all other servers
      await relayMessage(bridgeConfig, message, 'lfg');
    }
    return;
  }
  
  // --- DISCUSSION: Relay with moderation ---
  if (channelType === 'discussion') {
    const result = await moderateMessage(
      message, channelType, bridgeConfig.settings.filterLinks
    );
    if (!result.allowed) return;
    await relayMessage(bridgeConfig, message, 'discussion', {
      contentOverride: result.cleanedContent,
    });
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
