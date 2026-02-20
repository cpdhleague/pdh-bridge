// =============================================================
// bridge.js - Core message relay engine
// =============================================================
// This is the heart of the bot. When a message is posted in a
// bridged channel, this module relays it to all other servers
// via webhooks, making it look like the original user posted it.
//
// LEARNING NOTE: Webhooks are special URLs that let you post
// messages to a Discord channel without needing a bot account
// in that channel. They can display any username and avatar,
// which is how we make relayed messages look like they came
// from the original sender.
// =============================================================

const { WebhookClient, EmbedBuilder } = require('discord.js');
const { getRelayTargets } = require('./config');

// Cache WebhookClient instances so we don't recreate them every message.
// LEARNING NOTE: A "cache" stores frequently-used data in memory
// so we don't have to fetch/create it every time. It's a very
// common performance optimization pattern.
const webhookCache = new Map();

/**
 * Get or create a WebhookClient for a given webhook URL.
 * WebhookClient is a lightweight Discord.js object that can
 * send messages through a webhook without needing bot permissions.
 */
function getWebhookClient(webhookUrl) {
  if (webhookCache.has(webhookUrl)) {
    return webhookCache.get(webhookUrl);
  }
  const client = new WebhookClient({ url: webhookUrl });
  webhookCache.set(webhookUrl, client);
  return client;
}

/**
 * Relay a user's message to all other bridged servers.
 * 
 * @param {Object} config - The bridge configuration
 * @param {Message} message - The Discord.js message object
 * @param {string} channelType - "news", "lfg", or "discussion"
 * @param {Object} options - Additional options
 * @param {string} options.contentOverride - Replace message content (used for cleaned content)
 * @param {boolean} options.pingRole - Whether to ping the channel's role
 * 
 * LEARNING NOTE: "async/await" is how JavaScript handles operations
 * that take time (like sending messages over the internet). The
 * "await" keyword pauses execution until the operation completes.
 * "Promise.allSettled" runs multiple async operations in PARALLEL
 * (all at once) rather than one-by-one, which is much faster.
 */
async function relayMessage(config, message, channelType, options = {}) {
  const targets = getRelayTargets(config, channelType, message.guild.id);
  
  if (targets.length === 0) return [];
  
  const content = options.contentOverride ?? message.content;
  
  // Build the webhook payload
  // This makes the message appear to come from the original user
  const webhookPayload = {
    content: content || undefined,
    username: message.author.displayName || message.author.username,
    avatarURL: message.author.displayAvatarURL({ size: 256 }),
    allowedMentions: { parse: [] }, // Block all mentions by default
  };
  
  // Handle attachments (images, files the user uploaded)
  if (message.attachments.size > 0) {
    webhookPayload.files = message.attachments.map(att => ({
      attachment: att.url,
      name: att.name,
    }));
  }
  
  // Handle embeds (link previews, etc.)
  if (message.embeds.length > 0) {
    webhookPayload.embeds = message.embeds
      .filter(e => e.data.type === 'rich') // Only forward rich embeds, not link previews
      .map(e => e.toJSON());
  }
  
  // Handle stickers
  if (message.stickers.size > 0) {
    const stickerNote = message.stickers.map(s => `[Sticker: ${s.name}]`).join(' ');
    webhookPayload.content = (webhookPayload.content || '') + '\n' + stickerNote;
  }
  
  // Send to all targets in parallel
  // LEARNING NOTE: Promise.allSettled waits for ALL promises to finish,
  // even if some fail. This is better than Promise.all which stops
  // at the first failure. We don't want one server being down to
  // prevent messages from reaching other servers.
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      try {
        const webhook = getWebhookClient(target.webhookUrl);
        
        // If we need to ping a role (like @news or @lfg)
        const payload = { ...webhookPayload };
        if (options.pingRole && target.rolePing) {
          payload.content = `<@&${target.rolePing}> ${payload.content || ''}`.trim();
          payload.allowedMentions = { roles: [target.rolePing] };
        }
        
        const sent = await webhook.send(payload);
        return { guildId: target.guildId, messageId: sent.id, channelId: target.channelId };
      } catch (err) {
        console.error(`[Bridge] Failed to relay to guild ${target.guildId}:`, err.message);
        throw err;
      }
    })
  );
  
  // Return successful deliveries (for LFG tracking, etc.)
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

/**
 * Send a bot-authored embed to all servers for a channel type.
 * Used for LFG posts, news articles, and system announcements.
 * Unlike relayMessage, this doesn't impersonate a user.
 */
async function broadcastEmbed(config, channelType, embed, options = {}) {
  const targets = getRelayTargets(config, channelType, options.excludeGuildId);
  
  // Also include the source server if we want to post everywhere
  if (options.includeSource) {
    const sourceServer = config.servers[options.includeSource];
    if (sourceServer?.channels[channelType] && sourceServer?.webhooks[channelType]) {
      targets.push({
        guildId: options.includeSource,
        channelId: sourceServer.channels[channelType],
        webhookUrl: sourceServer.webhooks[channelType],
        rolePing: sourceServer.roles?.[channelType] || null,
      });
    }
  }
  
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      try {
        const webhook = getWebhookClient(target.webhookUrl);
        
        const payload = {
          embeds: [embed.toJSON ? embed.toJSON() : embed],
          username: options.username || 'PDH Bridge',
          avatarURL: options.avatarURL,
          allowedMentions: { parse: [] },
        };
        
        if (options.pingRole && target.rolePing) {
          payload.content = `<@&${target.rolePing}>`;
          payload.allowedMentions = { roles: [target.rolePing] };
        }
        
        if (options.components) {
          // Serialize components to JSON for webhook compatibility
          payload.components = options.components.map(c => c.toJSON ? c.toJSON() : c);
        }
        
        const sent = await webhook.send(payload);
        return { guildId: target.guildId, messageId: sent.id, channelId: target.channelId };
      } catch (err) {
        console.error(`[Bridge] Failed to broadcast to guild ${target.guildId}:`, err.message);
        throw err;
      }
    })
  );
  
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

/**
 * Delete a message across all servers by its tracked message IDs.
 * Used for LFG cleanup and moderation.
 */
async function deleteAcrossServers(client, messageMap) {
  await Promise.allSettled(
    messageMap.map(async ({ guildId, channelId, messageId }) => {
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      } catch (err) {
        // Silent fail - message may already be deleted
      }
    })
  );
}

/**
 * Set up or verify webhooks for a specific server/channel.
 * Creates a new webhook if one doesn't exist.
 * This is the "self-healing" webhook logic.
 */
async function ensureWebhook(channel, botUser) {
  try {
    // Check for existing webhooks created by our bot
    const webhooks = await channel.fetchWebhooks();
    const existing = webhooks.find(wh => wh.owner?.id === botUser.id);
    
    if (existing) {
      return existing.url;
    }
    
    // Create a new one
    const webhook = await channel.createWebhook({
      name: 'PDH Bridge',
      reason: 'PDH Bridge Bot - cross-server relay webhook',
    });
    
    console.log(`[Bridge] Created webhook in #${channel.name} on ${channel.guild.name}`);
    return webhook.url;
  } catch (err) {
    console.error(`[Bridge] Failed to ensure webhook in #${channel.name}:`, err.message);
    return null;
  }
}

module.exports = {
  relayMessage,
  broadcastEmbed,
  deleteAcrossServers,
  ensureWebhook,
  getWebhookClient,
};
