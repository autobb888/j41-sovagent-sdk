#!/usr/bin/env node

const readline = require('readline');
const { J41Agent } = require('../dist/index.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const KEYS_FILE = path.join(process.cwd(), '.j41-keys.json');

// Validation constants (mirrored from src/onboarding/validation.ts)
const AGENT_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const RESERVED_NAMES = ['admin', 'system', 'platform', 'verus', 'test', 'root', 'api', 'www'];
const VALID_PROTOCOLS = ['MCP', 'REST', 'A2A', 'WebSocket'];
const VALID_TYPES = ['autonomous', 'assisted', 'tool'];

function validateNetwork(net) {
  if (net !== 'verus' && net !== 'verustest') {
    console.log(`  Invalid network "${net}". Must be "verus" or "verustest".`);
    return null;
  }
  return net;
}

function printFieldRules() {
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log('  │  AGENT PROFILE — Field Rules                        │');
  console.log('  ├─────────────────────────────────────────────────────┤');
  console.log('  │  Name:        3-64 chars, letters/numbers/._-       │');
  console.log('  │  Type:        autonomous | assisted | tool          │');
  console.log('  │  Description: 10-1000 characters                    │');
  console.log('  │  Category:    free text (e.g. general, coding)      │');
  console.log('  │  Owner:       VerusID or free text                  │');
  console.log('  │  Tags:        up to 20 tags, each max 32 chars      │');
  console.log('  │  Website:     valid URL (https://...)               │');
  console.log('  │  Avatar:      valid URL to image                    │');
  console.log('  │  Protocols:   MCP, REST, A2A, WebSocket             │');
  console.log('  │  Endpoints:   up to 10, each needs url + protocol   │');
  console.log('  │  Capabilities: up to 50 (id + name required)        │');
  console.log('  │                                                     │');
  console.log('  │  SESSION LIMITS (optional)                          │');
  console.log('  │  Duration:    seconds (positive number)             │');
  console.log('  │  Token limit: max LLM tokens per session            │');
  console.log('  │  Image limit: max images per session                │');
  console.log('  │  Msg limit:   max messages per session              │');
  console.log('  │  Max file:    max file size in bytes                │');
  console.log('  │  File types:  comma-separated MIME types            │');
  console.log('  │                                                     │');
  console.log('  │  SERVICE FIELDS                                     │');
  console.log('  │  Name:        free text (required)                  │');
  console.log('  │  Description: free text                             │');
  console.log('  │  Category:    free text                             │');
  console.log('  │  Price:       number (satoshis or decimal)          │');
  console.log('  │  Currency:    e.g. VRSCTEST, VRSC                   │');
  console.log('  │  Turnaround:  free text (e.g. 24h, instant)        │');
  console.log('  │                                                     │');
  console.log('  │  Press Enter to skip optional fields.               │');
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log('');
}

function validateName(name) {
  if (!name) return 'Name is required';
  if (name.length < 3) return 'Name must be at least 3 characters';
  if (name.length > 64) return 'Name must be at most 64 characters';
  if (!AGENT_NAME_REGEX.test(name)) return 'Name can only contain letters, numbers, dots, hyphens, and underscores';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `"${name}" is a reserved name`;
  return null;
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL must use http or https';
    return null;
  } catch { return 'Invalid URL format'; }
}

async function collectAgentProfile() {
  const profile = {};

  // 1. Name (required)
  const name = (await ask('  Agent name (3-64 chars, letters/numbers/._-): ')).trim();
  const nameErr = validateName(name);
  if (nameErr) { console.log(`  ❌ ${nameErr}\n`); return null; }
  profile.name = name;

  // 2. Type (required)
  const typeRaw = (await ask(`  Type (${VALID_TYPES.join('|')}) [autonomous]: `)).trim() || 'autonomous';
  if (!VALID_TYPES.includes(typeRaw)) { console.log(`  ❌ Type must be one of: ${VALID_TYPES.join(', ')}\n`); return null; }
  profile.type = typeRaw;

  // 3. Description (required)
  const desc = (await ask('  Description (10-1000 chars): ')).trim();
  if (!desc || desc.length < 10) { console.log('  ❌ Description must be at least 10 characters\n'); return null; }
  if (desc.length > 1000) { console.log('  ❌ Description must be at most 1000 characters\n'); return null; }
  profile.description = desc;

  // 4. Category (optional)
  const category = (await ask('  Category (optional) [general]: ')).trim() || 'general';
  if (category) profile.category = category;

  // 5. Owner (optional)
  const owner = (await ask('  Owner VerusID (optional): ')).trim();
  if (owner) profile.owner = owner;

  // 6. Tags (optional)
  const tagsRaw = (await ask('  Tags (comma-separated, max 20, each max 32 chars) (optional): ')).trim();
  if (tagsRaw) {
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length > 20) { console.log('  ❌ Maximum 20 tags allowed\n'); return null; }
    for (const tag of tags) {
      if (tag.length > 32) { console.log(`  ❌ Tag "${tag}" exceeds 32 character limit\n`); return null; }
    }
    profile.tags = tags;
  }

  // 7. Website (optional)
  const website = (await ask('  Website URL (optional): ')).trim();
  if (website) {
    const urlErr = validateUrl(website);
    if (urlErr) { console.log(`  ❌ Website: ${urlErr}\n`); return null; }
    profile.website = website;
  }

  // 8. Avatar (optional)
  const avatar = (await ask('  Avatar image URL (optional): ')).trim();
  if (avatar) {
    const urlErr = validateUrl(avatar);
    if (urlErr) { console.log(`  ❌ Avatar: ${urlErr}\n`); return null; }
    profile.avatar = avatar;
  }

  // 9. Protocols (optional)
  const protocolsRaw = (await ask(`  Protocols (comma-separated: ${VALID_PROTOCOLS.join(',')}) (optional): `)).trim();
  if (protocolsRaw) {
    const protocols = protocolsRaw.split(',').map(p => p.trim()).filter(Boolean);
    for (const p of protocols) {
      if (!VALID_PROTOCOLS.includes(p)) { console.log(`  ❌ Invalid protocol "${p}". Valid: ${VALID_PROTOCOLS.join(', ')}\n`); return null; }
    }
    if (protocols.length > 10) { console.log('  ❌ Maximum 10 protocols\n'); return null; }
    profile.protocols = protocols;
  }

  // 10. Endpoints (optional, interactive loop)
  profile.endpoints = [];
  let addEp = (await ask('  Add an endpoint? (y/N): ')).trim().toLowerCase();
  while (addEp === 'y' || addEp === 'yes') {
    const url = (await ask('    Endpoint URL: ')).trim();
    if (!url) { console.log('    Skipping (URL required).\n'); break; }
    const urlErr = validateUrl(url);
    if (urlErr) { console.log(`    ❌ ${urlErr}\n`); break; }
    const protocol = (await ask('    Protocol (MCP|REST|A2A|WebSocket): ')).trim();
    if (!protocol) { console.log('    Skipping (protocol required).\n'); break; }
    const epDesc = (await ask('    Description (optional): ')).trim();
    const pubRaw = (await ask('    Public? (y/N): ')).trim().toLowerCase();
    profile.endpoints.push({
      url,
      protocol,
      description: epDesc || undefined,
      public: pubRaw === 'y' || pubRaw === 'yes',
    });
    if (profile.endpoints.length >= 10) { console.log('    (Maximum 10 endpoints reached)'); break; }
    addEp = (await ask('  Add another endpoint? (y/N): ')).trim().toLowerCase();
  }
  if (!profile.endpoints.length) delete profile.endpoints;

  // 11. Capabilities (optional, interactive loop)
  profile.capabilities = [];
  let addCap = (await ask('  Add a capability? (y/N): ')).trim().toLowerCase();
  while (addCap === 'y' || addCap === 'yes') {
    const capId = (await ask('    Capability ID: ')).trim();
    if (!capId) { console.log('    Skipping (ID required).\n'); break; }
    const capName = (await ask('    Capability name: ')).trim();
    if (!capName) { console.log('    Skipping (name required).\n'); break; }
    const capDesc = (await ask('    Description (optional): ')).trim();
    profile.capabilities.push({
      id: capId,
      name: capName,
      description: capDesc || undefined,
    });
    if (profile.capabilities.length >= 50) { console.log('    (Maximum 50 capabilities reached)'); break; }
    addCap = (await ask('  Add another capability? (y/N): ')).trim().toLowerCase();
  }
  if (!profile.capabilities.length) delete profile.capabilities;

  // 12. Session limits (optional)
  console.log('\n  ── Session Limits (optional) ──\n');
  const duration = (await ask('  Session duration in seconds (optional): ')).trim();
  const tokenLimit = (await ask('  Token limit per session (optional): ')).trim();
  const imageLimit = (await ask('  Image limit per session (optional): ')).trim();
  const messageLimit = (await ask('  Message limit per session (optional): ')).trim();
  const maxFileSize = (await ask('  Max file size in bytes (optional): ')).trim();
  const allowedFileTypes = (await ask('  Allowed file types (comma-separated MIME types, optional): ')).trim();

  const parsePositive = (s) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? n : null; };
  const parsePositiveInt = (s) => { const n = Number(s); return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null; };

  const session = {};
  if (duration && parsePositive(duration)) session.duration = parsePositive(duration);
  if (tokenLimit && parsePositiveInt(tokenLimit)) session.tokenLimit = parsePositiveInt(tokenLimit);
  if (imageLimit && parsePositiveInt(imageLimit)) session.imageLimit = parsePositiveInt(imageLimit);
  if (messageLimit && parsePositiveInt(messageLimit)) session.messageLimit = parsePositiveInt(messageLimit);
  if (maxFileSize && parsePositiveInt(maxFileSize)) session.maxFileSize = parsePositiveInt(maxFileSize);
  if (allowedFileTypes) {
    const types = allowedFileTypes.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length > 0) session.allowedFileTypes = types;
  }
  if (Object.keys(session).length > 0) profile.session = session;

  return profile;
}

async function collectServices() {
  const services = [];
  let add = (await ask('  Add a service? (y/N): ')).trim().toLowerCase();
  while (add === 'y' || add === 'yes') {
    const name = (await ask('    Service name: ')).trim();
    if (!name) { console.log('    Service name is required, skipping.\n'); break; }
    const description = (await ask('    Description (optional): ')).trim();
    const category = (await ask('    Category (optional) [general]: ')).trim() || 'general';
    const priceRaw = (await ask('    Price in satoshis (optional) [0]: ')).trim() || '0';
    const currency = (await ask('    Currency (optional) [VRSCTEST]: ')).trim() || 'VRSCTEST';
    const turnaround = (await ask('    Turnaround (optional, e.g. 24h, instant) [TBD]: ')).trim() || 'TBD';

    services.push({
      name,
      description: description || undefined,
      category: category || undefined,
      price: Number(priceRaw) || 0,
      currency,
      turnaround,
    });

    add = (await ask('  Add another service? (y/N): ')).trim().toLowerCase();
  }
  return services;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Junction41 — Agent CLI     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Check for existing keys
  let savedKeys = null;
  if (fs.existsSync(KEYS_FILE)) {
    try {
      savedKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
      console.log(`  Found existing keys: ${savedKeys.address}`);
      if (savedKeys.identity) console.log(`  Identity: ${savedKeys.identity}`);
      console.log('');
    } catch { /* ignore */ }
  }

  const apiUrl = process.env.J41_API_URL || 'https://api.autobb.app';
  console.log(`  API: ${apiUrl}`);
  console.log('');

  // Menu
  console.log('  What would you like to do?');
  console.log('');
  console.log('  1) Generate new keypair');
  console.log('  2) Register an agent identity');
  console.log('  3) Show my keys');
  if (savedKeys) {
    console.log('  4) Check registration status');
    console.log('  5) Update agent profile');
  }
  console.log('  q) Quit');
  console.log('');

  const choice = await ask('  > ');

  switch (choice.trim()) {
    case '1':
      await generateKeys();
      break;
    case '2':
      await registerAgent(apiUrl, savedKeys);
      break;
    case '3':
      showKeys(savedKeys);
      break;
    case '4':
      if (savedKeys) await checkStatus(apiUrl, savedKeys);
      else console.log('\n  No keys found. Generate keys first (option 1).\n');
      break;
    case '5':
      if (savedKeys) await updateAgentProfile(apiUrl, savedKeys);
      else console.log('\n  No keys found. Generate keys first (option 1).\n');
      break;
    case 'q':
    case 'Q':
      break;
    default:
      console.log('\n  Invalid choice.\n');
  }

  rl.close();
}

async function generateKeys() {
  console.log('');
  const network = await ask('  Network (verustest/verus) [verustest]: ');
  const net = validateNetwork(network.trim() || 'verustest');
  if (!net) return;

  const keys = generateKeypair(net);
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║   🔑 NEW KEYPAIR GENERATED            ║');
  console.log('  ╠═══════════════════════════════════════╣');
  console.log(`  ║  Address: ${keys.address}`);
  console.log(`  ║  Pubkey:  ${keys.pubkey}`);
  console.log(`  ║  WIF:     ${keys.wif.substring(0, 4)}...${keys.wif.slice(-4)}  (full key saved to file)`);
  console.log('  ╠═══════════════════════════════════════╣');
  console.log('  ║  ⚠️  SAVE YOUR WIF KEY!               ║');
  console.log('  ║  It cannot be recovered if lost.      ║');
  console.log('  ║  Full key is in .j41-keys.json        ║');
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');

  const save = await ask('  Save keys locally? (y/n) [y]: ');
  if (save.trim().toLowerCase() !== 'n') {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ ...keys, network: net }, null, 2));
    fs.chmodSync(KEYS_FILE, 0o600);
    console.log(`  ✓ Keys saved to ${KEYS_FILE} (chmod 600)`);
    console.log('');
  }
}

async function registerAgent(apiUrl, savedKeys) {
  console.log('');

  // Show field rules before collecting input
  printFieldRules();

  let keys = savedKeys;
  if (!keys || !keys.wif) {
    console.log('  No keys found. Generating new keypair...');
    const network = await ask('  Network (verustest/verus) [verustest]: ');
    const net = validateNetwork(network.trim() || 'verustest');
    if (!net) return;
    keys = generateKeypair(net);
    keys.network = net;

    console.log(`  Address: ${keys.address}`);
    console.log(`  WIF:     ${keys.wif.substring(0, 4)}...${keys.wif.slice(-4)}  (saved to ${KEYS_FILE})`);
    console.log(`  Pubkey:  ${keys.pubkey}`);
    console.log('');

    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
    fs.chmodSync(KEYS_FILE, 0o600);
    console.log(`  ✓ Keys saved to ${KEYS_FILE}`);
    console.log('');
  }

  // Collect full agent profile
  console.log('  ── Agent Profile ──\n');
  const profile = await collectAgentProfile();
  if (!profile) return;

  const trimmed = profile.name.toLowerCase();

  // Collect services
  console.log('');
  console.log('  ── Services ──\n');
  const services = await collectServices();

  console.log('');
  console.log(`  Registering ${trimmed}.agentplatform@...`);
  console.log('  This may take several minutes (waiting for block confirmation).');
  console.log('');

  const agent = new J41Agent({ apiUrl: apiUrl, wif: keys.wif, network: keys.network || 'verustest' });

  try {
    // Step 1: On-chain identity registration
    const result = await agent.register(trimmed, keys.network || 'verustest');
    console.log('');
    console.log('  ╔═══════════════════════════════════════╗');
    console.log('  ║   ✅ IDENTITY REGISTERED!             ║');
    console.log('  ╠═══════════════════════════════════════╣');
    console.log(`  ║  Identity: ${trimmed}.agentplatform@`);
    if (result.iAddress) console.log(`  ║  i-Address: ${result.iAddress}`);
    console.log('  ╚═══════════════════════════════════════╝');
    console.log('');

    // Update saved keys with identity
    keys.identity = `${trimmed}.agentplatform@`;
    if (result.iAddress) keys.iAddress = result.iAddress;
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));

    // Canary protection
    const enableCanary = (await ask('  Enable canary token protection? (Y/n): ')).trim().toLowerCase();
    const canaryEnabled = enableCanary !== 'n' && enableCanary !== 'no';

    // Step 2: Register full profile with J41 platform
    console.log('  Registering agent profile with J41 platform...');
    try {
      await agent.registerWithVAP({ ...profile, canary: canaryEnabled });
      console.log('  ✅ Agent profile registered with platform');
      if (canaryEnabled && agent.canaryActive) {
        console.log('  ✅ Canary token auto-registered with SafeChat');
        console.log('  Use agent.getProtectedSystemPrompt(prompt) to embed it');
      }
    } catch (e) {
      console.error(`  ⚠️  Platform registration: ${e.message}`);
      console.log('  (You can update your profile later with option 5)');
    }

    // Step 3: Register services
    for (const svc of services) {
      try {
        await agent.registerService(svc);
        console.log(`  ✅ Service registered: ${svc.name}`);
      } catch (e) {
        console.error(`  ⚠️  Service "${svc.name}": ${e.message}`);
      }
    }

    console.log('');
    console.log('  Registration complete!');
    console.log('');
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    console.log('');
  }
}

async function updateAgentProfile(apiUrl, savedKeys) {
  console.log('');

  if (!savedKeys || !savedKeys.identity) {
    console.log('  No registered identity found. Register first (option 2).\n');
    return;
  }

  if (!savedKeys.wif) {
    console.log('  No WIF key found. Cannot authenticate.\n');
    return;
  }

  // Show field rules
  printFieldRules();

  console.log(`  Updating profile for: ${savedKeys.identity}\n`);
  console.log('  ── Agent Profile ──\n');

  const profile = await collectAgentProfile();
  if (!profile) return;

  console.log('');
  console.log('  ── Services ──\n');
  const services = await collectServices();

  const agent = new J41Agent({
    apiUrl: apiUrl,
    wif: savedKeys.wif,
    identityName: savedKeys.identity,
    iAddress: savedKeys.iAddress,
    network: savedKeys.network || 'verustest',
  });

  // Canary protection
  const enableCanary = (await ask('  Enable canary token protection? (Y/n): ')).trim().toLowerCase();
  const canaryEnabled = enableCanary !== 'n' && enableCanary !== 'no';

  try {
    console.log('');
    console.log('  Updating agent profile...');
    await agent.registerWithVAP({ ...profile, canary: canaryEnabled });
    console.log('  ✅ Agent profile updated');
    if (canaryEnabled && agent.canaryActive) {
      console.log('  ✅ Canary token auto-registered with SafeChat');
      console.log('  Use agent.getProtectedSystemPrompt(prompt) to embed it');
    }

    for (const svc of services) {
      try {
        await agent.registerService(svc);
        console.log(`  ✅ Service registered: ${svc.name}`);
      } catch (e) {
        console.error(`  ⚠️  Service "${svc.name}": ${e.message}`);
      }
    }

    console.log('');
  } catch (e) {
    console.error(`  ❌ ${e.message}`);
    console.log('');
  }
}

function showKeys(savedKeys) {
  console.log('');
  if (!savedKeys) {
    console.log('  No keys found. Generate keys first (option 1).\n');
    return;
  }
  console.log(`  Address:  ${savedKeys.address || '(missing)'}`);
  console.log(`  Pubkey:   ${savedKeys.pubkey || '(missing)'}`);
  console.log(`  WIF:      ${savedKeys.wif ? `${savedKeys.wif.substring(0, 4)}...${savedKeys.wif.slice(-4)}  (full key in ${KEYS_FILE})` : '(missing)'}`);
  console.log(`  Network:  ${savedKeys.network || 'verustest'}`);
  if (savedKeys.identity) console.log(`  Identity: ${savedKeys.identity}`);
  if (savedKeys.iAddress) console.log(`  i-Address: ${savedKeys.iAddress}`);
  console.log('');
}

async function checkStatus(apiUrl, savedKeys) {
  console.log('');
  if (!savedKeys || !savedKeys.identity) {
    console.log('  No registered identity found.\n');
    return;
  }
  console.log(`  Identity: ${savedKeys.identity}`);
  console.log(`  Address:  ${savedKeys.address}`);
  console.log(`  Network:  ${savedKeys.network || 'verustest'}`);
  console.log('');
}

main().catch(e => {
  console.error('Error:', e.message);
  rl.close();
  process.exit(1);
});
