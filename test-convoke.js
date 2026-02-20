// =============================================================
// test-convoke.js — EXHAUSTIVE Convoke API Endpoint Discovery
// =============================================================
// Tries every conceivable domain + path combination to find the
// working Convoke API endpoint for game room creation.
//
// STRATEGY:
//   Phase 1: DNS probe — which domains are even alive?
//   Phase 2: Root probe — GET the root of each live domain
//            to see what kind of server responds
//   Phase 3: Endpoint blitz — try every path combination
//            on every live domain using POST
//
// USAGE:  node test-convoke.js
// =============================================================

try { require('dotenv').config(); } catch {}

const token = process.env.CONVOKE_TOKEN;

if (!token) {
  console.error('❌ CONVOKE_TOKEN not set in .env');
  process.exit(1);
}

// ==========================
// EVERY POSSIBLE DOMAIN
// ==========================
const DOMAINS = [
  // --- convoke.games (the webcam MTG app) ---
  'https://api.convoke.games',
  'https://convoke.games',
  'https://www.convoke.games',
  'https://app.convoke.games',
  'https://backend.convoke.games',
  'https://server.convoke.games',
  'https://game.convoke.games',
  'https://games.convoke.games',
  'https://play.convoke.games',
  'https://rooms.convoke.games',
  'https://lobby.convoke.games',
  'https://staging.convoke.games',
  'https://prod.convoke.games',
  'https://rest.convoke.games',
  'https://service.convoke.games',
  'https://gateway.convoke.games',

  // --- convoke.gg (the cEDH tournament org) ---
  'https://api.convoke.gg',
  'https://convoke.gg',
  'https://www.convoke.gg',
  'https://app.convoke.gg',
  'https://backend.convoke.gg',
  'https://server.convoke.gg',
  'https://game.convoke.gg',
  'https://games.convoke.gg',
  'https://play.convoke.gg',
  'https://rooms.convoke.gg',
  'https://lobby.convoke.gg',
  'https://staging.convoke.gg',
  'https://prod.convoke.gg',
  'https://rest.convoke.gg',
  'https://service.convoke.gg',
  'https://gateway.convoke.gg',

  // --- cloud hosting guesses ---
  'https://convoke.herokuapp.com',
  'https://convoke-api.herokuapp.com',
  'https://convoke-backend.herokuapp.com',
  'https://convoke-games.herokuapp.com',
  'https://convoke.fly.dev',
  'https://convoke-api.fly.dev',
  'https://convoke-backend.fly.dev',
  'https://convoke-games.fly.dev',
  'https://convoke.onrender.com',
  'https://convoke-api.onrender.com',
  'https://convoke-backend.onrender.com',
  'https://convoke-games.onrender.com',
  'https://convoke.vercel.app',
  'https://convoke-api.vercel.app',
  'https://convoke.railway.app',
  'https://convoke-api.railway.app',
  'https://convoke.netlify.app',
  'https://convoke-api.netlify.app',
  'https://convoke.up.railway.app',
  'https://convoke-api.up.railway.app',

  // --- other TLDs ---
  'https://api.convoke.app',
  'https://convoke.app',
  'https://api.convoke.io',
  'https://convoke.io',
  'https://api.convoke.dev',
  'https://convoke.dev',
  'https://api.convokegg.com',
  'https://convokegg.com',
  'https://api.convokegames.com',
  'https://convokegames.com',
];

// ==========================
// EVERY POSSIBLE ENDPOINT PATH
// ==========================
// We combine these prefixes with these endpoints to get every permutation.

const PATH_PREFIXES = [
  '',
  '/api',
  '/api/v1',
  '/api/v2',
  '/api/v3',
  '/v1',
  '/v2',
  '/v3',
];

const ENDPOINT_PATHS = [
  // Known from SpellBot source:
  '/game/create-game',

  // Possible variations of the same:
  '/game/create',
  '/game/createGame',
  '/game/new',
  '/games/create-game',
  '/games/create',
  '/games/createGame',
  '/games/new',

  // Room-based naming:
  '/room/create',
  '/room/create-room',
  '/rooms/create',
  '/rooms/create-room',

  // Lobby-based naming:
  '/lobby/create',
  '/lobby/create-lobby',
  '/lobbies/create',

  // Match-based naming:
  '/match/create',
  '/match/create-match',
  '/matches/create',

  // Session-based naming:
  '/session/create',
  '/sessions/create',

  // Generic:
  '/create-game',
  '/create-room',
  '/create',
];

// Build all combinations
function buildAllEndpoints() {
  const endpoints = [];
  for (const prefix of PATH_PREFIXES) {
    for (const path of ENDPOINT_PATHS) {
      endpoints.push(`${prefix}${path}`);
    }
  }
  return [...new Set(endpoints)]; // deduplicate
}

const ALL_PATHS = buildAllEndpoints();

// Test payload
const payload = {
  apiKey: token,
  isPublic: false,
  name: 'PDH Bridge Bot Test',
  spellbotGameId: 'test-' + Date.now(),
  seatLimit: 4,
  format: 'commander',
  discordGuild: '123456789',
  discordChannel: '987654321',
  discordPlayers: [
    { id: '111111111', name: 'TestPlayer1' },
    { id: '222222222', name: 'TestPlayer2' },
    { id: '333333333', name: 'TestPlayer3' },
    { id: '444444444', name: 'TestPlayer4' },
  ],
};

// ===============================
// HELPER: quick fetch with timeout
// ===============================
async function quickFetch(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function getErrorType(err) {
  if (err.name === 'AbortError') return 'timeout';
  if (err.cause?.code === 'ENOTFOUND') return 'dns-fail';
  if (err.cause?.code === 'ECONNREFUSED') return 'refused';
  if (err.cause?.code === 'ECONNRESET') return 'reset';
  if (err.cause?.code === 'CERT_HAS_EXPIRED') return 'ssl-expired';
  if (err.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'ssl-error';
  if (err.message?.includes('SSL') || err.message?.includes('TLS')) return 'ssl-error';
  return err.message?.substring(0, 50) || 'unknown';
}

// ===============================
// PHASE 1: DNS probe
// ===============================
async function probeDNS(domains) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 1: DNS Probe — Which domains are alive?');
  console.log('═══════════════════════════════════════════════════════════\n');

  const alive = [];
  const dead = [];
  const BATCH = 8;

  for (let i = 0; i < domains.length; i += BATCH) {
    const batch = domains.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (domain) => {
      try {
        const resp = await quickFetch(domain, {
          method: 'GET',
          headers: { 'User-Agent': 'pdh-bridge-bot/1.0-probe' },
        }, 5000);
        return { domain, status: resp.status, error: null };
      } catch (err) {
        return { domain, status: null, error: getErrorType(err) };
      }
    }));

    for (const r of results) {
      const hostname = new URL(r.domain).hostname;
      if (r.error) {
        if (r.error === 'dns-fail') {
          dead.push({ domain: r.domain, reason: 'DNS not found' });
        } else if (r.error === 'timeout') {
          dead.push({ domain: r.domain, reason: 'timeout' });
        } else if (r.error === 'refused') {
          // Connection refused means DNS resolved but nothing listening
          // Still interesting — could have API on different port
          dead.push({ domain: r.domain, reason: 'connection refused' });
        } else {
          dead.push({ domain: r.domain, reason: r.error });
        }
      } else {
        console.log(`  ✅ ${hostname} → HTTP ${r.status}`);
        alive.push(r.domain);
      }
    }
  }

  console.log(`\n  Live: ${alive.length} | Dead: ${dead.length}\n`);

  if (dead.length > 0 && dead.length <= 20) {
    console.log('  Dead domains:');
    for (const d of dead) {
      const hostname = new URL(d.domain).hostname;
      console.log(`    ✗ ${hostname} (${d.reason})`);
    }
    console.log('');
  } else if (dead.length > 20) {
    console.log(`  (${dead.length} dead domains omitted for brevity)\n`);
  }

  return alive;
}

// ===============================
// PHASE 2: Root probe
// ===============================
async function probeRoots(domains) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 2: Root Probe — What kind of servers are these?');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const domain of domains) {
    try {
      const resp = await quickFetch(domain, {
        method: 'GET',
        headers: { 'User-Agent': 'pdh-bridge-bot/1.0-probe' },
      }, 5000);

      let bodyPreview = '';
      try {
        const text = await resp.text();
        // Look for API-like indicators
        bodyPreview = text.substring(0, 300).replace(/\n/g, ' ').trim();
      } catch {}

      const hostname = new URL(domain).hostname;
      console.log(`  ${hostname} → ${resp.status}`);

      // Check for API indicators
      if (bodyPreview.includes('"version"') || bodyPreview.includes('"api"') ||
          bodyPreview.includes('"status"') || bodyPreview.includes('"endpoints"') ||
          bodyPreview.includes('swagger') || bodyPreview.includes('openapi')) {
        console.log(`    🔥 LOOKS LIKE AN API! Preview: ${bodyPreview.substring(0, 150)}`);
      } else if (bodyPreview.includes('<!DOCTYPE') || bodyPreview.includes('<html')) {
        console.log(`    📄 HTML website (probably frontend, not API)`);
      } else if (bodyPreview.length > 0) {
        console.log(`    📋 Preview: ${bodyPreview.substring(0, 150)}`);
      }
      console.log('');
    } catch (err) {
      console.log(`  ${new URL(domain).hostname} → error: ${getErrorType(err)}\n`);
    }
  }
}

// ===============================
// PHASE 3: Endpoint blitz
// ===============================
async function blitzEndpoints(domains) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 3: Endpoint Blitz — Testing all path combinations');
  console.log('═══════════════════════════════════════════════════════════\n');

  const totalCombinations = domains.length * ALL_PATHS.length;
  console.log(`  ${domains.length} live domains × ${ALL_PATHS.length} paths = ${totalCombinations} combinations\n`);

  const hits = [];
  const authFails = [];
  const interesting = [];
  let tested = 0;

  for (const domain of domains) {
    const hostname = new URL(domain).hostname;
    console.log(`  Testing ${hostname} (${ALL_PATHS.length} paths)...`);

    const BATCH = 6;
    let domainHits = 0;

    for (let i = 0; i < ALL_PATHS.length; i += BATCH) {
      const batch = ALL_PATHS.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (path) => {
        const url = `${domain}${path}`;
        tested++;
        try {
          const resp = await quickFetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'pdh-bridge-bot/1.0-test',
            },
            body: JSON.stringify(payload),
          }, 6000);

          let data = null;
          try { data = JSON.parse(await resp.text()); } catch {}
          return { url, path, status: resp.status, data, error: null };
        } catch (err) {
          return { url, path, status: null, data: null, error: getErrorType(err) };
        }
      }));

      for (const r of results) {
        if (r.error) continue; // Skip network errors (domain already confirmed alive)

        if (r.status === 200 || r.status === 201) {
          if (r.data?.url) {
            console.log(`    ✅ HIT! ${r.path} → ${r.status} (Game URL: ${r.data.url})`);
            hits.push(r);
            domainHits++;
          } else {
            console.log(`    🟡 ${r.path} → ${r.status} (no game URL in body)`);
            interesting.push(r);
          }
        } else if (r.status === 401 || r.status === 403) {
          console.log(`    🔑 ${r.path} → ${r.status} AUTH FAILED (endpoint EXISTS!)`);
          authFails.push(r);
        } else if (r.status === 400) {
          console.log(`    🟡 ${r.path} → 400 Bad Request (endpoint exists!)`);
          interesting.push(r);
        } else if (r.status === 405) {
          console.log(`    🟡 ${r.path} → 405 Method Not Allowed (exists, wrong method?)`);
          interesting.push(r);
        } else if (r.status >= 500) {
          console.log(`    🟡 ${r.path} → ${r.status} Server Error`);
          interesting.push(r);
        }
        // 404s and 301/302 redirects are silently ignored — expected for wrong paths
      }
    }

    if (domainHits === 0) {
      console.log(`    (no hits on this domain)`);
    }
    console.log('');
  }

  return { hits, authFails, interesting, tested };
}

// ===============================
// MAIN
// ===============================
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║     CONVOKE API ENDPOINT DISCOVERY — EXHAUSTIVE MODE     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log(`Token: ${token.substring(0, 10)}...${token.substring(token.length - 6)}`);
  console.log(`Domains to probe: ${DOMAINS.length}`);
  console.log(`Path combinations per domain: ${ALL_PATHS.length}`);
  console.log(`Maximum total requests: ${DOMAINS.length * ALL_PATHS.length}\n`);

  // Phase 1: Which domains resolve?
  const aliveDomains = await probeDNS(DOMAINS);

  if (aliveDomains.length === 0) {
    console.log('❌ No domains resolved at all. Check your internet connection.');
    return;
  }

  // Phase 2: What kind of servers are running?
  await probeRoots(aliveDomains);

  // Phase 3: Try every endpoint path on every live domain
  const { hits, authFails, interesting, tested } = await blitzEndpoints(aliveDomains);

  // ===============================
  // FINAL SUMMARY
  // ===============================
  console.log('═══════════════════════════════════════════════════════════');
  console.log('FINAL RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`  Tested: ${tested} endpoint combinations\n`);

  if (hits.length > 0) {
    console.log('  🎉🎉🎉 WORKING ENDPOINT(S) FOUND! 🎉🎉🎉\n');
    for (const h of hits) {
      const base = h.url.replace(h.path, '');
      console.log(`    Full URL:  ${h.url}`);
      console.log(`    Base URL:  ${base}`);
      console.log(`    Path:      ${h.path}`);
      console.log(`    Game URL:  ${h.data.url}`);
      if (h.data.password) console.log(`    Password:  ${h.data.password}`);
      console.log('');
      console.log('    👉 Update src/modules/convoke.js:');
      console.log(`       const CONVOKE_API_BASE = '${base}';`);
      console.log(`       const CONVOKE_CREATE_GAME_ENDPOINT = '${base}${h.path}';`);
      console.log('');
    }
  } else if (authFails.length > 0) {
    console.log('  🔑 ENDPOINT(S) FOUND — but token was rejected:\n');
    for (const a of authFails) {
      const base = a.url.replace(a.path, '');
      console.log(`    URL:      ${a.url}`);
      console.log(`    Base URL: ${base}`);
      console.log(`    Status:   ${a.status}`);
      if (a.data) console.log(`    Response: ${JSON.stringify(a.data).substring(0, 300)}`);
      console.log('');
    }
    console.log('    The endpoint exists! Your token may be expired or invalid.');
    console.log('    Contact the Convoke team to verify your API key.\n');
    console.log('    👉 If you get a fresh token, update src/modules/convoke.js:');
    const base0 = authFails[0].url.replace(authFails[0].path, '');
    console.log(`       const CONVOKE_API_BASE = '${base0}';`);
  } else if (interesting.length > 0) {
    console.log('  🟡 Some endpoints responded but none returned a game URL:\n');
    for (const r of interesting) {
      console.log(`    ${r.url} → HTTP ${r.status}`);
      if (r.data) console.log(`    Response: ${JSON.stringify(r.data).substring(0, 300)}`);
      console.log('');
    }
  } else {
    console.log('  ❌ No working endpoints found across all combinations.\n');
    console.log('  Domains that were alive:');
    for (const d of aliveDomains) {
      console.log(`    ✓ ${new URL(d).hostname}`);
    }
    console.log('');
    console.log('  Next steps:');
    console.log('  1. Ask the Convoke team directly: "What\'s the base URL for the game creation API?"');
    console.log('  2. Ask whoever set up bot.py what CONVOKE_ROOT value actually works');
    console.log('  3. Check SpellBot\'s deployment for the CONVOKE_ROOT environment variable');
  }
}

main();