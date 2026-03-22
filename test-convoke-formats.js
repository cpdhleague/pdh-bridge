// =============================================================
// test-convoke-formats.js — Interactive PDH Format Discovery
// =============================================================
// Tests one format at a time. After each test, it shows you the
// room URL and waits for you to check the life total before
// moving on to the next format.
//
// USAGE:  node test-convoke-formats.js
// =============================================================

const readline = require('readline');
try { require('dotenv').config(); } catch {}

const token = process.env.CONVOKE_TOKEN;

if (!token) {
  console.error('❌ CONVOKE_TOKEN not set in .env');
  process.exit(1);
}

const ENDPOINT = 'https://api.convoke.games/api/game/create-game';

// All the format strings and extra fields to try, in order of most likely
const TESTS = [
  // --- Phase 1: Different format strings ---
  { label: 'pauper-commander', payload: { format: 'pauper-commander' } },
  { label: 'pauper-edh', payload: { format: 'pauper-edh' } },
  { label: 'pdh', payload: { format: 'pdh' } },
  { label: 'pauper_commander', payload: { format: 'pauper_commander' } },
  { label: 'pauper_edh', payload: { format: 'pauper_edh' } },
  { label: 'paupercommander', payload: { format: 'paupercommander' } },
  { label: 'pauperedh', payload: { format: 'pauperedh' } },
  { label: 'Pauper Commander', payload: { format: 'Pauper Commander' } },
  { label: 'PauperCommander', payload: { format: 'PauperCommander' } },
  { label: 'PDH', payload: { format: 'PDH' } },
  { label: 'pauper-commander-pdh', payload: { format: 'pauper-commander-pdh' } },
  { label: 'edh', payload: { format: 'edh' } },
  { label: 'other', payload: { format: 'other' } },

  // --- Phase 2: "commander" format + extra life total fields ---
  { label: 'commander + startingLife:30', payload: { format: 'commander', startingLife: 30 } },
  { label: 'commander + lifeTotal:30', payload: { format: 'commander', lifeTotal: 30 } },
  { label: 'commander + life:30', payload: { format: 'commander', life: 30 } },
  { label: 'commander + starting_life:30', payload: { format: 'commander', starting_life: 30 } },
  { label: 'commander + settings:{startingLife:30}', payload: { format: 'commander', settings: { startingLife: 30 } } },
  { label: 'commander + options:{startingLife:30}', payload: { format: 'commander', options: { startingLife: 30 } } },
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function testFormat(extra) {
  const payload = {
    apiKey: token,
    isPublic: false,
    name: `PDH Format Test`,
    spellbotGameId: 'fmt-' + Date.now(),
    seatLimit: 4,
    discordGuild: '123456789',
    discordChannel: '987654321',
    discordPlayers: [
      { id: '111111111', name: 'TestPlayer1' },
      { id: '222222222', name: 'TestPlayer2' },
      { id: '333333333', name: 'TestPlayer3' },
      { id: '444444444', name: 'TestPlayer4' },
    ],
    ...extra,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'pdh-bridge-bot/1.0-format-test',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    let data = null;
    try { data = JSON.parse(await response.text()); } catch {}

    return { status: response.status, data, error: null };
  } catch (err) {
    return { status: null, data: null, error: err.message?.substring(0, 60) };
  }
}

async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   CONVOKE FORMAT DISCOVERY — Finding PDH (30 life)       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('This will test one format at a time.');
  console.log('After each test, open the URL in your browser and check');
  console.log('if the life total is 30 (correct for PDH) or 40 (wrong).');
  console.log('');
  console.log(`Token: ${token.substring(0, 10)}...${token.substring(token.length - 6)}`);
  console.log(`Tests to run: ${TESTS.length}`);
  console.log('');

  await ask('Press ENTER to start...');

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    console.log('');
    console.log(`═══ Test ${i + 1}/${TESTS.length}: "${test.label}" ═══`);
    console.log(`Sending: ${JSON.stringify(test.payload)}`);

    const result = await testFormat(test.payload);

    if (result.error) {
      console.log(`❌ Network error: ${result.error}`);
    } else if (result.status === 200 || result.status === 201) {
      const url = result.data?.url || '(no url returned)';
      console.log(`✅ ACCEPTED — Room created!`);
      console.log(`🔗 ${url}`);
      console.log('');
      console.log('👉 Open this URL in your browser now.');
      console.log('   Check: Is the starting life 30 or 40?');
    } else if (result.status === 400) {
      const msg = result.data?.message || result.data?.error || JSON.stringify(result.data)?.substring(0, 100);
      console.log(`🚫 REJECTED by Convoke (400): ${msg}`);
      console.log('   Skipping — this format string is not valid.');
    } else {
      console.log(`🟡 Unexpected response: HTTP ${result.status}`);
      if (result.data) console.log(`   ${JSON.stringify(result.data).substring(0, 150)}`);
    }

    console.log('');
    const answer = await ask('Type "30" if it worked, "40" if wrong life, or ENTER to try the next one: ');

    if (answer.trim() === '30') {
      console.log('');
      console.log('🎉🎉🎉 FOUND IT! 🎉🎉🎉');
      console.log('');
      console.log(`The winning format: ${JSON.stringify(test.payload)}`);
      console.log('');
      console.log('Update src/modules/convoke.js with this value.');
      console.log('I\'ll share the exact line to change when you paste this output.');
      rl.close();
      return;
    }
  }

  console.log('');
  console.log('Finished all tests without finding 30 life.');
  console.log('The Convoke API may not support setting life total via the API.');
  console.log('You may need to contact the Convoke team directly.');
  rl.close();
}

main();
