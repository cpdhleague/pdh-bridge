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
  handleLfgButton, cleanupExpiredPosts,
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
  
  // --- NEWS: Only the bot owner can post ---
  if (channelType === 'news') {
    if (message.author.id !== env.ownerId) return;
    await relayMessage(bridgeConfig, message, 'news', { pingRole: true });
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
        await handleLfgModalSubmit(interaction, bridgeConfig);
      }
    }
    
    // --- BUTTON CLICKS ---
    if (interaction.isButton()) {
      // LFG game type selection: "lfg_type_league" or "lfg_type_casual"
      if (interaction.customId.startsWith('lfg_type_')) {
        await handleTypeSelection(interaction);
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
