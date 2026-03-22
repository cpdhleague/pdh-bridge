// =============================================================
// commands.js - Admin slash commands for managing the bridge
// =============================================================

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { env } = require('../config');

// --- /pdh-ban ---
async function handleBan(interaction) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You don\'t have permission to use this command.', ephemeral: true });
    return;
  }
  const targetUser = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason given';
  db.permanentBan(targetUser.id, targetUser.username);
  try {
    await targetUser.send(
      `**PDH Bridge Notice**\n\nYou have been permanently banned from PDH bridge channels.\nReason: ${reason}\n\nYour messages will no longer be relayed across PDH servers. If you believe this is a mistake, please contact a PDH administrator.`
    );
  } catch (err) { /* DMs disabled */ }
  await interaction.reply({ content: `✅ **${targetUser.username}** has been permanently banned from the PDH bridge.\nReason: ${reason}`, ephemeral: true });
  console.log(`[Admin] ${interaction.user.username} banned ${targetUser.username}: ${reason}`);
}

// --- /pdh-unban ---
async function handleUnban(interaction) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You don\'t have permission to use this command.', ephemeral: true });
    return;
  }
  const targetUser = interaction.options.getUser('user');
  db.removeBan(targetUser.id);
  await interaction.reply({ content: `✅ **${targetUser.username}** has been unbanned. Strike history preserved.`, ephemeral: true });
  console.log(`[Admin] ${interaction.user.username} unbanned ${targetUser.username}`);
}

// --- /pdh-strikes ---
async function handleStrikes(interaction) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You don\'t have permission to use this command.', ephemeral: true });
    return;
  }
  const targetUser = interaction.options.getUser('user');
  const user = db.getUser(targetUser.id);
  if (!user) {
    await interaction.reply({ content: `**${targetUser.username}** has a clean record — no strikes.`, ephemeral: true });
    return;
  }
  const history = db.getStrikeHistory(targetUser.id);
  const embed = new EmbedBuilder()
    .setColor(user.permanent_ban ? 0xED4245 : 0xFEE75C)
    .setTitle(`📋 Record: ${targetUser.username}`)
    .setThumbnail(targetUser.displayAvatarURL({ size: 64 }))
    .addFields(
      { name: 'Total Strikes', value: `${user.strike_count}`, inline: true },
      { name: 'Status', value: getStatusText(user), inline: true },
    );
  if (history.length > 0) {
    const historyText = history.slice(0, 5).map(h => {
      const date = new Date(h.created_at).toLocaleDateString();
      return `\`${date}\` — Strike ${h.strike_number}: ${h.action_taken}`;
    }).join('\n');
    embed.addFields({ name: 'Recent History', value: historyText });
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// --- /pdh-config ---
async function handleConfig(interaction, config) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You don\'t have permission to use this command.', ephemeral: true });
    return;
  }
  const setting = interaction.options.getString('setting');
  const value = interaction.options.getString('value');
  const { saveConfig } = require('../config');
  switch (setting) {
    case 'links':
      config.settings.filterLinks = value === 'on';
      saveConfig(config);
      await interaction.reply({ content: `✅ Link filtering is now **${value}** in PDH Discussion.`, ephemeral: true });
      break;
    case 'lfg-expiry':
      const minutes = parseInt(value);
      if (isNaN(minutes) || minutes < 5 || minutes > 1440) {
        await interaction.reply({ content: 'Expiry must be between 5 and 1440 minutes.', ephemeral: true });
        return;
      }
      config.settings.lfgExpiryMinutes = minutes;
      saveConfig(config);
      await interaction.reply({ content: `✅ LFG posts now expire after **${minutes} minutes**.`, ephemeral: true });
      break;
    default:
      await interaction.reply({ content: 'Unknown setting.', ephemeral: true });
  }
}

// --- /pdh-setup ---
async function handleSetup(interaction, config) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You don\'t have permission to use this command.', ephemeral: true });
    return;
  }
  let newsChannel = interaction.options.getChannel('news-channel');
  let lfgChannel = interaction.options.getChannel('lfg-channel');
  let discussionChannel = interaction.options.getChannel('discussion-channel');
  let newsRole = interaction.options.getRole('news-role');
  let lfgRole = interaction.options.getRole('lfg-role');
  
  await interaction.deferReply({ ephemeral: true });
  
  const { ensureWebhook } = require('../bridge');
  const { setServer } = require('../config');
  const { ChannelType, PermissionsBitField } = require('discord.js');
  
  const botUser = interaction.client.user;
  const botMember = interaction.guild.members.cache.get(botUser.id)
    || await interaction.guild.members.fetch(botUser.id).catch(() => null);
  
  let createdItems = [];
  
  // =============================================================
  // AUTO-CREATE ROLES IF NOT PROVIDED
  // =============================================================
  // Creates @news and @LFG-Network roles if they don't already
  // exist on the server. These are self-assignable ping roles
  // that players opt into to get notified.
  //
  // LEARNING NOTE ON ROLE POSITIONING:
  // Discord roles are ranked by position — higher position = more
  // authority. The bot can only manage roles BELOW its own role.
  // We position these roles at position 1, which is just above
  // @everyone (position 0). This ensures they work correctly
  // for pinging without granting any extra powers.
  // =============================================================
  
  try {
    if (!newsRole) {
      // Check if @news already exists
      newsRole = interaction.guild.roles.cache.find(
        r => r.name.toLowerCase() === 'news'
      );
      if (!newsRole) {
        newsRole = await interaction.guild.roles.create({
          name: 'news',
          mentionable: true,
          reason: 'PDH Bridge Bot — auto-created for news pings',
        });
        createdItems.push('📢 Role: @news');
      }
    }
    
    if (!lfgRole) {
      // Check if @LFG-Network already exists
      lfgRole = interaction.guild.roles.cache.find(
        r => r.name.toLowerCase() === 'lfg-network'
      );
      if (!lfgRole) {
        lfgRole = await interaction.guild.roles.create({
          name: 'LFG-Network',
          mentionable: true,
          reason: 'PDH Bridge Bot — auto-created for LFG pings',
        });
        createdItems.push('🎮 Role: @LFG-Network');
      }
    }
  } catch (err) {
    console.error(`[Setup] Failed to create roles:`, err.message);
    // Non-fatal — continue setup without roles
  }
  
  // =============================================================
  // AUTO-CREATE CHANNELS IF NOT PROVIDED
  // =============================================================
  // Creates a "PDH Network" category with three channels:
  //   1. #pdh-commons  (cross-server chat)
  //   2. #pdh-news     (RSS articles)
  //   3. #pdh-lfg      (matchmaking + scheduling)
  //
  // Channels are positioned in this specific order within the
  // category so the most social channel is on top.
  // =============================================================
  
  if (!newsChannel || !lfgChannel || !discussionChannel) {
    let category = null;
    try {
      // Check if a "PDH Network" category already exists
      category = interaction.guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory &&
             c.name.toLowerCase().includes('pdh')
      );
      
      if (!category) {
        category = await interaction.guild.channels.create({
          name: 'PDH Network',
          type: ChannelType.GuildCategory,
          reason: 'PDH Bridge Bot — auto-created during setup',
        });
        createdItems.push('📁 Category: PDH Network');
      }
    } catch (err) {
      console.error(`[Setup] Failed to create category:`, err.message);
      await interaction.editReply({
        content: `❌ Failed to create category. Make sure the bot has **Manage Channels** permission.\n\nError: ${err.message}`
      });
      return;
    }
    
    try {
      // Create channels in display order: commons, news, lfg
      // Discord sorts channels within a category by "position" value.
      // Lower position = higher in the list.
      
      if (!discussionChannel) {
        discussionChannel = await interaction.guild.channels.create({
          name: 'pdh-commons',
          type: ChannelType.GuildText,
          parent: category,
          position: 0,
          topic: '💬 PDH Commons — Chat with players across all PDH servers.',
          reason: 'PDH Bridge Bot — auto-created during setup',
        });
        createdItems.push('💬 #pdh-commons');
      }
      
      if (!newsChannel) {
        newsChannel = await interaction.guild.channels.create({
          name: 'pdh-news',
          type: ChannelType.GuildText,
          parent: category,
          position: 1,
          topic: '📰 PDH News — Articles and updates from across the PDH community.',
          reason: 'PDH Bridge Bot — auto-created during setup',
        });
        createdItems.push('📰 #pdh-news');
      }
      
      if (!lfgChannel) {
        lfgChannel = await interaction.guild.channels.create({
          name: 'pdh-lfg',
          type: ChannelType.GuildText,
          parent: category,
          position: 2,
          topic: '🎮 PDH LFG — Find games across the PDH network! Type /lfg to start.',
          reason: 'PDH Bridge Bot — auto-created during setup',
        });
        createdItems.push('🎮 #pdh-lfg');
      }
    } catch (err) {
      console.error(`[Setup] Failed to create channels:`, err.message);
      await interaction.editReply({
        content: `❌ Failed to create channels. Make sure the bot has **Manage Channels** permission.\n\nError: ${err.message}`
      });
      return;
    }
  }
  
  // Set up webhooks
  const newsWebhook = newsChannel ? await ensureWebhook(newsChannel, botUser) : null;
  const lfgWebhook = lfgChannel ? await ensureWebhook(lfgChannel, botUser) : null;
  const discussionWebhook = discussionChannel ? await ensureWebhook(discussionChannel, botUser) : null;
  
  const serverData = {
    name: interaction.guild.name,
    channels: {
      news: newsChannel?.id || null,
      lfg: lfgChannel?.id || null,
      discussion: discussionChannel?.id || null,
    },
    webhooks: {
      news: newsWebhook,
      lfg: lfgWebhook,
      discussion: discussionWebhook,
    },
    roles: {
      news: newsRole?.id || null,
      lfg: lfgRole?.id || null,
    },
  };
  
  setServer(config, interaction.guild.id, serverData);
  
  // =============================================================
  // AUTO-CONFIGURE CHANNEL PERMISSIONS
  // =============================================================
  
  let permsStatus = '';
  const everyone = interaction.guild.roles.everyone;
  
  try {
    // --- #pdh-news: Read-only (no human messages) ---
    if (newsChannel) {
      await newsChannel.permissionOverwrites.edit(everyone, {
        SendMessages: false,
        AddReactions: true,
        EmbedLinks: true,
      });
      if (botMember) {
        await newsChannel.permissionOverwrites.edit(botMember, {
          SendMessages: true,
          ManageWebhooks: true,
          ManageMessages: true,
          EmbedLinks: true,
          MentionEveryone: true,
        });
      }
      permsStatus += '📰 News permissions ✅\n';
    }
    
    // --- #pdh-lfg: Open chat + LFG commands ---
    if (lfgChannel) {
      await lfgChannel.permissionOverwrites.edit(everyone, {
        SendMessages: true,
        UseApplicationCommands: true,
        AttachFiles: true,
        EmbedLinks: true,
        ReadMessageHistory: true,
        MentionEveryone: false,
      });
      if (botMember) {
        await lfgChannel.permissionOverwrites.edit(botMember, {
          SendMessages: true,
          ManageWebhooks: true,
          ManageMessages: true,
          EmbedLinks: true,
          AttachFiles: true,
          MentionEveryone: true,
        });
      }
      permsStatus += '🎮 LFG permissions ✅\n';
    }
    
    // --- #pdh-commons: Open chat ---
    if (discussionChannel) {
      await discussionChannel.permissionOverwrites.edit(everyone, {
        SendMessages: true,
        AttachFiles: true,
        EmbedLinks: true,
        ReadMessageHistory: true,
        MentionEveryone: false,
      });
      if (botMember) {
        await discussionChannel.permissionOverwrites.edit(botMember, {
          SendMessages: true,
          ManageWebhooks: true,
          ManageMessages: true,
          EmbedLinks: true,
          AttachFiles: true,
          MentionEveryone: true,
        });
      }
      permsStatus += '💬 Commons permissions ✅\n';
    }
  } catch (err) {
    permsStatus += `⚠️ Some permissions couldn't be set: ${err.message}\n`;
    permsStatus += 'Make sure the bot role is above @everyone in Server Settings > Roles.\n';
    console.error(`[Setup] Permission configuration failed for ${interaction.guild.name}:`, err.message);
  }
  
  // Build the confirmation message
  let confirmation = `✅ **${interaction.guild.name}** is now part of the PDH bridge!\n\n`;
  
  if (createdItems.length > 0) {
    confirmation += `**Created:**\n${createdItems.join('\n')}\n\n`;
  }
  
  confirmation += `**Channels:**\n`;
  if (discussionChannel) confirmation += `💬 Commons: ${discussionChannel} ${discussionWebhook ? '✅' : '❌ webhook failed'}\n`;
  if (newsChannel) confirmation += `📰 News: ${newsChannel} ${newsWebhook ? '✅' : '❌ webhook failed'}\n`;
  if (lfgChannel) confirmation += `🎮 LFG: ${lfgChannel} ${lfgWebhook ? '✅' : '❌ webhook failed'}\n`;
  
  confirmation += `\n**Roles:**\n`;
  if (newsRole) confirmation += `📢 News pings: ${newsRole} ✅\n`;
  if (lfgRole) confirmation += `🎮 LFG pings: ${lfgRole} ✅\n`;
  
  if (permsStatus) confirmation += `\n**Permissions:**\n${permsStatus}`;
  
  await interaction.editReply({ content: confirmation });
  console.log(`[Admin] ${interaction.user.username} set up bridge for ${interaction.guild.name}` +
    (createdItems.length > 0 ? ` (created ${createdItems.length} items)` : ''));
}

// --- /pdh-status ---
async function handleStatus(interaction, config) {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You don\'t have permission to use this command.', ephemeral: true });
    return;
  }
  const servers = Object.entries(config.servers);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📊 PDH Bridge Status')
    .setDescription(`Connected to **${servers.length}** server(s)`)
    .addFields(
      { name: 'Link Filter', value: config.settings.filterLinks ? '🔴 ON' : '🟢 OFF', inline: true },
      { name: 'LFG Expiry', value: `${config.settings.lfgExpiryMinutes} min`, inline: true },
      { name: 'RSS Feed', value: config.settings.rssFeedUrl ? '✅ Active' : '❌ Not set', inline: true },
    );
  for (const [guildId, server] of servers) {
    const channels = [];
    if (server.channels.news) channels.push('📰');
    if (server.channels.lfg) channels.push('🎮');
    if (server.channels.discussion) channels.push('💬');
    embed.addFields({ name: server.name || guildId, value: channels.join(' ') || 'No channels', inline: true });
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// --- /pdh-pin ---
// Posts the pinned explanation message in a channel.
// Supports pinning to LFG, News, or Discussion channels.
async function handlePin(interaction, config) {
  if (!isOwner(interaction)) {
    await interaction.reply({ content: 'Only the bot owner can use this command.', ephemeral: true });
    return;
  }
  
  const channelType = interaction.options.getString('channel');
  
  await interaction.deferReply({ ephemeral: true });
  
  const { postPinnedExplanation } = require('./lfg');
  
  if (channelType === 'lfg') {
    // Pin LFG explanation in the current server's LFG channel
    const serverConfig = config.servers[interaction.guild.id];
    if (!serverConfig?.channels?.lfg) {
      await interaction.editReply({ content: '❌ No LFG channel configured for this server. Run `/pdh-setup` first.' });
      return;
    }
    const channel = interaction.guild.channels.cache.get(serverConfig.channels.lfg);
    if (!channel) {
      await interaction.editReply({ content: '❌ LFG channel not found. It may have been deleted.' });
      return;
    }
    await postPinnedExplanation(channel);
    await interaction.editReply({ content: `✅ Pinned LFG explanation in ${channel}.` });
  } else if (channelType === 'lfg-all') {
    // Pin in ALL servers' LFG channels
    let count = 0;
    for (const [guildId, server] of Object.entries(config.servers)) {
      if (!server.channels.lfg) continue;
      const guild = interaction.client.guilds.cache.get(guildId);
      if (!guild) continue;
      const channel = guild.channels.cache.get(server.channels.lfg);
      if (!channel) continue;
      await postPinnedExplanation(channel);
      count++;
    }
    await interaction.editReply({ content: `✅ Pinned LFG explanation in **${count}** server(s).` });
  } else {
    await interaction.editReply({ content: '❌ Unknown channel type.' });
  }
}

// =============================================================
// HELPERS
// =============================================================

function isAuthorized(interaction) {
  if (interaction.user.id === env.ownerId) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

function isOwner(interaction) {
  return interaction.user.id === env.ownerId;
}

function getStatusText(user) {
  if (user.permanent_ban) return '🚫 Permanently Banned';
  if (user.suspended_until) {
    const until = new Date(user.suspended_until);
    if (until > new Date()) {
      return `⏸️ Suspended until ${until.toLocaleDateString()}`;
    }
  }
  return '✅ Active';
}

module.exports = {
  handleBan, handleUnban, handleStrikes, handleConfig,
  handleSetup, handleStatus, handlePin,
};
