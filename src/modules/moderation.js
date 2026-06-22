// =============================================================
// moderation.js - Profanity filter & strike system
// =============================================================
// This module checks messages BEFORE they get relayed to other
// servers. If a message contains foul language, it gets blocked,
// deleted, and the user receives a DM with their warning/suspension.
//
// LEARNING NOTE: This is a "middleware" pattern - the message
// passes through this filter before reaching the relay. If the
// filter rejects it, the relay never happens. This is how we
// ensure bad language never reaches other servers.
// =============================================================

const Filter = require('bad-words');
const db = require('../database');
const { env } = require('../config');

// Initialize the profanity filter with default English word list
// You can customize this by adding/removing words
const filter = new Filter();

// Add any additional words specific to your community
// filter.addWords('customword1', 'customword2');

// Remove words you consider acceptable (if any)
// filter.removeWords('damn', 'hell');

/**
 * Check if a message contains profanity.
 * Returns { isProfane: boolean, cleaned: string }
 * 
 * LEARNING NOTE: The bad-words library works by checking each word
 * against a dictionary. It also catches common evasion tricks like
 * replacing letters with symbols (f*ck, sh!t, etc.) though no
 * filter is 100% perfect.
 */
function checkProfanity(content) {
  try {
    const isProfane = filter.isProfane(content);
    const cleaned = filter.clean(content); // Replaces bad words with ****
    return { isProfane, cleaned };
  } catch (err) {
    // If the filter errors, let the message through (fail open)
    // We don't want the bot to break because of an edge case
    console.error('[Moderation] Profanity check error:', err.message);
    return { isProfane: false, cleaned: content };
  }
}

/**
 * Check if a message contains links (URLs).
 * Used when link filtering is enabled.
 */
function containsLinks(content) {
  const urlRegex = /https?:\/\/[^\s]+/gi;
  return urlRegex.test(content);
}

/**
 * Check if a message contains a Discord invite link.
 *
 * LEARNING NOTE: Discord invite links come in many forms that all
 * redirect to the same place. Spam bots love to mix these up to
 * dodge naive filters. We catch them ALL:
 *
 *   discord.gg/xyz              (short form — most common)
 *   discord.com/invite/xyz      (long form)
 *   discordapp.com/invite/xyz   (legacy domain)
 *   dsc.gg/xyz                  (third-party shortener)
 *   invite.gg/xyz               (third-party shortener)
 *
 * We also match with or without protocol (https://) and with or
 * without www. prefix. Case-insensitive across the board.
 */
function containsDiscordInvite(content) {
  if (!content) return false;
  const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:\.com|app\.com|\.gg|\.me)|dsc\.gg|invite\.gg)\/(?:invite\/)?[a-z0-9-]+/i;
  return inviteRegex.test(content);
}

/**
 * Strip all mentions from a message, replacing them with readable
 * names instead of [role] or [user]. This way cross-server users
 * can still see WHO was mentioned even though the ping won't work.
 *
 * LEARNING NOTE: Discord mentions are stored as special syntax:
 *   <@&123456789>  = role mention (the & means role)
 *   <@123456789>   = user mention
 *   <@!123456789>  = user mention with nickname
 *
 * We look up the ID in the guild's cache to get the actual name,
 * then display it as plain text with an @ prefix so it's obvious
 * it was a mention, just not a clickable one.
 */
function stripMentions(content, guild) {
  let result = content
    .replace(/@everyone/g, '@\u200beveryone')
    .replace(/@here/g, '@\u200bhere');
  
  // Replace role mentions with readable names
  result = result.replace(/<@&(\d+)>/g, (match, roleId) => {
    if (guild) {
      const role = guild.roles.cache.get(roleId);
      if (role) return `@${role.name}`;
    }
    return '@unknown-role';
  });
  
  // Replace user mentions with readable names
  result = result.replace(/<@!?(\d+)>/g, (match, userId) => {
    if (guild) {
      const member = guild.members.cache.get(userId);
      if (member) return `@${member.displayName}`;
    }
    return '@someone';
  });
  
  return result;
}

/**
 * Strip links from a message, replacing them with a notice.
 */
function stripLinks(content) {
  return content.replace(/https?:\/\/[^\s]+/gi, '[link removed]');
}

/**
 * Strip custom (external) emojis from a message.
 * Custom emojis look like <:name:123456> or <a:name:123456> for animated ones.
 */
function stripExternalEmojis(content, guildEmojis) {
  // Match all custom emoji patterns
  return content.replace(/<a?:(\w+):(\d+)>/g, (match, name, id) => {
    // Keep emojis from the current server, strip others
    if (guildEmojis && guildEmojis.has(id)) {
      return match; // Keep local emojis
    }
    return `:${name}:`; // Replace external emojis with just the name
  });
}

/**
 * Build the DM message to send to a user who received a strike.
 * This is the friendly-but-firm message you described.
 */
function buildStrikeDM(username, strikeResult) {
  const { strikeCount, suspendedUntil, actionTaken } = strikeResult;
  
  let message = `**PDH Bridge Notice**\n\n`;
  message += `Hi ${username}, your message was flagged for language that doesn't meet our community guidelines. `;
  message += `Because PDH bridge channels connect multiple Discord servers — some of which are family-friendly `;
  message += `and encourage teens and kids to participate — we ask everyone to keep things clean. `;
  message += `Thank you for helping us do that. ❤️\n\n`;
  
  if (strikeCount === 1) {
    message += `📋 **This is a friendly warning** (Strike 1). No action has been taken against your account.\n`;
    message += `Please be mindful of your language in PDH bridge channels going forward.`;
  } else {
    // Calculate the human-readable suspension duration
    const suspensionText = getSuspensionText(strikeCount);
    const expiryDate = new Date(suspendedUntil);
    const dateString = expiryDate.toLocaleDateString('en-US', { 
      month: 'long', day: 'numeric', year: 'numeric' 
    });
    
    message += `⚠️ **Strike ${strikeCount}** — Your messages will not be relayed to other PDH servers for **${suspensionText}** `;
    message += `(until ${dateString}).\n\n`;
    message += `You can still chat locally on your own server — only cross-server relay is affected.\n`;
    message += `When your suspension ends, please remember to keep things family-friendly.`;
  }
  
  message += `\n\n*If you believe this was a mistake, please contact a PDH moderator.*`;
  
  return message;
}

/**
 * Get a human-readable string for the suspension duration.
 */
function getSuspensionText(strikeCount) {
  switch (strikeCount) {
    case 2: return '1 week';
    case 3: return '1 month';
    case 4: return '2 months';
    case 5: return '3 months';
    default: return `${strikeCount - 2} months`;
  }
}

/**
 * Process a message through all moderation checks.
 * Returns { allowed: boolean, cleanedContent: string, reason: string }
 * 
 * This is the main function called by the message handler.
 * Think of it as the bouncer at the door of the bridge.
 */
async function moderateMessage(message, channelType, filterLinksEnabled) {
  const content = message.content;
  const userId = message.author.id;
  const username = message.author.displayName || message.author.username;
  
  // Check 1: Is the user permanently banned from the bridge?
  if (db.isUserSuspended(userId)) {
    // Silently ignore - don't relay, don't delete, don't DM
    // The user doesn't even know their messages aren't going through
    // (unless they check from another server)
    return { allowed: false, reason: 'user_suspended', cleanedContent: content };
  }
  
  // Check 2: Discord invite links
  // Spam bots use these to drag users to scam servers. We block them
  // aggressively: delete the source message, no relay, no warning.
  // No strike is issued because this is often automated bot spam, not
  // a real user making a mistake — we just want it gone.
  if (content && containsDiscordInvite(content)) {
    console.log(`[Moderation] Discord invite link blocked from ${username} in ${message.guild.name}: ${content.substring(0, 100)}`);
    
    // Delete the source message so it doesn't appear anywhere
    try {
      await message.delete();
    } catch (err) {
      console.log(`[Moderation] Couldn't delete invite spam in ${message.guild.name} — missing Manage Messages permission?`);
    }
    
    return { allowed: false, reason: 'discord_invite', cleanedContent: content };
  }
  
  // Check 3: Profanity filter
  if (content && content.length > 0) {
    const { isProfane } = checkProfanity(content);
    
    if (isProfane) {
      // Add a strike
      const result = db.addStrike(userId, username, channelType, message.guild.id, content);
      
      // Try to DM the user
      try {
        const dmMessage = buildStrikeDM(username, result);
        await message.author.send(dmMessage);
      } catch (err) {
        // User has DMs disabled - we can't reach them
        // The message still gets blocked from relay
        console.log(`[Moderation] Couldn't DM user ${username} - DMs may be disabled`);
      }
      
      // =========================================================
      // ADMIN NOTIFICATION
      // =========================================================
      // DM the bot owner with full details so they can review
      // whether the flag was justified. Includes the original
      // message, the cleaned version, and instructions for
      // how to reverse the penalty or whitelist a word.
      // =========================================================
      try {
        const ownerUser = await message.client.users.fetch(env.ownerId);
        if (ownerUser) {
          let adminMsg = `🚨 **Moderation Flag**\n\n`;
          adminMsg += `**User:** ${username} (\`${userId}\`)\n`;
          adminMsg += `**Server:** ${message.guild.name}\n`;
          adminMsg += `**Channel:** #${message.channel.name} (${channelType})\n`;
          adminMsg += `**Strike #:** ${result.strikeCount}\n`;
          adminMsg += `**Action:** ${result.actionTaken}\n\n`;
          adminMsg += `**Original message:**\n> ${content.substring(0, 1500)}\n\n`;
          adminMsg += `**Cleaned version:**\n> ${filter.clean(content).substring(0, 500)}\n\n`;
          adminMsg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          adminMsg += `**To reverse this penalty:**\n`;
          adminMsg += `Use \`/pdh-strikes\` and then \`/pdh-unban\` in Discord.\n\n`;
          adminMsg += `**To whitelist a flagged word:**\n`;
          adminMsg += `Add it to the \`filter.removeWords()\` call in \`src/modules/moderation.js\` line ~25.\n`;
          adminMsg += `Example: \`filter.removeWords('damn', 'hell');\``;
          
          await ownerUser.send(adminMsg);
        }
      } catch (err) {
        console.log(`[Moderation] Couldn't DM owner about flag: ${err.message}`);
      }
      
      // Delete the original message
      try {
        await message.delete();
      } catch (err) {
        console.log(`[Moderation] Couldn't delete message in ${message.guild.name} - missing permissions?`);
      }
      
      return { allowed: false, reason: 'profanity', cleanedContent: content };
    }
  }
  
  // Check 4: Link filter (if enabled)
  let cleanedContent = content;
  if (filterLinksEnabled && containsLinks(content)) {
    cleanedContent = stripLinks(content);
  }
  
  // Check 5: Strip mentions (always on for relayed channels)
  // Pass the guild so role/user names can be resolved to readable text
  if (channelType === 'discussion' || channelType === 'lfg') {
    cleanedContent = stripMentions(cleanedContent, message.guild);
  }
  
  // Check 6: Strip external emojis (always on)
  cleanedContent = stripExternalEmojis(cleanedContent, message.guild.emojis.cache);
  
  return { allowed: true, reason: null, cleanedContent };
}

module.exports = {
  moderateMessage,
  checkProfanity,
  containsDiscordInvite,
  stripMentions,
  stripLinks,
  stripExternalEmojis,
  buildStrikeDM,
};
