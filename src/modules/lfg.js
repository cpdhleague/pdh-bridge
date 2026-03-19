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
  league: 'PDH — Wanderer\'s League',
  casual: 'PDH Game',
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
// THUMBNAIL IMAGES for embed posts
// Change these URLs to your own images!
// Recommended size: 128x128 or 256x256 pixels.
// Must be a direct link to an image file (PNG, JPG, GIF).
// =============================================================
const GAME_TYPE_THUMBNAIL = {
  league: 'https://raw.githubusercontent.com/TryhardClay/PDH-LFG-Bot/main/PDHBot.jpg',
  casual: 'https://raw.githubusercontent.com/TryhardClay/PDH-LFG-Bot/main/PDHBot.jpg',
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
// STEP 2: Handle game type button click
// =============================================================
// Both League and Non-League now post immediately — no extra
// popups or modals. One click and you're looking for a game.
// This emulates SpellBot's streamlined approach.
// =============================================================

async function handleTypeSelection(interaction, config) {
  const gameType = interaction.customId.replace('lfg_type_', '');
  
  // SIMPLIFIED FLOW (emulating SpellBot):
  // Both game types now post immediately — no modal, no extra popups.
  // One click on League or Non-League and you're in.
  await createAndBroadcastLfg(interaction, config, gameType, '');
}

// =============================================================
// STEP 3a: Handle modal submit (casual games only)
// =============================================================

async function handleLfgModalSubmit(interaction, config) {
  // Extract game type from the modal's custom ID
  const gameType = interaction.customId.replace('lfg_modal_', '');
  const notes = interaction.fields.getTextInputValue('lfg_notes') || '';
  
  await createAndBroadcastLfg(interaction, config, gameType, notes);
}

// =============================================================
// STEP 3b: Create & broadcast the LFG post
// =============================================================
// This is the shared function that both league (direct from button)
// and casual (from modal submit) game flows call.
// =============================================================

async function createAndBroadcastLfg(interaction, config, gameType, notes) {
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
  // NOTE: We do NOT pass includeSource or excludeGuildId here.
  // getRelayTargets() returns ALL configured servers by default,
  // which includes the server where /lfg was used. The earlier
  // bug was that includeSource ADDED the host server a second time
  // on top of it already being in the list — causing double posts.
  try {
    const results = await broadcastEmbed(config, 'lfg', embed, {
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
      } else if (result.reason === 'lobby_full') {
        await interaction.reply({ content: '🚫 This lobby is already full!', ephemeral: true });
      }
      return;
    }
    
    await interaction.reply({
      content: `🎮 You're in! (${result.currentPlayers}/${result.maxPlayers} players)`,
      ephemeral: true,
    });
    
    // Update the embed on all servers to show new player count
    await updateAllLfgEmbeds(client, postId, config);
    
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
    await updateAllLfgEmbeds(client, postId, config);
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
      `\n🏆 **League Reminder:**\n` +
      `Don't forget to start your league lobby and get seating order from the ` +
      `**[Wanderer's League](https://app.cpdh.guide)** webapp.\n`;
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
  
  // Use the game-type logo instead of the user's personal avatar.
  // This keeps branding consistent — league posts show the league logo,
  // casual posts show a generic PDH/MTG logo.
  const thumbnail = GAME_TYPE_THUMBNAIL[gameType] || GAME_TYPE_THUMBNAIL.casual;
  if (thumbnail) {
    embed.setThumbnail(thumbnail);
  }
  
  return embed;
}

function buildLfgButtons(postId, currentPlayers, maxPlayers) {
  // If the lobby is full, return NO buttons at all.
  // The embed itself will show the "Game Ready" state.
  if (currentPlayers >= maxPlayers) {
    return new ActionRowBuilder().addComponents(
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

  // Not full — show Join, Leave, and Cancel
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lfg_join_${postId}`)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎮'),
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
// LEARNING NOTE ON WEBHOOK MESSAGES:
// Messages sent via webhooks are "owned" by that webhook, not
// by the bot. So you can't edit them with channel.messages.fetch()
// — you must use the SAME webhook that sent them. That's why we
// look up the webhook URL from the config for each server.
//
// CRITICAL: When editing webhook messages, the components (buttons)
// must be serialized to JSON. Passing raw ActionRow objects works
// for webhook.send() but NOT for webhook.editMessage(). This was
// the root cause of the "embeds don't update" bug — the edit call
// was throwing an error that got silently caught.
// =============================================================

async function updateAllLfgEmbeds(client, postId, config) {
  const { WebhookClient } = require('discord.js');
  
  const post = db.getLfgPost(postId);
  if (!post) return;
  
  const messages = db.getLfgMessages(postId);
  const players = db.getLfgPlayers(postId);
  const isFull = players.length >= post.max_players;
  
  // Build the updated embed (with current player roster)
  const embed = isFull
    ? buildFullLobbyEmbed(post, players)
    : buildLfgEmbed(post, null);
  
  // Build buttons: Join button disappears when full, Leave/Cancel stay
  const buttonRow = isFull
    ? []   // No buttons at all when full (embed shows "Game Ready")
    : [buildLfgButtons(postId, players.length, post.max_players)];
  
  // LEARNING NOTE: We need TWO versions of the embed and components —
  // one for regular message edits (raw objects), one for webhook edits
  // (serialized JSON). This is because discord.js WebhookClient.editMessage()
  // requires plain JSON, while regular Message.edit() accepts builder objects.
  const embedJson = embed.toJSON ? embed.toJSON() : embed;
  const componentsJson = buttonRow.map(c => c.toJSON ? c.toJSON() : c);

  console.log(`[LFG] Updating embeds for post #${postId} across ${messages.length} servers (${players.length}/${post.max_players} players)`);
  
  const results = await Promise.allSettled(
    messages.map(async ({ guildId, channelId, messageId }) => {
      // Look up this server's webhook URL from the config
      const serverConfig = config?.servers?.[guildId];
      const webhookUrl = serverConfig?.webhooks?.lfg;
      
      if (!webhookUrl) {
        // No webhook URL for this server — try editing as a regular message.
        // This only works if the bot itself sent it (not via webhook).
        console.warn(`[LFG] No webhook URL for guild ${guildId} — attempting regular edit`);
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) { console.warn(`[LFG] Guild ${guildId} not in cache`); return; }
          const channel = guild.channels.cache.get(channelId);
          if (!channel) { console.warn(`[LFG] Channel ${channelId} not in cache`); return; }
          const msg = await channel.messages.fetch(messageId).catch(() => null);
          if (msg) {
            await msg.edit({ embeds: [embed], components: buttonRow });
            console.log(`[LFG] Updated embed in guild ${guildId} via regular edit`);
          } else {
            console.warn(`[LFG] Message ${messageId} not found in channel ${channelId}`);
          }
        } catch (err) {
          console.error(`[LFG] Regular edit failed for guild ${guildId}:`, err.message);
        }
        return;
      }
      
      // Use the webhook to edit ITS OWN message
      try {
        const webhook = new WebhookClient({ url: webhookUrl });
        await webhook.editMessage(messageId, {
          embeds: [embedJson],
          components: componentsJson,
        });
        console.log(`[LFG] Updated embed in guild ${guildId} via webhook`);
      } catch (err) {
        console.error(`[LFG] Webhook edit FAILED for guild ${guildId}, message ${messageId}:`, err.message);
        
        // FALLBACK: If webhook edit fails, try fetching and editing
        // the message directly. This can happen if the webhook was
        // recreated or the message ownership is confused.
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return;
          const channel = guild.channels.cache.get(channelId);
          if (!channel) return;
          const msg = await channel.messages.fetch(messageId).catch(() => null);
          if (msg) {
            await msg.edit({ embeds: [embed], components: buttonRow });
            console.log(`[LFG] Fallback regular edit succeeded for guild ${guildId}`);
          }
        } catch (fallbackErr) {
          console.error(`[LFG] Fallback edit also failed for guild ${guildId}:`, fallbackErr.message);
        }
      }
    })
  );
}

// =============================================================
// BUILD THE "LOBBY FULL" EMBED
// =============================================================
// When 4 players join, the embed changes to a "Game Ready" state.
// Buttons are removed, and the embed shows all 4 players.
// This gives users visual confidence that the system worked.
//
// TO CUSTOMIZE THE LANGUAGE: Edit the strings in this function.
// The setTitle, setDescription, and field values are all just
// template strings you can change freely.
// =============================================================

function buildFullLobbyEmbed(post, players) {
  const gameType = post.game_type || 'casual';
  const display = GAME_TYPE_DISPLAY[gameType] || 'PDH Games';
  const emoji = GAME_TYPE_EMOJI[gameType] || '🎮';
  const isLeague = gameType === 'league';
  
  const rosterText = players.map((p, i) => {
    const tag = i === 0 ? ' *(host)*' : '';
    return `${i + 1}. ${p.username}${tag}`;
  }).join('\n');
  
  const embed = new EmbedBuilder()
    .setColor(0x57F287) // Green = success
    .setTitle(`${emoji} ${display} — Game Ready!`)
    .setDescription(
      `All seats are filled! Check your DMs for a **Convoke** game link.` +
      (isLeague ? `\n🏆 Remember to log your game at [cPDH Guide](https://app.cpdh.guide)!` : '')
    )
    .addFields(
      { name: 'Players', value: rosterText },
    )
    .setFooter({ text: `LFG #${post.id} • Game started` })
    .setTimestamp(new Date());
  
  if (post.notes && post.notes.trim().length > 0) {
    embed.addFields({ name: 'Notes', value: `📝 ${post.notes}` });
  }
  
  return embed;
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
      '🏆 **PDH — Wanderer\'s League** — Wanderer\'s League sanctioned games. When the lobby fills, you\'ll also get a reminder to log your game at [cPDH Guide](https://app.cpdh.guide)\n' +
      '🎮 **PDH Game** — Casual, non-league games\n\n' +
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

// =============================================================
// DAILY CHANNEL WIPE
// =============================================================
// Deletes all non-pinned messages in every LFG channel at 3am
// Central time. Pinned messages (like the explanation post) survive.
//
// LEARNING NOTE ON BULK DELETE:
// Discord's bulkDelete() can remove up to 100 messages at once,
// but only if they're less than 14 days old. For older messages,
// we have to delete them one-by-one. We handle both cases.
//
// LEARNING NOTE ON TIMEZONES:
// We use JavaScript's Intl API to check the current time in
// "America/Chicago" (US Central). This automatically handles
// Daylight Saving Time — you don't need to manually adjust
// for CST vs CDT.
// =============================================================

async function wipeLfgChannels(client, config) {
  console.log('[LFG] Starting daily LFG channel wipe...');
  
  for (const [guildId, server] of Object.entries(config.servers)) {
    const lfgChannelId = server.channels?.lfg;
    if (!lfgChannelId) continue;
    
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.log(`[LFG] Wipe: Not in guild ${guildId}, skipping`);
        continue;
      }
      
      const channel = guild.channels.cache.get(lfgChannelId);
      if (!channel) {
        console.log(`[LFG] Wipe: Channel ${lfgChannelId} not found in ${guild.name}, skipping`);
        continue;
      }
      
      // Fetch messages in batches (Discord API returns max 100 at a time)
      let deletedCount = 0;
      let lastMessageId = null;
      let keepFetching = true;
      
      while (keepFetching) {
        const fetchOptions = { limit: 100 };
        if (lastMessageId) fetchOptions.before = lastMessageId;
        
        const messages = await channel.messages.fetch(fetchOptions);
        if (messages.size === 0) break;
        
        // Filter out pinned messages — those stay
        const toDelete = messages.filter(msg => !msg.pinned);
        
        if (toDelete.size > 0) {
          // Try bulkDelete first (only works for messages < 14 days old)
          try {
            const deleted = await channel.bulkDelete(toDelete, true); // true = filter old messages
            deletedCount += deleted.size;
            
            // If bulkDelete filtered some out (too old), delete those one-by-one
            const remaining = toDelete.filter(msg => !deleted.has(msg.id));
            for (const [, msg] of remaining) {
              try {
                await msg.delete();
                deletedCount++;
                // Small delay to avoid rate limits on individual deletes
                await new Promise(r => setTimeout(r, 500));
              } catch (e) {
                // Message may already be deleted, skip
              }
            }
          } catch (err) {
            // bulkDelete failed entirely — delete one by one
            for (const [, msg] of toDelete) {
              try {
                await msg.delete();
                deletedCount++;
                await new Promise(r => setTimeout(r, 500));
              } catch (e) {
                // Skip if already deleted
              }
            }
          }
        }
        
        // If we got fewer than 100, there are no more messages
        if (messages.size < 100) {
          keepFetching = false;
        } else {
          lastMessageId = messages.last().id;
        }
      }
      
      console.log(`[LFG] Wipe: Deleted ${deletedCount} messages in #${channel.name} on ${guild.name} (pinned messages preserved)`);
      
    } catch (err) {
      console.error(`[LFG] Wipe failed for guild ${guildId}:`, err.message);
    }
  }
  
  // Also clear any expired/stale LFG posts from the database
  const expired = db.getExpiredLfgPosts();
  for (const post of expired) {
    db.markLfgExpired(post.id);
  }
  
  console.log('[LFG] Daily wipe complete.');
}

module.exports = {
  handleLfgCommand,
  handleTypeSelection,
  handleLfgModalSubmit,
  handleLfgButton,
  cleanupExpiredPosts,
  wipeLfgChannels,
  postPinnedExplanation,
  GAME_TYPE_DISPLAY,
};
