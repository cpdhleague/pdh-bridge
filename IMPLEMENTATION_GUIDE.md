# PDH Bridge Bot — Complete Implementation Guide

Welcome! This guide walks you through every step of setting up the PDH Bridge Bot, from creating your Discord application to going live across all your servers. No prior experience with Discord bots or server administration is assumed.

---

## Table of Contents

1. [What You'll Need Before Starting](#1-what-youll-need-before-starting)
2. [Create Your Discord Application & Bot](#2-create-your-discord-application--bot)
3. [Set Up Your Development Environment](#3-set-up-your-development-environment)
4. [Configure the Bot](#4-configure-the-bot)
5. [Invite the Bot to Your Servers](#5-invite-the-bot-to-your-servers)
6. [Prepare Your Discord Channels](#6-prepare-your-discord-channels)
7. [First Run — Testing Locally](#7-first-run--testing-locally)
8. [Register Slash Commands](#8-register-slash-commands)
9. [Run the Setup Command on Each Server](#9-run-the-setup-command-on-each-server)
10. [Test Each Feature](#10-test-each-feature)
11. [Deploy to Oracle Cloud (Free Tier)](#11-deploy-to-oracle-cloud-free-tier)
12. [Set Up Channel Permissions](#12-set-up-channel-permissions)
13. [Ongoing Maintenance](#13-ongoing-maintenance)
14. [Troubleshooting](#14-troubleshooting)
15. [Understanding the Code](#15-understanding-the-code)

---

## 1. What You'll Need Before Starting

Before you begin, make sure you have:

- [ ] A **Discord account** (the one you use normally)
- [ ] **Admin/owner access** to your own PDH Discord server
- [ ] **A computer** (Windows, Mac, or Linux all work)
- [ ] **A web browser** for the Discord Developer Portal
- [ ] About **1-2 hours** for initial setup

You do NOT need to have Node.js or coding tools installed on your personal computer if you're going straight to Oracle Cloud. But for testing, having Node.js locally is helpful.

---

## 2. Create Your Discord Application & Bot

This is where you create the bot's "identity" on Discord.

### Step 2a: Create the Application

1. Go to the **Discord Developer Portal**: https://discord.com/developers/applications
2. Click the **"New Application"** button (top right)
3. Name it **"PDH Bridge"** (or whatever you like)
4. Accept the Terms of Service and click **Create**
5. You'll land on the "General Information" page
6. **Copy the "Application ID"** — you'll need this later (it's also called the Client ID)

### Step 2b: Create the Bot User

1. In the left sidebar, click **"Bot"**
2. Click **"Reset Token"** and confirm
3. **⚠️ COPY THE TOKEN IMMEDIATELY** — Discord only shows it once!
4. Save this token somewhere safe (a password manager, a private note — NOT a text file on your desktop)

### Step 2c: Configure Bot Settings

Still on the Bot page, scroll down and configure:

- **Public Bot**: Turn this **OFF** (you don't want random people adding your bot)
- **Requires OAuth2 Code Grant**: Leave **OFF**
- Under **Privileged Gateway Intents**, turn **ON**:
  - ✅ **Server Members Intent** — lets the bot see member lists
  - ✅ **Message Content Intent** — lets the bot read message text (critical for the bridge)

Click **Save Changes**.

### Step 2d: Get Your User ID

You'll need your personal Discord user ID for the bot config.

1. Open Discord (the app or web)
2. Go to **User Settings** > **Advanced** > turn on **Developer Mode**
3. Close settings
4. **Right-click your own name** anywhere in Discord
5. Click **"Copy User ID"**
6. Save this — it's your Owner ID

---

## 3. Set Up Your Development Environment

### Option A: Set Up Locally First (Recommended for Testing)

This lets you test the bot on your own computer before deploying to the cloud.

#### Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS version** (the one that says "Recommended for Most Users")
3. Run the installer with default settings
4. To verify it worked, open a terminal/command prompt and type:
   ```
   node --version
   ```
   You should see something like `v20.x.x` or `v22.x.x`

#### Download the Bot Code

If you already have the bot files, copy them to a folder on your computer. The folder structure should look like:

```
pdh-bridge-bot/
├── package.json
├── .env.example
├── .gitignore
├── src/
│   ├── index.js
│   ├── config.js
│   ├── database.js
│   ├── bridge.js
│   ├── deploy-commands.js
│   └── modules/
│       ├── moderation.js
│       ├── news.js
│       ├── lfg.js
│       └── commands.js
```

#### Install Dependencies

Open a terminal, navigate to the bot folder, and run:

```bash
cd pdh-bridge-bot
npm install
```

This downloads all the libraries the bot needs (discord.js, the profanity filter, etc.). It creates a `node_modules` folder — this is normal and can be large. Don't worry about what's inside it.

### Option B: Go Straight to Oracle Cloud

If you want to skip local testing and go directly to cloud hosting, jump to [Section 11](#11-deploy-to-oracle-cloud-free-tier) first, then come back to Section 4.

---

## 4. Configure the Bot

### Create Your .env File

1. In the bot folder, find the file called `.env.example`
2. **Make a copy** of it and rename the copy to `.env` (just `.env`, no other extension)
   - On Windows: You might need to show file extensions in Explorer settings
   - On Mac/Linux: `cp .env.example .env`
3. Open `.env` in a text editor (Notepad, TextEdit, VS Code, etc.)
4. Fill in your values:

```env
DISCORD_TOKEN=paste-your-bot-token-here
DISCORD_CLIENT_ID=paste-your-application-id-here
OWNER_ID=paste-your-discord-user-id-here
RSS_FEED_URL=https://your-pdh-website.com/feed
RSS_POLL_INTERVAL=10
LFG_EXPIRY_MINUTES=60
FILTER_LINKS=false
```

**Replace the placeholder values** with the real ones you collected in Step 2.

---

## 5. Invite the Bot to Your Servers

You need to generate a special invite link that includes the correct permissions.

### Generate the Invite Link

1. Go back to the **Discord Developer Portal** > your application
2. In the left sidebar, click **"OAuth2"**
3. Under **"OAuth2 URL Generator"**, check the scope **"bot"**
4. Also check the scope **"applications.commands"** (needed for slash commands)
5. In the **Bot Permissions** section below, check these:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Manage Messages (for deleting profane messages and LFG cleanup)
   - ✅ Manage Webhooks (for the bridge relay)
   - ✅ Embed Links
   - ✅ Attach Files
   - ✅ Read Message History
   - ✅ Mention Everyone (for pinging @news and @lfg roles)
   - ✅ Use External Emojis (the bot itself may need this even though users won't)
6. **Copy the generated URL** at the bottom

### Invite to Each Server

1. Paste the URL into your browser
2. A Discord authorization page appears
3. Select the server you want to add the bot to from the dropdown
4. Click **Authorize**
5. Complete the CAPTCHA
6. **Repeat for every PDH server** you want to bridge

> **Important:** You need admin permission on each server to invite the bot. This is where the cooperation of other server owners comes in — you can send them the invite link and they can authorize it on their own server.

---

## 6. Prepare Your Discord Channels

On **each server** that's joining the bridge, you need to create three channels. You (or the server admin) should:

### Create the Channels

1. **#pdh-news** — for RSS articles
2. **#pdh-lfg** — for looking-for-game posts
3. **#pdh-discussion** — for cross-server chat

> **Tip:** Create a channel category called "PDH Network" or "PDH Community" and put all three channels inside it. This keeps things organized.

### Create the Roles (Optional but Recommended)

1. Create a role called **@news** — users self-assign this to get pinged for articles
2. Create a role called **@lfg** — users self-assign this to get pinged for games

To make these self-assignable, you can use Discord's built-in **Onboarding** feature (Server Settings > Onboarding) or a reaction-role bot.

> **Don't set up channel permissions yet** — we'll do that in [Section 12](#12-set-up-channel-permissions) after testing.

---

## 7. First Run — Testing Locally

Let's make sure the bot starts correctly before we configure the bridge.

1. Open a terminal in your bot folder
2. Run:
   ```bash
   npm start
   ```
3. You should see:
   ```
   ═══════════════════════════════════════════
     PDH Bridge Bot is online!
     Logged in as: PDH Bridge#1234
     Serving 3 server(s)
     Bridge has 0 configured server(s)
   ═══════════════════════════════════════════
   ```

If you see errors, check [Section 14: Troubleshooting](#14-troubleshooting).

Press **Ctrl+C** to stop the bot for now.

---

## 8. Register Slash Commands

Before the bot's commands (like /lfg and /pdh-setup) will appear in Discord, you need to register them:

```bash
node src/deploy-commands.js
```

You should see:
```
Registering 7 slash commands...
✅ Slash commands registered successfully!
```

> **Note:** Global commands can take up to **1 hour** to appear in all servers. Be patient! If you want instant testing, the commands usually appear within a few minutes.

---

## 9. Run the Setup Command on Each Server

Now start the bot again (`npm start`) and use the `/pdh-setup` command in each server to register its channels with the bridge.

### In Each Server:

1. Go to any channel where the bot is present
2. Type `/pdh-setup`
3. Fill in the options:
   - **news-channel:** Select #pdh-news
   - **lfg-channel:** Select #pdh-lfg
   - **discussion-channel:** Select #pdh-discussion
   - **news-role:** Select @news (if you created it)
   - **lfg-role:** Select @lfg (if you created it)
4. Press Enter

The bot will:
- Create webhooks in each channel (you'll see "PDH Bridge" webhooks appear in Channel Settings > Integrations)
- Save the channel and webhook IDs to its configuration file
- Confirm everything is set up

**Repeat this for every server in the bridge.**

After setting up all servers, use `/pdh-status` to see a summary of all connected servers.

---

## 10. Test Each Feature

### Test Discussion Bridge

1. Go to **#pdh-discussion** on Server A
2. Type a normal message like "Hello from Server A!"
3. Check **#pdh-discussion** on Server B — you should see the same message, displayed with your username and avatar

### Test Profanity Filter

1. Go to **#pdh-discussion** on any server
2. Type a message with a common swear word
3. The message should be:
   - Deleted from the channel
   - NOT relayed to other servers
   - You should receive a DM from the bot with a warning

### Test LFG

1. Go to **#pdh-lfg** on any server
2. Type `/lfg`
3. Fill in the modal form and submit
4. Check #pdh-lfg on all servers — the LFG post should appear everywhere with Join/Leave/Cancel buttons

### Test News (if you have an RSS feed)

If you configured an RSS feed URL, the bot will check it every 10 minutes. You can test by:
1. Publishing a new article on your website
2. Waiting up to 10 minutes
3. Checking #pdh-news on all servers

### Test Admin Commands

- `/pdh-status` — Shows all connected servers
- `/pdh-strikes @user` — Check a user's record
- `/pdh-config links on` — Enable link filtering
- `/pdh-config links off` — Disable link filtering

---

## 11. Deploy to Oracle Cloud (Free Tier)

Once everything works locally, let's move the bot to the cloud so it runs 24/7.

### Step 11a: Create an Oracle Cloud Account

1. Go to https://www.oracle.com/cloud/free/
2. Click **"Start for free"**
3. Fill in your details (you'll need a credit card for verification, but you won't be charged for Always Free resources)
4. Choose a **Home Region** — pick one closest to your geographic area
5. Complete the signup process

### Step 11b: Create a Compute Instance

1. Log into the **Oracle Cloud Console**: https://cloud.oracle.com
2. Click the hamburger menu (☰) > **Compute** > **Instances**
3. Click **"Create Instance"**
4. Configure it:
   - **Name:** `pdh-bridge-bot`
   - **Image:** Oracle Linux 8 (or Ubuntu 22.04)
   - **Shape:** VM.Standard.E2.1.Micro (this is the Always Free shape)
     - If this isn't available, try VM.Standard.A1.Flex with 1 OCPU and 1 GB RAM
   - **Networking:** Accept defaults (this creates a public IP)
   - **SSH Keys:** Click "Generate a key pair" and **download both the private and public key files**
     - **Save these files somewhere safe!** You need them to connect to your server
5. Click **Create**
6. Wait a few minutes for the instance to start (status changes to "Running")
7. Note the **Public IP Address** shown on the instance details page

### Step 11c: Connect to Your Instance

#### On Mac/Linux:
```bash
# Make your key file private (SSH requires this)
chmod 400 ~/Downloads/ssh-key-*.key

# Connect to your instance
ssh -i ~/Downloads/ssh-key-*.key opc@YOUR_PUBLIC_IP
```

#### On Windows:
1. Download **PuTTY** from https://www.putty.org
2. Use **PuTTYgen** to convert the .key file to .ppk format
3. Open PuTTY, enter `opc@YOUR_PUBLIC_IP` as the hostname
4. Under Connection > SSH > Auth, browse to your .ppk file
5. Click Open

### Step 11d: Set Up the Server

Once connected via SSH, run these commands one at a time:

```bash
# Update the system
sudo yum update -y    # (Oracle Linux)
# OR
sudo apt update && sudo apt upgrade -y    # (Ubuntu)

# Install Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -    # Oracle Linux
sudo yum install -y nodejs
# OR
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -  # Ubuntu
sudo apt-get install -y nodejs

# Install build tools (needed for better-sqlite3)
sudo yum groupinstall -y "Development Tools"    # Oracle Linux
# OR
sudo apt-get install -y build-essential          # Ubuntu

# Install pm2 (keeps the bot running and auto-restarts on crash)
sudo npm install -g pm2

# Create a directory for the bot
mkdir ~/pdh-bridge-bot
cd ~/pdh-bridge-bot
```

### Step 11e: Upload Your Bot Code

From your LOCAL computer (not the SSH session), upload the bot files:

```bash
# From your local machine, in the bot directory:
scp -i ~/Downloads/ssh-key-*.key -r ./* opc@YOUR_PUBLIC_IP:~/pdh-bridge-bot/
```

Or, if you've pushed your code to a **private GitHub repo**:

```bash
# On the Oracle instance:
cd ~
git clone https://github.com/YOUR_USERNAME/pdh-bridge-bot.git
cd pdh-bridge-bot
```

### Step 11f: Install and Configure

```bash
cd ~/pdh-bridge-bot

# Install dependencies
npm install

# Create the .env file
cp .env.example .env
nano .env    # Opens a text editor - paste in your real values
# Press Ctrl+X, then Y, then Enter to save and exit

# If you already have a bridge-config.json from local testing, upload that too
# Otherwise, you'll re-run /pdh-setup on each server once the bot is online
```

### Step 11g: Start the Bot with PM2

```bash
# Start the bot
pm2 start src/index.js --name pdh-bridge

# Make it auto-restart on server reboot
pm2 startup
# (run the command it gives you)
pm2 save

# Useful PM2 commands:
pm2 logs pdh-bridge     # View live logs
pm2 status              # Check if bot is running
pm2 restart pdh-bridge  # Restart the bot
pm2 stop pdh-bridge     # Stop the bot
```

### Step 11h: Set Up Firewall (Security)

The bot only needs outbound internet access (to talk to Discord). It doesn't need any inbound ports open.

For Oracle Linux:
```bash
# The default firewall is fine - the bot only makes outgoing connections
# No changes needed!
```

### Step 11i: Set Up Automatic Backups

Your SQLite database contains all strike history and config data. Back it up daily:

```bash
# Create a backup script
cat << 'EOF' > ~/backup-bot-db.sh
#!/bin/bash
cp ~/pdh-bridge-bot/pdh-bridge.db ~/pdh-bridge-bot/backups/pdh-bridge-$(date +%Y%m%d).db
# Keep only last 30 days of backups
find ~/pdh-bridge-bot/backups/ -name "*.db" -mtime +30 -delete
EOF

chmod +x ~/backup-bot-db.sh
mkdir -p ~/pdh-bridge-bot/backups

# Schedule daily backups at 3 AM
crontab -e
# Add this line:
# 0 3 * * * /home/opc/backup-bot-db.sh
```

---

## 12. Set Up Channel Permissions

Now that everything is working, lock down the channel permissions on each server. This is done through Discord's channel settings, not through the bot.

### For #pdh-news (Read-Only)

For each server, right-click the channel > Edit Channel > Permissions:

| Role / User | Permission | Setting |
|---|---|---|
| @everyone | Send Messages | ❌ Deny |
| @everyone | Add Reactions | ✅ Allow (optional) |
| PDH Bridge (bot) | Send Messages | ✅ Allow |
| PDH Bridge (bot) | Manage Webhooks | ✅ Allow |
| PDH Bridge (bot) | Manage Messages | ✅ Allow |

### For #pdh-lfg (Bot-Mediated Only)

| Role / User | Permission | Setting |
|---|---|---|
| @everyone | Send Messages | ❌ Deny |
| @everyone | Use Application Commands | ✅ Allow (for /lfg) |
| PDH Bridge (bot) | Send Messages | ✅ Allow |
| PDH Bridge (bot) | Manage Webhooks | ✅ Allow |
| PDH Bridge (bot) | Manage Messages | ✅ Allow |

### For #pdh-discussion (Open Chat, No Pings)

| Role / User | Permission | Setting |
|---|---|---|
| @everyone | Send Messages | ✅ Allow |
| @everyone | Mention @everyone, @here, and All Roles | ❌ Deny |
| @everyone | Use External Emojis | ❌ Deny |
| PDH Bridge (bot) | Send Messages | ✅ Allow |
| PDH Bridge (bot) | Manage Webhooks | ✅ Allow |
| PDH Bridge (bot) | Manage Messages | ✅ Allow |
| PDH Bridge (bot) | Mention Everyone | ✅ Allow |

> **Tip:** To edit permissions, right-click the channel name > Edit Channel > Permissions. Click the "+" to add the bot role, then set each permission.

---

## 13. Ongoing Maintenance

### Updating the Bot Code

When you make changes to the code:

```bash
# On your Oracle instance:
cd ~/pdh-bridge-bot

# If using Git:
git pull

# If uploading manually, use scp from your local machine

# Restart the bot to apply changes
pm2 restart pdh-bridge
```

### If You Add/Change Slash Commands

```bash
node src/deploy-commands.js
```

### Checking Logs

```bash
pm2 logs pdh-bridge           # Live logs
pm2 logs pdh-bridge --lines 100  # Last 100 lines
```

### Adding a New Server to the Bridge

1. Send the invite link to the new server's admin
2. Once the bot is in the server, have them create the 3 channels + roles
3. Use `/pdh-setup` in the new server to register it
4. Set up channel permissions per Section 12

### Keeping Oracle Cloud Happy

To prevent Oracle from reclaiming your instance for being "idle":

The bot's constant WebSocket connection and message processing should keep CPU utilization above the threshold. But as insurance, you can add a small health-check cron:

```bash
# Add to crontab (crontab -e):
*/5 * * * * curl -s https://discord.com/api/v10/gateway > /dev/null 2>&1
```

This pings Discord's API every 5 minutes, adding a tiny bit of CPU activity.

---

## 14. Troubleshooting

### "DISCORD_TOKEN is not set"
→ Your `.env` file is missing or the token isn't filled in. Make sure the file is named exactly `.env` (not `.env.txt` or `.env.example`).

### "Used disallowed intents"
→ You forgot to enable Message Content Intent in the Developer Portal (Step 2c). Go back and turn it on.

### Slash commands don't appear
→ Global commands take up to 1 hour to propagate. Wait and try again. Also make sure you ran `node src/deploy-commands.js`.

### "Missing Permissions" errors
→ The bot doesn't have the right permissions in the channel. Check Section 12 and make sure the bot role has all the listed permissions.

### Bot is online but messages don't relay
→ Run `/pdh-status` to make sure the server is configured. If it shows 0 servers, you need to run `/pdh-setup` in each server.

### Webhook errors
→ Someone may have manually deleted the webhook. The bot will try to recreate it on restart. Run `pm2 restart pdh-bridge`.

### Bot crashes and won't start
→ Check the logs: `pm2 logs pdh-bridge`. The error message will tell you what's wrong. Common causes:
- Invalid token (regenerate in Developer Portal)
- Database corruption (restore from backup)
- Missing npm packages (run `npm install` again)

### Oracle Cloud instance disappeared
→ This is the known risk with the free tier. Spin up a new instance, re-upload your code and the latest database backup, and you'll be back online. This is why we set up automated backups.

---

## 15. Understanding the Code

Here's a quick map of what each file does, so you know where to look when you want to make changes:

| File | Purpose |
|---|---|
| `src/index.js` | The main entry point — starts the bot, listens for events, routes to handlers |
| `src/config.js` | Loads .env settings, manages the server/channel mapping (bridge-config.json) |
| `src/database.js` | SQLite database — stores strikes, bans, LFG posts, and seen articles |
| `src/bridge.js` | The relay engine — sends messages between servers via webhooks |
| `src/deploy-commands.js` | One-time script to register slash commands with Discord |
| `src/modules/moderation.js` | Profanity filter, mention stripping, link filtering, strike DMs |
| `src/modules/news.js` | RSS feed polling and article broadcasting |
| `src/modules/lfg.js` | LFG slash command, modal forms, join/leave buttons, auto-cleanup |
| `src/modules/commands.js` | Admin commands (ban, unban, strikes, config, setup, status) |

### Key Concepts

**Event-driven architecture:** The bot doesn't run code sequentially. It sets up listeners (`client.on(Events.MessageCreate, ...)`) and waits. When Discord sends an event, the matching listener runs.

**Webhooks as relay mechanism:** The bot uses Discord webhooks to impersonate users on other servers. A webhook can post messages with any display name and avatar, making relayed messages look natural.

**Middleware pattern:** Messages flow through a pipeline: receive → moderate → clean → relay. If any step rejects the message, the pipeline stops.

**Async/await:** Most Discord operations (sending messages, fetching data) are asynchronous — they take time. `await` pauses until they complete. `async` marks a function as containing `await` calls.

---

## Quick Reference Card

| What | Command / Action |
|---|---|
| Start bot locally | `npm start` |
| Register slash commands | `node src/deploy-commands.js` |
| Set up a server | `/pdh-setup` (in Discord) |
| Check bridge status | `/pdh-status` |
| Create LFG post | `/lfg` |
| Ban from bridge | `/pdh-ban @user` |
| Unban from bridge | `/pdh-unban @user` |
| View strikes | `/pdh-strikes @user` |
| Toggle link filter | `/pdh-config links on/off` |
| Change LFG expiry | `/pdh-config lfg-expiry 90` |
| View logs (cloud) | `pm2 logs pdh-bridge` |
| Restart bot (cloud) | `pm2 restart pdh-bridge` |

---

*Built with ❤️ for the PDH community.*
