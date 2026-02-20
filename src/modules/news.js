// =============================================================
// news.js - RSS feed monitor for PDH News channel
// =============================================================
// This module polls your website's RSS feed at regular intervals
// and posts new articles to the PDH News channel across all servers.
//
// LEARNING NOTE: RSS (Really Simple Syndication) is a standard
// format websites use to publish updates. It's an XML file at a
// URL like yoursite.com/feed that contains your latest articles.
// We "poll" it (check it periodically) for new entries.
//
// setInterval runs a function repeatedly on a timer.
// Unlike setTimeout (which runs once), setInterval keeps going.
// =============================================================

const RssParser = require('rss-parser');
const { EmbedBuilder } = require('discord.js');
const { broadcastEmbed } = require('../bridge');
const db = require('../database');

// LEARNING NOTE: rss-parser doesn't automatically extract all XML
// fields. We need to tell it about custom fields like media:thumbnail
// and media:content, which is how Jekyll's jekyll-feed plugin outputs
// post images. The 'customFields' option maps XML element names to
// property names on the parsed item object.
const parser = new RssParser({
  customFields: {
    item: [
      // Jekyll-feed outputs images as <media:thumbnail url="..."/>
      // and <media:content medium="image" url="..."/>
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['media:content', 'mediaContent', { keepArray: false }],
    ],
  },
});
let pollTimer = null;

/**
 * Start polling the RSS feed at the configured interval.
 * 
 * @param {Object} config - Bridge configuration
 * @param {Client} client - Discord.js client (for avatar URL)
 */
function startRssPolling(config, client) {
  const { rssFeedUrl, rssPollInterval } = config.settings;
  
  if (!rssFeedUrl) {
    console.log('[News] No RSS feed URL configured, skipping RSS polling');
    return;
  }
  
  console.log(`[News] Starting RSS polling every ${rssPollInterval} minutes: ${rssFeedUrl}`);
  
  // Poll immediately on startup, then on interval
  pollFeed(config, client);
  
  // Convert minutes to milliseconds (minutes × 60 seconds × 1000 milliseconds)
  pollTimer = setInterval(() => {
    pollFeed(config, client);
  }, rssPollInterval * 60 * 1000);
}

/**
 * Stop RSS polling (called when bot shuts down).
 */
function stopRssPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[News] RSS polling stopped');
  }
}

/**
 * Fetch the RSS feed and post any new articles.
 * 
 * FIRST-RUN PROTECTION:
 * If the seen_articles table is empty (brand new database), we DON'T
 * post anything. Instead, we "seed" the table by marking every existing
 * article as already-seen. This prevents the backlog flood that happens
 * when you delete the .db file or first install the bot.
 * Only articles published AFTER the first successful poll will be posted.
 *
 * LEARNING NOTE: This pattern is common in feed readers and notification
 * systems. You don't want to spam users with 6 months of history the
 * first time you connect. You want a "clean start" where only truly
 * new content triggers notifications.
 */
async function pollFeed(config, client) {
  const { rssFeedUrl } = config.settings;
  
  try {
    const feed = await parser.parseURL(rssFeedUrl);
    
    if (!feed.items || feed.items.length === 0) {
      return;
    }
    
    // --- FIRST-RUN SEED ---
    // If we've never tracked any articles, this is a fresh database.
    // Mark everything as "already seen" without posting, so only
    // future articles trigger notifications.
    const seenCount = db.countSeenArticles();
    if (seenCount === 0) {
      console.log(`[News] First run detected — seeding ${feed.items.length} existing articles as already-seen`);
      for (const item of feed.items) {
        const articleUrl = item.link || item.guid;
        if (articleUrl) {
          db.markArticleSeen(articleUrl, item.title || 'Untitled');
        }
      }
      console.log(`[News] Seed complete. Only NEW articles from now on will be posted.`);
      return; // Don't post anything on first run
    }
    
    // --- NORMAL POLLING ---
    // Process items from oldest to newest so they appear in order
    const items = feed.items.reverse();
    let newCount = 0;
    
    for (const item of items) {
      const articleUrl = item.link || item.guid;
      if (!articleUrl) continue;
      
      // Skip if we've already posted this article
      if (db.hasSeenArticle(articleUrl)) continue;
      
      // Build a nice embed for the article
      const embed = buildArticleEmbed(item, feed);
      
      // Broadcast to all servers' news channels
      try {
        // Get all servers (we want to post to ALL, no exclusions)
        await broadcastToAll(config, 'news', embed, client);
        
        // Mark as seen AFTER successful posting
        db.markArticleSeen(articleUrl, item.title || 'Untitled');
        newCount++;
        
        console.log(`[News] Posted article: ${item.title}`);
        
        // Small delay between posts to avoid rate limiting
        if (newCount < items.length) {
          await sleep(2000);
        }
      } catch (err) {
        console.error(`[News] Failed to post article "${item.title}":`, err.message);
      }
    }
    
    if (newCount > 0) {
      console.log(`[News] Posted ${newCount} new article(s)`);
    }
  } catch (err) {
    console.error('[News] Failed to fetch RSS feed:', err.message);
  }
}

/**
 * Build a Discord embed for an RSS article.
 * Embeds are the fancy "card" style messages with colored borders.
 * 
 * IMAGE EXTRACTION PRIORITY:
 * We check multiple sources for the article's teaser image because
 * different RSS generators put images in different places:
 *   1. media:thumbnail (Jekyll's jekyll-feed plugin puts images here)
 *   2. media:content (also from jekyll-feed, as a backup)
 *   3. enclosure (standard RSS image attachment)
 *   4. First <img> tag in the article's HTML content (fallback)
 *
 * LEARNING NOTE FOR YOUR JEKYLL SITE:
 * The jekyll-feed plugin looks for an `image:` field in your post's
 * front matter. Your site uses `header.teaser` (Minimal Mistakes theme),
 * which jekyll-feed doesn't automatically pick up. To make it work,
 * add this to your front matter alongside the existing header block:
 *
 *   image: /assets/images/south_article_thumbnail.jpg
 *
 * This one line tells jekyll-feed to include it as <media:thumbnail>
 * in the RSS XML, which the bot will then use for the Discord embed.
 */
function buildArticleEmbed(item, feed) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)  // Discord blurple color
    .setTitle(item.title || 'New Article')
    .setURL(item.link || '')
    .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date());
  
  // --- DESCRIPTION ---
  // Use the content snippet (plain text) if available, otherwise
  // strip HTML from the full content. Truncate to keep embeds clean.
  if (item.contentSnippet || item.content) {
    let desc = item.contentSnippet || item.content;
    // Strip HTML tags
    desc = desc.replace(/<[^>]*>/g, '');
    // Collapse whitespace (HTML content often has lots of newlines)
    desc = desc.replace(/\s+/g, ' ').trim();
    if (desc.length > 300) {
      desc = desc.substring(0, 297) + '...';
    }
    embed.setDescription(desc);
  }
  
  // --- IMAGE EXTRACTION ---
  // Try multiple sources, in order of reliability.
  const imageUrl = extractImageUrl(item, feed);
  if (imageUrl) {
    embed.setImage(imageUrl);
  }
  
  // Footer with feed name
  embed.setFooter({ text: feed.title || 'PDH News' });
  
  return embed;
}

/**
 * Try to extract an image URL from an RSS item.
 * Checks multiple possible locations in priority order.
 * 
 * LEARNING NOTE: This is a pattern called "chain of responsibility" —
 * we try one approach, and if it fails, we fall through to the next.
 * It makes the code resilient to different RSS feed formats.
 *
 * @param {Object} item - A parsed RSS item from rss-parser
 * @param {Object} feed - The parsed RSS feed (for building absolute URLs)
 * @returns {string|null} The image URL, or null if none found
 */
function extractImageUrl(item, feed) {
  // 1. media:thumbnail — Jekyll's jekyll-feed plugin puts the image
  //    from front matter `image:` here. It's the most reliable source.
  //    The XML looks like: <media:thumbnail url="https://..." />
  //    rss-parser gives us either an object with $.url or a string.
  if (item.mediaThumbnail) {
    const url = item.mediaThumbnail.$?.url || item.mediaThumbnail.url || item.mediaThumbnail;
    if (typeof url === 'string' && url.length > 0) {
      return ensureAbsoluteUrl(url, feed);
    }
  }

  // 2. media:content — Another jekyll-feed output for the same image.
  //    XML: <media:content medium="image" url="https://..." />
  if (item.mediaContent) {
    const url = item.mediaContent.$?.url || item.mediaContent.url || item.mediaContent;
    if (typeof url === 'string' && url.length > 0) {
      return ensureAbsoluteUrl(url, feed);
    }
  }

  // 3. Standard RSS enclosure — used by many feed generators.
  //    XML: <enclosure url="https://..." type="image/jpeg" />
  if (item.enclosure?.url) {
    return ensureAbsoluteUrl(item.enclosure.url, feed);
  }

  // 4. itunes:image — used by podcast feeds, sometimes blogs too.
  if (item.itunes?.image) {
    return ensureAbsoluteUrl(item.itunes.image, feed);
  }

  // 5. FALLBACK: Extract the first <img> from the HTML content.
  //    This catches images that are in the article body but not
  //    in any RSS metadata fields. It's a last resort.
  const htmlContent = item.content || item['content:encoded'] || '';
  const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) {
    return ensureAbsoluteUrl(imgMatch[1], feed);
  }

  return null;
}

/**
 * Make sure a URL is absolute (starts with http/https).
 * RSS feeds sometimes include relative paths like "/assets/images/foo.jpg"
 * which need the site's base URL prepended.
 *
 * LEARNING NOTE: Browsers handle relative URLs automatically because
 * they know what page you're on. But when we're building a Discord embed,
 * Discord needs the full URL to fetch the image. So "/assets/images/foo.jpg"
 * must become "https://yoursite.com/assets/images/foo.jpg".
 * 
 * @param {string} url - The URL (possibly relative)
 * @param {Object} feed - The parsed feed (we use feed.link as the base)
 * @returns {string} An absolute URL
 */
function ensureAbsoluteUrl(url, feed) {
  // Already absolute — return as-is
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // Relative URL — try to build an absolute one from the feed's base URL
  // feed.link is usually something like "https://yoursite.com"
  const baseUrl = feed.link || feed.feedUrl || '';
  if (baseUrl) {
    try {
      // JavaScript's URL constructor handles combining base + relative paths
      return new URL(url, baseUrl).href;
    } catch {
      // If URL construction fails, return the original as a last resort
      return url;
    }
  }

  return url;
}

/**
 * Broadcast to ALL servers (including the "source" - since news
 * doesn't originate from a user on a server, it goes everywhere).
 */
async function broadcastToAll(config, channelType, embed, client) {
  const { WebhookClient } = require('discord.js');
  
  const results = [];
  
  for (const [guildId, server] of Object.entries(config.servers)) {
    if (!server.webhooks[channelType]) continue;
    
    try {
      const webhook = new WebhookClient({ url: server.webhooks[channelType] });
      
      const payload = {
        embeds: [embed.toJSON()],
        username: 'PDH News',
        allowedMentions: { parse: [] },
      };
      
      // Ping @news role if configured
      if (server.roles?.news) {
        payload.content = `<@&${server.roles.news}>`;
        payload.allowedMentions = { roles: [server.roles.news] };
      }
      
      await webhook.send(payload);
      results.push({ guildId, success: true });
    } catch (err) {
      console.error(`[News] Failed to post to guild ${guildId}:`, err.message);
      results.push({ guildId, success: false });
    }
  }
  
  return results;
}

/**
 * Utility: pause execution for a given number of milliseconds.
 * LEARNING NOTE: This is a common pattern for adding delays.
 * It creates a Promise that resolves after the specified time.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  startRssPolling,
  stopRssPolling,
};
