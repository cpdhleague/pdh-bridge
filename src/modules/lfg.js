// =============================================================
// lfg.js - Looking For Game system (PDH-specific)
// =============================================================
// Users click one of two buttons to create an LFG post:
//   🏆 Wanderer's League → displayed as "PDH - League"
//   🎮 Non-League        → displayed as "PDH Games"
//
// Flow:
// 1. User types /lfg → sees two buttons to choose game type
// 2. Clicking a button opens a modal for notes (start time, etc.)
// 3. Bot creates a formatted embed, broadcasts to all servers
// 4. Other users click Join — tracked individually in the database
// 5. When 4 players join, bot DMs ALL 4 with each other's names
//    and a link to Convoke Games to start their match
// 6. Posts auto-delete on expiry OR cancellation across ALL servers
//
// LEARNING NOTE: This module uses a multi-step interaction flow:
//   Slash command → Buttons → Modal → Broadcast → Button interactions
// Each step is a separate "interaction" that Discord sends to the bot.
// We use custom IDs (like "lfg_type_league") to tell them apart.
// =============================================================

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { broadcastEmbed, deleteAcrossServers } = require('../bridge');
const db = require('../database');
const { createConvokeRoom } = require('./convoke');
const { env } = require('../config');

// =============================================================
// DISPLAY NAMES for game types
// These map internal values to what users see in embeds
// =============================================================
const GAME_TYPE_DISPLAY = {
  league: 'PDH — League',
  casual: 'PDH Games',
};

const GAME_TYPE_EMOJI = {
  league: '🏆',
  casual: '🎮',
};

const GAME_TYPE_COLOR = {
  league: 0xF1C40F, // Gold
  casual: 0x57F287,  // Green
};

// =============================================================
// STEP 1: Handle /lfg slash command → show game type buttons
// =============================================================

async function handleLfgCommand(interaction) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lfg_type_league')
      .setLabel("Wanderer's League")
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🏆'),
    new ButtonBuilder()
      .setCustomId('lfg_type_casual')
      .setLabel('Non-League Game')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎮'),
  );
  
  await interaction.reply({
    content: '**What type of PDH game are you looking for?**',
    components: [row],
    ephemeral: true, // Only the user sees this
  });
}

// =============================================================
// STEP 2: Handle game type button click → show notes modal
// =============================================================

async function handleTypeSelection(interaction) {
  // Extract game type from the button's custom ID
  // "lfg_type_league" → "league", "lfg_type_casual" → "casual"
  const gameType = interaction.customId.replace('lfg_type_', '');
  
  const modal = new ModalBuilder()
    .setCustomId(`lfg_modal_${gameType}`)
    .setTitle(`Create LFG — ${GAME_TYPE_DISPLAY[gameType]}`);
  
  // Notes field (optional) — for start time, house rules, etc.
  const notesInput = new TextInputBuilder()
    .setCustomId('lfg_notes')
    .setLabel('Notes (start time, house rules, etc.)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g., Starting in 15 minutes, no infinites, casual power level')
    .setMaxLength(500)
    .setRequired(false);
  
  modal.addComponents(
    new ActionRowBuilder().addComponents(notesInput),
  );
  
  await interaction.showModal(modal);
}

// =============================================================
// STEP 3: Handle modal submit → create & broadcast LFG post
// =============================================================

async function handleLfgModalSubmit(interaction, config) {
  // Extract game type from the modal's custom ID
  const gameType = interaction.customId.replace('lfg_modal_', '');
  const notes = interaction.fields.getTextInputValue('lfg_notes') || '';
  const maxPlayers = 4; // Always 4 for PDH
  
  // Calculate expiry time
  const expiryMinutes = config.settings.lfgExpiryMinutes || 60;
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();
  
  const creatorName = interaction.user.displayName || interaction.user.username;
  
  // Create the database record (auto-adds creator as player #1)
  const lfgPostId = db.createLfgPost(
    interaction.user.id,
    creatorName,
    gameType,
    notes,
    maxPlayers,
    expiresAt
  );
  
  // Build the embed
  const embed = buildLfgEmbed({
    id: lfgPostId,
    creator_id: interaction.user.id,
    creator_name: creatorName,
    game_type: gameType,
    notes,
    max_players: maxPlayers,
    current_players: 1,
    expires_at: expiresAt,
  }, interaction.user);
  
  // Build the Join / Leave / Cancel buttons
  const buttons = buildLfgButtons(lfgPostId, 1, maxPlayers);
  
  // Acknowledge immediately (Discord gives us 3 seconds to respond)
  await interaction.reply({
    content: `${GAME_TYPE_EMOJI[gameType]} Your **${GAME_TYPE_DISPLAY[gameType]}** post is being broadcast to all PDH servers!`,
    ephemeral: true,
  });
  
  // Broadcast to ALL servers (including this one)
  try {
    const results = await broadcastEmbed(config, 'lfg', embed, {
      includeSource: interaction.guild.id,
      username: 'PDH LFG',
      pingRole: true,
      components: [buttons],
    });
    
    // Track every message ID so we can delete across all servers later
    for (const result of results) {
      db.addLfgMessage(lfgPostId, result.guildId, result.channelId, result.messageId);
    }
    
    console.log(`[LFG] Post #${lfgPostId} (${GAME_TYPE_DISPLAY[gameType]}) broadcast to ${results.length} servers`);
  } catch (err) {
    console.error('[LFG] Failed to broadcast:', err.message);
  }
}

// =============================================================
// STEP 4: Handle Join / Leave / Cancel button clicks
// =============================================================

async function handleLfgButton(interaction, config, client) {
  const customId = interaction.customId;
  
  // Parse the custom ID: "lfg_join_42" → action="join", postId=42
  const parts = customId.split('_');
  const action = parts[1]; // "join", "leave", or "cancel"
  const postId = parseInt(parts[2]);
  
  const post = db.getLfgPost(postId);
  if (!post) {
    await interaction.reply({ content: 'This LFG post has expired or been cancelled.', ephemeral: true });
    return;
  }
  
  const username = interaction.user.displayName || interaction.user.username;
  
  // --- CANCEL ---
  if (action === 'cancel') {
    // Only the creator can cancel
    if (interaction.user.id !== post.creator_id) {
      await interaction.reply({ content: 'Only the post creator can cancel this LFG.', ephemeral: true });
      return;
    }
    
    // Delete across ALL servers
    const messages = db.getLfgMessages(postId);
    await deleteAcrossServers(client, messages);
    db.markLfgExpired(postId);
    
    await interaction.reply({
      content: '❌ LFG post cancelled and removed from all servers.',
      ephemeral: true,
    });
    console.log(`[LFG] Post #${postId} cancelled by creator`);
    return;
  }
  
  // --- JOIN ---
  if (action === 'join') {
    const result = db.addLfgPlayer(postId, interaction.user.id, username);
    
    if (!result.success) {
      if (result.reason === 'already_joined') {
        await interaction.reply({ content: "You're already in this game!", ephemeral: true });
      }
      return;
    }
    
    await interaction.reply({
      content: `🎮 You're in! (${result.currentPlayers}/${result.maxPlayers} players)`,
      ephemeral: true,
    });
    
    // Update the embed on all servers to show new player count
    await updateAllLfgEmbeds(client, postId);
    
    // CHECK: Is the lobby now full?
    if (result.currentPlayers >= result.maxPlayers) {
      console.log(`[LFG] Post #${postId} is FULL! Sending Convoke DMs...`);
      
      // Get all players
      const players = db.getLfgPlayers(postId);
      
      // DM all players with the Convoke link and each other's names
      await sendConvokeDMs(client, post, players, postId);
      
      // Wait 30 seconds, then delete the post from all servers
      // This gives people a moment to see it filled up
      setTimeout(async () => {
        try {
          const messages = db.getLfgMessages(postId);
          await deleteAcrossServers(client, messages);
          db.markLfgExpired(postId);
          console.log(`[LFG] Post #${postId} cleaned up after filling`);
        } catch (err) {
          console.error(`[LFG] Cleanup failed for post #${postId}:`, err.message);
        }
      }, 30000); // 30 second delay
    }
    return;
  }
  
  // --- LEAVE ---
  if (action === 'leave') {
    // Creator can't leave (they should cancel instead)
    if (interaction.user.id === post.creator_id) {
      await interaction.reply({
        content: "As the host, you can't leave — use **Cancel** to remove the post.",
        ephemeral: true,
      });
      return;
    }
    
    const result = db.removeLfgPlayer(postId, interaction.user.id);
    
    if (!result.success) {
      await interaction.reply({ content: "You're not in this game.", ephemeral: true });
      return;
    }
    
    await interaction.reply({
      content: `👋 You've left the lobby. (${result.currentPlayers}/${post.max_players} players)`,
      ephemeral: true,
    });
    
    // Update the embed on all servers
    await updateAllLfgEmbeds(client, postId);
    return;
  }
}

// =============================================================
// CONVOKE ROOM CREATION + DM SYSTEM
// =============================================================
// When 4 players join, this function:
//   1. Calls the Convoke API to auto-create a private game room
//   2. DMs ALL 4 players with the room link + each other's names
//   3. For league games, also includes a link to log on cpdh.guide
//
// LEARNING NOTE ON GRACEFUL DEGRADATION:
// If the API call fails (network issue, bad token, etc.), we don't
// just give up silently. Instead, we "fall back" to a manual link
// to convoke.games so players can still create a room themselves.
// This pattern is called "graceful degradation" — always provide
// a usable experience even when something goes wrong.
// =============================================================

async function sendConvokeDMs(client, post, players, postId) {
  const gameTypeDisplay = GAME_TYPE_DISPLAY[post.game_type] || 'PDH Games';
  const emoji = GAME_TYPE_EMOJI[post.game_type] || '🎮';
  const isLeague = post.game_type === 'league';

  // --- Step 1: Create the Convoke room via API ---
  // We need a guild ID and channel ID for Convoke's tracking.
  // We get these from the first tracked message for this post.
  const messages = db.getLfgMessages(postId);
  const firstMsg = messages[0] || {};

  // Build the player list for the API call
  const apiPlayers = players.map(p => ({
    userId: p.user_id,
    username: p.username,
  }));

  // Call the Convoke API (see modules/convoke.js)
  const convokeToken = env.convokeToken;
  let gameUrl = await createConvokeRoom(
    convokeToken,
    postId,
    firstMsg.guild_id || 'unknown',
    firstMsg.channel_id || 'unknown',
    apiPlayers
  );

  // --- Step 2: Build the DM message ---
  const playerList = players.map((p, i) => {
    const tag = i === 0 ? ' *(host)*' : '';
    return `• **${p.username}**${tag}`;
  }).join('\n');

  let dmMessage;

  if (gameUrl) {
    // SUCCESS — API created the room, send the link directly
    dmMessage =
      `${emoji} **Your ${gameTypeDisplay} game is ready!** (LFG #${postId})\n\n` +
      `**Players:**\n${playerList}\n\n` +
      (post.notes ? `📝 **Notes:** ${post.notes}\n\n` : '') +
      `🎮 **Join your game on Convoke:**\n${gameUrl}\n\n` +
      `Click the link above, log in to Convoke, and you'll be placed in your private 4-player PDH room ` +
      `with 30 starting life.\n`;
  } else {
    // FALLBACK — API failed, give them the manual approach
    console.warn(`[LFG] Convoke API failed for game #${postId} — sending fallback DMs`);
    const host = players[0];
    dmMessage =
      `${emoji} **Your ${gameTypeDisplay} game is ready!** (LFG #${postId})\n\n` +
      `**Players:**\n${playerList}\n\n` +
      (post.notes ? `📝 **Notes:** ${post.notes}\n\n` : '') +
      `⚠️ *Automatic room creation failed. Please create a room manually:*\n` +
      `1. Go to **[Convoke Games](https://convoke.games)** and log in\n` +
      `2. **${host.username}** (host): Create a new room and share the link\n` +
      `3. Everyone else: Join when the host shares the link\n`;
  }

  // For LEAGUE games, add a reminder to log the game on cpdh.guide
  if (isLeague) {
    dmMessage +=
      `\n🏆 **Wanderer's League Reminder:**\n` +
      `Don't forget to log your game results at **[cPDH Guide](https://app.cpdh.guide)**!\n`;
  }

  dmMessage += `\n*Have a great game! 🎉*`;

  // --- Step 3: DM each player ---
  let dmSuccessCount = 0;
  for (const player of players) {
    try {
      const user = await client.users.fetch(player.user_id);
      await user.send(dmMessage);
      dmSuccessCount++;
    } catch (err) {
      // LEARNING NOTE: The most common reason DMs fail is that the
      // user has DMs disabled for server members. There's nothing
      // we can do about this — that's their privacy setting.
      console.log(`[LFG] Couldn't DM ${player.username} — DMs may be disabled`);
    }
  }

  console.log(`[LFG] Game #${postId}: Sent DMs to ${dmSuccessCount}/${players.length} players` +
    (gameUrl ? ` with Convoke link` : ` (fallback — API failed)`));
}

// =============================================================
// EMBED BUILDING
// =============================================================

function buildLfgEmbed(post, user) {
  const gameType = post.game_type || 'casual';
  const display = GAME_TYPE_DISPLAY[gameType] || 'PDH Games';
  const emoji = GAME_TYPE_EMOJI[gameType] || '🎮';
  const color = GAME_TYPE_COLOR[gameType] || 0x57F287;
  
  // Build the player roster
  const players = db.getLfgPlayers(post.id);
  let rosterText = '';
  if (players && players.length > 0) {
    rosterText = players.map((p, i) => {
      const tag = i === 0 ? ' *(host)*' : '';
      return `${i + 1}. ${p.username}${tag}`;
    }).join('\n');
    // Fill remaining slots with "Open"
    for (let i = players.length; i < post.max_players; i++) {
      rosterText += `\n${i + 1}. *(open)*`;
    }
  } else {
    rosterText = `1. ${post.creator_name} *(host)*`;
    for (let i = 1; i < post.max_players; i++) {
      rosterText += `\n${i + 1}. *(open)*`;
    }
  }
  
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${display} — Looking for Players!`)
    .addFields(
      { name: 'Players', value: rosterText },
    )
    .setFooter({ text: `LFG #${post.id} • Expires` })
    .setTimestamp(new Date(post.expires_at));
  
  // Add notes if present
  if (post.notes && post.notes.trim().length > 0) {
    embed.setDescription(`📝 ${post.notes}`);
  }
  
  if (user) {
    embed.setThumbnail(user.displayAvatarURL({ size: 64 }));
  }
  
  return embed;
}

function buildLfgButtons(postId, currentPlayers, maxPlayers) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lfg_join_${postId}`)
      .setLabel(`Join (${currentPlayers}/${maxPlayers})`)
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎮')
      .setDisabled(currentPlayers >= maxPlayers),
    new ButtonBuilder()
      .setCustomId(`lfg_leave_${postId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`lfg_cancel_${postId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

// =============================================================
// UPDATE EMBEDS ACROSS ALL SERVERS
// =============================================================
// When someone joins or leaves, we need to update the embed
// on every server to reflect the new player count and roster.
//
// LEARNING NOTE: This fetches each message by ID and edits it.
// We use the webhook client to edit webhook-sent messages.

async function updateAllLfgEmbeds(client, postId) {
  const post = db.getLfgPost(postId);
  if (!post) return;
  
  const messages = db.getLfgMessages(postId);
  const embed = buildLfgEmbed(post, null);
  const buttons = buildLfgButtons(postId, post.current_players, post.max_players);
  
  await Promise.allSettled(
    messages.map(async ({ guildId, channelId, messageId }) => {
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return;
        
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (msg) {
          await msg.edit({
            embeds: [embed],
            components: [buttons],
          });
        }
      } catch (err) {
        // Silent fail — message may have been deleted
      }
    })
  );
}

// =============================================================
// CLEANUP: Auto-delete expired LFG posts
// =============================================================

async function cleanupExpiredPosts(client) {
  const expired = db.getExpiredLfgPosts();
  for (const post of expired) {
    try {
      const messages = db.getLfgMessages(post.id);
      await deleteAcrossServers(client, messages);
      db.markLfgExpired(post.id);
      console.log(`[LFG] Cleaned up expired post #${post.id}`);
    } catch (err) {
      console.error(`[LFG] Failed to clean up post #${post.id}:`, err.message);
    }
  }
}

// =============================================================
// PINNED EXPLANATION MESSAGE
// =============================================================
// Posts and pins a permanent explanation message in an LFG channel.
// This only needs to be done once per server.

async function postPinnedExplanation(channel) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2) // Discord blurple
    .setTitle('🎮 PDH Looking For Game (LFG)')
    .setDescription(
      '**Welcome to the PDH LFG channel!**\n\n' +
      'This channel connects you with players across all PDH community servers. ' +
      'When you find a game here, you\'re matching with the entire PDH network!\n\n' +
      '**How it works:**\n' +
      '1. Type `/lfg` to create a new game post\n' +
      '2. Choose **Wanderer\'s League** (🏆) or **Non-League** (🎮)\n' +
      '3. Add any notes (start time, house rules, etc.)\n' +
      '4. Your post appears on every PDH server in the network\n' +
      '5. When all 4 seats fill, everyone gets a DM with an **auto-generated Convoke Games room link** — just click and play!\n\n' +
      '**Game Types:**\n' +
      '🏆 **PDH — League** — Wanderer\'s League sanctioned games. When the lobby fills, you\'ll also get a reminder to log your game at [cPDH Guide](https://app.cpdh.guide)\n' +
      '🎮 **PDH Games** — Casual, non-league games\n\n' +
      '**Tips:**\n' +
      '• Posts auto-expire after 1 hour if they don\'t fill\n' +
      '• The host can cancel at any time with the Cancel button\n' +
      '• You can\'t join the same game twice\n' +
      '• Make sure your DMs are open so the bot can send you the game link!'
    )
    .setFooter({ text: 'PDH Bridge Network • LFG System' });
  
  try {
    const msg = await channel.send({ embeds: [embed] });
    await msg.pin();
    console.log(`[LFG] Pinned explanation in #${channel.name} on ${channel.guild.name}`);
    return msg;
  } catch (err) {
    console.error(`[LFG] Failed to pin explanation in ${channel.guild.name}:`, err.message);
    return null;
  }
}

module.exports = {
  handleLfgCommand,
  handleTypeSelection,
  handleLfgModalSubmit,
  handleLfgButton,
  cleanupExpiredPosts,
  postPinnedExplanation,
  GAME_TYPE_DISPLAY,
};
