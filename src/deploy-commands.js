// =============================================================
// deploy-commands.js - Register slash commands with Discord
// =============================================================
// Run: node src/deploy-commands.js
// Do this once, or whenever you ADD/CHANGE commands.
// =============================================================

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');

const commands = [
  // /lfg - Create a Looking For Game post
  new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Create a PDH Looking For Game post across all servers'),
  
  // /pdh-setup - Configure this server's bridge channels
  new SlashCommandBuilder()
    .setName('pdh-setup')
    .setDescription('Set up this server\'s bridge channels (Admin only)')
    .addChannelOption(opt => opt.setName('news-channel').setDescription('Channel for PDH News').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('lfg-channel').setDescription('Channel for LFG posts').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(opt => opt.setName('discussion-channel').setDescription('Channel for cross-server discussion').addChannelTypes(ChannelType.GuildText))
    .addRoleOption(opt => opt.setName('news-role').setDescription('Role to ping for news (e.g., @news)'))
    .addRoleOption(opt => opt.setName('lfg-role').setDescription('Role to ping for LFG (e.g., @lfg)')),
  
  // /pdh-ban
  new SlashCommandBuilder()
    .setName('pdh-ban')
    .setDescription('Permanently ban a user from the PDH bridge (Admin only)')
    .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason for the ban')),
  
  // /pdh-unban
  new SlashCommandBuilder()
    .setName('pdh-unban')
    .setDescription('Remove a permanent bridge ban (Admin only)')
    .addUserOption(opt => opt.setName('user').setDescription('User to unban').setRequired(true)),
  
  // /pdh-strikes
  new SlashCommandBuilder()
    .setName('pdh-strikes')
    .setDescription('View a user\'s strike history (Admin only)')
    .addUserOption(opt => opt.setName('user').setDescription('User to check').setRequired(true)),
  
  // /pdh-config
  new SlashCommandBuilder()
    .setName('pdh-config')
    .setDescription('Change bridge settings (Admin only)')
    .addStringOption(opt => opt
      .setName('setting').setDescription('Which setting to change').setRequired(true)
      .addChoices(
        { name: 'Link filtering (on/off)', value: 'links' },
        { name: 'LFG expiry time (minutes)', value: 'lfg-expiry' },
      ))
    .addStringOption(opt => opt.setName('value').setDescription('New value').setRequired(true)),
  
  // /pdh-status
  new SlashCommandBuilder()
    .setName('pdh-status')
    .setDescription('View bridge status and connected servers (Admin only)'),
  
  // /pdh-pin - Pin explanation messages in channels (Owner only)
  new SlashCommandBuilder()
    .setName('pdh-pin')
    .setDescription('Pin an explanation message in a bridge channel (Owner only)')
    .addStringOption(opt => opt
      .setName('channel').setDescription('Which channel to pin in').setRequired(true)
      .addChoices(
        { name: 'LFG (this server only)', value: 'lfg' },
        { name: 'LFG (ALL servers)', value: 'lfg-all' },
      )),
];

async function deploy() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log(`Registering ${commands.length} slash commands...`);
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Slash commands registered successfully!');
    console.log('Commands:', commands.map(c => `/${c.name}`).join(', '));
    console.log('Note: Global commands may take up to 1 hour to appear.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
}

deploy();
