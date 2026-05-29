import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Client as UpnpClient, Device as UpnpDevice } from 'nat-upnp-rejetto';
import { PrismaClient } from '@prisma/client';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type {
  AbilityDefinition,
  AbilityPrompt,
  AbilitySourceType,
  AbilityTargetOption,
  AbilityTiming,
  AbilityType,
  AbilityTriggerTiming,
  AssignedItemCard,
  BootstrapResponse,
  FactionType,
  GameLogEntry,
  GameResultStatus,
  GameSnapshot,
  HobbyDefinition,
  HobbyType,
  ItemOverflowPrompt,
  ItemDefinition,
  LobbyParticipant,
  LobbySnapshot,
  PhaseSettings,
  PlayerStateTag,
  PlayerStatus,
  RoleDefinition,
  RoleSetDefinition,
} from '@super-jinroh/shared';

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const currentFilePath = fileURLToPath(import.meta.url);
const serverSrcDir = path.dirname(currentFilePath);
const serverRootDir = path.resolve(serverSrcDir, '..');
const productRootDir = path.resolve(serverRootDir, '..');
const clientDistDir = path.join(productRootDir, 'client', 'dist');
const clientIndexPath = path.join(clientDistDir, 'index.html');

const DEFAULT_PORT = 11037;
const CLIENT_ID_HEADER = 'x-super-jinroh-client-id';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const ABILITY_TIMING_VALUES = [
  'NONE',
  'GAME_START',
  'ZERO_NIGHT',
  'DAY_START',
  'NIGHT',
  'SELF_DEATH',
  'SELF_DYING',
  'SELF_RECOVERED',
  'ASSAULT_DEATH',
  'DAY',
  'ANY',
  'MORNING_START',
  'VOTE_START',
  'NIGHT_START',
] as const satisfies readonly AbilityTiming[];
const ACTIVATION_TIMINGS = new Set<AbilityTiming>(['DAY', 'NIGHT', 'ANY', 'MORNING_START', 'DAY_START', 'VOTE_START', 'NIGHT_START']);
const TRIGGER_TIMINGS = new Set<AbilityTiming>(['GAME_START', 'ZERO_NIGHT', 'DAY_START', 'NIGHT', 'SELF_DEATH', 'SELF_DYING', 'SELF_RECOVERED', 'ASSAULT_DEATH']);
const PHASE_DURATIONS = {
  MORNING: Number(process.env.MORNING_SECONDS ?? 15),
  DAY: Number(process.env.DAY_SECONDS ?? 300),
  VOTE: Number(process.env.VOTE_SECONDS ?? 60),
  NIGHT: Number(process.env.NIGHT_SECONDS ?? 90),
};

const SETTING_KEYS = {
  selectedRoleSetId: 'selectedRoleSetId',
  daySeconds: 'daySeconds',
  nightSeconds: 'nightSeconds',
} as const;

const roleSetSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  requiredPlayerCount: z.number().int().min(4).max(16),
  monsterWinRequiredKills: z.number().int().min(1),
  roles: z.array(z.object({
    roleId: z.string().min(1),
    min: z.number().int().min(0),
    max: z.number().int().min(0),
    resolvedCount: z.number().int().min(0).optional(),
  })).min(1),
  version: z.string().min(1),
  enabled: z.boolean(),
});

const roleDefinitionSchema = z.object({
  roleId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  abilityIds: z.array(z.string()),
  enabled: z.boolean(),
});

const abilityDefinitionSchema = z.object({
  abilityId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  abilityType: z.enum(['PASSIVE', 'ACTIVE', 'TRIGGERED', 'PROFESSION'] as [AbilityType, AbilityType, AbilityType, AbilityType]),
  timing: z.enum(ABILITY_TIMING_VALUES),
  canCancel: z.boolean(),
  targetCount: z.number().int().min(0).max(16),
  implementationKey: z.string().min(1),
  enabled: z.boolean(),
});

const hobbyDefinitionSchema = z.object({
  hobbyId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  hobbyType: z.enum(['SKILL', 'SPELL', 'SPECIAL'] as [HobbyType, HobbyType, HobbyType]),
  abilityIds: z.array(z.string()),
  enabled: z.boolean(),
});

const itemDefinitionSchema = z.object({
  itemId: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  abilityIds: z.array(z.string()),
  cardCount: z.number().int().min(1),
  enabled: z.boolean(),
});

const appConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  allowMultipleParticipantsPerIp: z.boolean().default(false),
  enableUpnpPortMapping: z.boolean().default(true),
  upnpPortMappingDescription: z.string().trim().min(1).default('superJinroh'),
  upnpLeaseDurationSeconds: z.number().int().min(0).default(0),
  itemHandLimit: z.number().int().min(1).default(2),
  requireAdminPassword: z.boolean().default(true),
  adminPassword: z.string().default(''),
});

type PhaseType = 'LOBBY' | 'MORNING' | 'DAY' | 'VOTE' | 'NIGHT' | 'RESULT';
type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'FINISHED';
type DeathCause = 'EXECUTION' | 'ASSAULT' | 'LINE_OF_DUTY' | 'EXORCISM';
type AppConfig = z.infer<typeof appConfigSchema>;

interface RuntimeUpnpState {
  client: UpnpClient;
  privateHost: string;
  gatewayLocation: string;
}

interface DiscoveredUpnpGateway {
  address: string;
  location: string;
}

interface RuntimeParticipant extends LobbyParticipant {
  ipAddress: string;
  rawIpAddress: string;
  socket?: WebSocket;
}

interface RuntimePlayer {
  id: string;
  seatOrder: number;
  ipAddress: string;
  rawIpAddress: string;
  displayName: string;
  publicRoleId: string | null;
  resultStatus: GameResultStatus | null;
  roleId: string;
  roleAbilityIds: string[];
  hobbyId: string;
  hobbyAbilityIds: string[];
  status: PlayerStatus;
  stateTags: PlayerStateTag[];
  deathCause: DeathCause | null;
  isConnected: boolean;
}

interface RuntimeGameLogEntry extends GameLogEntry {
  visibility: 'PUBLIC' | 'PRIVATE';
  ownerPlayerId: string | null;
}

interface RuntimeItemOverflowPrompt extends ItemOverflowPrompt {
  ownerPlayerId: string;
}

interface RuntimeDeckCard extends AssignedItemCard {
  drawOrder: number;
  serialInItem: number;
}

interface RuntimeQueuedAbility {
  queueId: string;
  abilityKey: string;
  abilityId: string;
  actorPlayerId: string;
  sourceType: AbilitySourceType;
  sourceId: string;
  itemCardId: string | null;
  targetIds: string[];
}

interface RuntimeReservedAbility {
  abilityKey: string;
  abilityId: string;
  sourceType: AbilitySourceType;
  sourceId: string;
  itemCardId: string | null;
}

interface RuntimeGrantedTriggeredAbility {
  grantId: string;
  sourceItemId: string;
  abilityId: string;
}

interface TriggeredAbilitySource {
  sourceType: AbilitySourceType;
  sourceId: string;
  ability: AbilityDefinition;
  itemCardId: string | null;
}

interface RuntimeAbilityPrompt extends AbilityPrompt {
  actorPlayerId: string;
}

interface PendingMorningEffect {
  effectId: string;
  type: 'MAKE_DYING' | 'DISCARD_ITEM' | 'DISCOVER_DEAD';
  targetPlayerId: string;
  causedByPlayerId: string | null;
  deathCause?: DeathCause;
}

interface RuntimeGame {
  gameId: string;
  status: GameStatus;
  phase: PhaseType;
  isPaused: boolean;
  dayNumber: number;
  roleSet: RoleSetDefinition;
  players: RuntimePlayer[];
  deckCards: RuntimeDeckCard[];
  currentTimerEndsAt: string | null;
  pausedRemainingMs: number | null;
  monsterKillCount: number;
  monsterKillGoalReachedDay: number | null;
  lastNightDeaths: number;
  pendingAbilityPromptByPlayerId: Map<string, RuntimeAbilityPrompt>;
  pendingProphecyDiaryTargetByPlayerId: Map<string, string>;
  pendingChocolateFirstTargetByPlayerId: Map<string, string>;
  hobbyTypeOverrideByPlayerId: Map<string, HobbyType>;
  pendingTriggeredAbilitiesByPlayerId: Map<string, TriggeredAbilitySource[]>;
  grantedTriggeredAbilitiesByPlayerId: Map<string, RuntimeGrantedTriggeredAbility[]>;
  reservedAbilitiesByPlayerId: Map<string, RuntimeReservedAbility[]>;
  pendingReservedAbilitiesByPlayerId: Map<string, RuntimeReservedAbility[]>;
  pendingItemOverflowByPlayerId: Map<string, RuntimeItemOverflowPrompt>;
  guardAssignments: Map<string, string>;
  morningStartProtectionPlayerIds: Set<string>;
  protectedFromDyingUntilMorningEndByPlayerId: Map<string, number>;
  investigateBlockedNightByPlayerId: Map<string, number>;
  blockedDetectiveInvestigateNightByPlayerId: Map<string, number>;
  blockedMonsterAssaultNightDay: number | null;
  itemsDisabledUntilNightEndDay: number | null;
  bonusVoteCountByPlayerId: Map<string, number>;
  blockedVoteByPlayerId: Set<string>;
  untargetableVoteTargetPlayerIds: Set<string>;
  revealedOnAssaultDeathPlayerIds: Set<string>;
  resolvedAssaultDeathAbilityKeys: Set<string>;
  abilityQueue: RuntimeQueuedAbility[];
  pendingMorningEffects: PendingMorningEffect[];
  isProcessingAbilityQueue: boolean;
  cancelQueuedAbilitiesRequested: boolean;
  eventLogs: RuntimeGameLogEntry[];
  votes: Map<string, string>;
  phaseTimeout?: NodeJS.Timeout;
}

type RuntimePlayerStateTag = PlayerStateTag;
const PROTECTED_SPECIAL_ABILITY_ID = 'special-protected-survive-dying';

const runtime = {
  participants: new Map<string, RuntimeParticipant>(),
  config: appConfigSchema.parse({}),
  phaseSettings: {
    daySeconds: PHASE_DURATIONS.DAY,
    nightSeconds: PHASE_DURATIONS.NIGHT,
  } as PhaseSettings,
  abilities: [] as AbilityDefinition[],
  abilityById: new Map<string, AbilityDefinition>(),
  roles: [] as RoleDefinition[],
  roleById: new Map<string, RoleDefinition>(),
  roleSets: [] as RoleSetDefinition[],
  roleSetById: new Map<string, RoleSetDefinition>(),
  hobbies: [] as HobbyDefinition[],
  hobbyById: new Map<string, HobbyDefinition>(),
  items: [] as ItemDefinition[],
  itemById: new Map<string, ItemDefinition>(),
  selectedRoleSetId: null as string | null,
  game: null as RuntimeGame | null,
  upnp: null as RuntimeUpnpState | null,
  shutdownPromise: null as Promise<void> | null,
};

const SPECIAL_GRANTING_IMPLEMENTATION_KEYS = new Set([
  'fumie-detect-cultist',
  'detective-kiseru-investigate',
  'suspicious-jewel-detect-evil-god',
  'mirror-of-truth-detect-villager',
  'amulet-protect',
  'handgun-protect',
]);

const GRANTED_SPECIAL_ABILITY_IDS_BY_IMPLEMENTATION_KEY = new Map<string, string>([
  ['fumie-detect-cultist', 'special-fumie-detect-cultist'],
  ['detective-kiseru-investigate', 'special-detective-kiseru-investigate'],
  ['suspicious-jewel-detect-evil-god', 'special-suspicious-jewel-detect-evil-god'],
  ['mirror-of-truth-detect-villager', 'special-mirror-of-truth-detect-villager'],
  ['amulet-protect', PROTECTED_SPECIAL_ABILITY_ID],
  ['handgun-protect', PROTECTED_SPECIAL_ABILITY_ID],
]);

function dataPath(...parts: string[]) {
  return path.join(serverRootDir, 'data', ...parts);
}

function sendRootDocument(res: express.Response) {
  if (existsSync(clientIndexPath)) {
    res.sendFile(clientIndexPath);
    return;
  }

  res.status(200).type('html').send(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>superJinroh server</title>
    <style>
      body { font-family: sans-serif; padding: 32px; background: #111827; color: #f9fafb; }
      code { background: #1f2937; padding: 2px 6px; border-radius: 6px; }
      a { color: #f59e0b; }
    </style>
  </head>
  <body>
    <h1>superJinroh server is running</h1>
    <p>client build was not found. Build the client to serve the game UI from this server.</p>
    <p>Expected file: <code>${clientIndexPath}</code></p>
    <p>Available API: <a href="/api/bootstrap">/api/bootstrap</a></p>
  </body>
</html>`);
}

function shuffle<T>(input: T[]): T[] {
  const list = [...input];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function getIpAddress(req: http.IncomingMessage | express.Request): string {
  const raw = ('ip' in req ? req.ip : req.socket.remoteAddress) ?? 'unknown';
  return raw.replace('::ffff:', '');
}

function hashIp(ipAddress: string): string {
  return createHash('md5').update(ipAddress).digest('hex');
}

function getRoleFaction(roleId: string): FactionType {
  if (roleId === 'monster' || roleId === 'cultist' || roleId === 'ghost' || roleId === 'hyena') {
    return 'MONSTER';
  }
  if (roleId === 'evil-god') {
    return 'EVIL_GOD';
  }
  return 'HUMAN';
}

function getPhaseSettings(): PhaseSettings {
  return {
    daySeconds: runtime.phaseSettings.daySeconds,
    nightSeconds: runtime.phaseSettings.nightSeconds,
  };
}

function getServerPort(): number {
  return runtime.config.port;
}

function getClientId(req: http.IncomingMessage | express.Request): string {
  const fromHeader = req.headers[CLIENT_ID_HEADER] ?? req.headers[CLIENT_ID_HEADER.toLowerCase()];
  const headerValue = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  const url = 'url' in req ? req.url : undefined;
  if (typeof url === 'string') {
    const queryValue = new URL(url, 'http://localhost').searchParams.get('clientId');
    if (queryValue && queryValue.trim()) {
      return queryValue.trim();
    }
  }

  return 'anonymous';
}

function buildParticipantIdentityKey(rawIpAddress: string, clientId: string): string {
  return runtime.config.allowMultipleParticipantsPerIp ? `${rawIpAddress}::${clientId}` : rawIpAddress;
}

function findParticipantByIdentityKey(identityKey: string): RuntimeParticipant | null {
  return Array.from(runtime.participants.values()).find((participant) => participant.ipAddress === identityKey) ?? null;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

async function loadAppConfig() {
  runtime.config = appConfigSchema.parse(await readJsonFile<AppConfig>(dataPath('config.json')));
}

function resolveLocalIpv4Address(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return null;
}

function isPrivateIpv4Host(hostname: string) {
  return /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
}

function rankUpnpGatewayLocation(location: string) {
  try {
    const { hostname } = new URL(location);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return isPrivateIpv4Host(hostname) ? 400 : 300;
    }
    if (hostname.includes(':')) {
      if (/^(fd|fc)[0-9a-f]{2}:/i.test(hostname) || /^fe80:/i.test(hostname)) {
        return 100;
      }
      return 0;
    }
    return 200;
  } catch {
    return -1;
  }
}

async function discoverUpnpGateway(client: UpnpClient): Promise<DiscoveredUpnpGateway> {
  const emitter = client.ssdp.search('urn:schemas-upnp-org:device:InternetGatewayDevice:1');
  const candidates: DiscoveredUpnpGateway[] = [];

  const bestCandidate = () => candidates
    .slice()
    .sort((left, right) => rankUpnpGatewayLocation(right.location) - rankUpnpGatewayLocation(left.location))[0] ?? null;

  return new Promise((resolve, reject) => {
    let settleTimer: NodeJS.Timeout | null = null;
    const timeoutTimer = setTimeout(() => {
      emitter.emit('end');
      const selected = bestCandidate();
      if (selected) {
        resolve(selected);
        return;
      }
      reject(new Error('Connection timed out while searching for the gateway.'));
    }, 5000);

    const finish = () => {
      clearTimeout(timeoutTimer);
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      emitter.emit('end');
    };

    emitter.on('device', (info, address) => {
      const location = typeof info.location === 'string' ? info.location : '';
      if (!location) {
        return;
      }
      if (rankUpnpGatewayLocation(location) <= 0) {
        return;
      }
      candidates.push({ address, location });
      const selected = bestCandidate();
      if (selected && rankUpnpGatewayLocation(selected.location) >= 400) {
        finish();
        resolve(selected);
        return;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        finish();
        const best = bestCandidate();
        if (best) {
          resolve(best);
          return;
        }
        reject(new Error('No UPnP gateway responded with a usable location.'));
      }, 250);
    });
  });
}

async function runUpnpAction(gatewayLocation: string, action: string, args: [string, string | number][]) {
  return new UpnpDevice(gatewayLocation).run(action, args);
}

async function getUpnpPublicIp(gatewayLocation: string) {
  const data = await runUpnpAction(gatewayLocation, 'GetExternalIPAddress', []);
  const key = Object.keys(data || {}).find((entry) => /^GetExternalIPAddressResponse$/.test(entry));
  if (!key) {
    throw new Error('Incorrect response');
  }
  const response = data[key] as { NewExternalIPAddress?: string } | undefined;
  return response?.NewExternalIPAddress?.trim() || null;
}

async function resolveClientShareAddress(): Promise<string | null> {
  let client: UpnpClient | null = null;
  let ownsClient = false;

  try {
    client = runtime.upnp?.client ?? new UpnpClient({ timeout: 5000 });
    ownsClient = !runtime.upnp;
    const gatewayLocation = runtime.upnp?.gatewayLocation ?? (await discoverUpnpGateway(client)).location;
    const publicIpAddress = await getUpnpPublicIp(gatewayLocation);
    if (publicIpAddress) {
      return `http://${publicIpAddress}:${getServerPort()}`;
    }
  } catch {
    // Fall back to the local address when the gateway does not expose the public IP.
  } finally {
    if (ownsClient && client) {
      client.close();
    }
  }

  return null;
}

async function openUpnpPortMapping() {
  if (!runtime.config.enableUpnpPortMapping) {
    console.log('UPnP port mapping is disabled by config.');
    return;
  }

  const privateHost = resolveLocalIpv4Address();
  if (!privateHost) {
    console.warn('UPnP port mapping skipped because no local IPv4 address was found.');
    return;
  }

  const client = new UpnpClient({ timeout: 5000 });
  try {
    const gateway = await discoverUpnpGateway(client);
    await runUpnpAction(gateway.location, 'AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', getServerPort()],
      ['NewProtocol', 'TCP'],
      ['NewInternalPort', getServerPort()],
      ['NewInternalClient', privateHost],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', runtime.config.upnpPortMappingDescription],
      ['NewLeaseDuration', runtime.config.upnpLeaseDurationSeconds],
    ]);
    runtime.upnp = { client, privateHost, gatewayLocation: gateway.location };
    console.log(`UPnP port mapping enabled for tcp/${getServerPort()} on ${privateHost}.`);
  } catch (error) {
    client.close();
    console.warn(
      `UPnP port mapping failed for tcp/${getServerPort()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function closeUpnpPortMapping() {
  const current = runtime.upnp;
  runtime.upnp = null;
  if (!current) {
    return;
  }

  try {
    await runUpnpAction(current.gatewayLocation, 'DeletePortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', getServerPort()],
      ['NewProtocol', 'TCP'],
    ]);
    console.log(`UPnP port mapping removed for tcp/${getServerPort()}.`);
  } catch (error) {
    console.warn(
      `Failed to remove UPnP port mapping for tcp/${getServerPort()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    current.client.close();
  }
}

function listenServer() {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError);
      reject(error);
    };

    server.once('error', onError);
    server.listen(getServerPort(), () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function shutdown(reason: string, exitCode = 0) {
  if (runtime.shutdownPromise) {
    return runtime.shutdownPromise;
  }

  runtime.shutdownPromise = (async () => {
    console.log(`Shutting down superJinroh server (${reason}).`);
    clearPhaseTimeout();
    await closeUpnpPortMapping();
    await new Promise<void>((resolve) => {
      wss.close();
      server.close(() => resolve());
    });
    await prisma.$disconnect();
    process.exitCode = exitCode;
  })();

  return runtime.shutdownPromise;
}

function registerShutdownHandlers() {
  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal, 0).finally(() => process.exit());
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.once('uncaughtException', (error) => {
    console.error(error);
    void shutdown('uncaughtException', 1).finally(() => process.exit(1));
  });
  process.once('unhandledRejection', (reason) => {
    console.error(reason);
    void shutdown('unhandledRejection', 1).finally(() => process.exit(1));
  });
}

function resolveImagePath(category: 'roles' | 'hobbies' | 'items', id: string): string | null {
  const imageFilePath = dataPath('images', category, `${id}.webp`);
  if (!existsSync(imageFilePath)) {
    return null;
  }
  return `/master-data-images/${category}/${id}.webp`;
}

async function loadDefinitionsFromDirectory<T>(directory: string, schema: z.ZodType<T>): Promise<T[]> {
  const loaded: T[] = [];

  async function visitDirectory(targetDirectory: string) {
    const entries = await fs.readdir(targetDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'ja'))) {
      const targetPath = path.join(targetDirectory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(targetPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        loaded.push(schema.parse(await readJsonFile<T>(targetPath)));
      }
    }
  }

  await visitDirectory(dataPath(directory));
  return loaded;
}

async function loadRoleDefinitions() {
  const loaded = await loadDefinitionsFromDirectory('roles', roleDefinitionSchema);
  runtime.roles = loaded
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      ...entry,
      faction: getRoleFaction(entry.roleId),
      imagePath: resolveImagePath('roles', entry.roleId),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
  runtime.roleById = new Map(runtime.roles.map((entry) => [entry.roleId, entry]));
}

async function loadAbilityDefinitions() {
  runtime.abilities = (await loadDefinitionsFromDirectory('abilities', abilityDefinitionSchema))
    .filter((entry) => entry.enabled)
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
  runtime.abilityById = new Map(runtime.abilities.map((entry) => [entry.abilityId, entry]));
}

async function loadRoleSets() {
  const dir = dataPath('role-sets');
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  const loaded: RoleSetDefinition[] = [];
  for (const file of files) {
    const parsed = roleSetSchema.parse(await readJsonFile<RoleSetDefinition>(path.join(dir, file)));
    const minTotal = parsed.roles.reduce((sum, role) => sum + role.min, 0);
    const maxTotal = parsed.roles.reduce((sum, role) => sum + role.max, 0);
    if (parsed.roles.some((role) => role.min > role.max)) {
      throw new Error(`Role set ${parsed.id} has invalid role min/max range.`);
    }
    if (minTotal > parsed.requiredPlayerCount || maxTotal < parsed.requiredPlayerCount) {
      throw new Error(`Role set ${parsed.id} cannot satisfy requiredPlayerCount.`);
    }
    if (parsed.monsterWinRequiredKills >= parsed.requiredPlayerCount) {
      throw new Error(`Role set ${parsed.id} has invalid monsterWinRequiredKills.`);
    }
    for (const role of parsed.roles) {
      if (!runtime.roleById.has(role.roleId)) {
        throw new Error(`Role set ${parsed.id} references unknown role ${role.roleId}.`);
      }
    }
    loaded.push(parsed);
  }
  loaded.sort((left, right) => {
    if (left.requiredPlayerCount !== right.requiredPlayerCount) {
      return left.requiredPlayerCount - right.requiredPlayerCount;
    }
    return left.displayName.localeCompare(right.displayName, 'ja');
  });
  runtime.roleSets = loaded.filter((entry) => entry.enabled);
  runtime.roleSetById = new Map(runtime.roleSets.map((entry) => [entry.id, entry]));
}

function resolveRoleSet(roleSet: RoleSetDefinition): RoleSetDefinition {
  const roles = roleSet.roles.map((entry) => ({
    roleId: entry.roleId,
    min: entry.min,
    max: entry.max,
    resolvedCount: entry.min,
  }));
  let remaining = roleSet.requiredPlayerCount - roles.reduce((sum, entry) => sum + entry.resolvedCount, 0);
  while (remaining > 0) {
    const candidates = roles.filter((entry) => (entry.resolvedCount ?? 0) < entry.max);
    if (candidates.length < 1) {
      throw new Error(`Role set ${roleSet.id} could not resolve to requiredPlayerCount.`);
    }
    const selected = shuffle(candidates)[0];
    selected.resolvedCount = (selected.resolvedCount ?? 0) + 1;
    remaining -= 1;
  }
  return {
    ...roleSet,
    roles,
  };
}

async function loadMasterData() {
  runtime.hobbies = (await loadDefinitionsFromDirectory('hobbies', hobbyDefinitionSchema))
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      ...entry,
      imagePath: resolveImagePath('hobbies', entry.hobbyId),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
  runtime.hobbyById = new Map(runtime.hobbies.map((entry) => [entry.hobbyId, entry]));

  runtime.items = (await loadDefinitionsFromDirectory('items', itemDefinitionSchema))
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      ...entry,
      imagePath: resolveImagePath('items', entry.itemId),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
  runtime.itemById = new Map(runtime.items.map((entry) => [entry.itemId, entry]));
}

async function ensureSettings() {
  const [savedRoleSet, savedDaySeconds, savedNightSeconds] = await Promise.all([
    prisma.appSetting.findUnique({ where: { settingKey: SETTING_KEYS.selectedRoleSetId } }),
    prisma.appSetting.findUnique({ where: { settingKey: SETTING_KEYS.daySeconds } }),
    prisma.appSetting.findUnique({ where: { settingKey: SETTING_KEYS.nightSeconds } }),
  ]);
  const fallbackId = runtime.roleSets[0]?.id ?? null;
  runtime.selectedRoleSetId = savedRoleSet?.settingValue ?? fallbackId;
  runtime.phaseSettings.daySeconds = Number(savedDaySeconds?.settingValue ?? PHASE_DURATIONS.DAY);
  runtime.phaseSettings.nightSeconds = Number(savedNightSeconds?.settingValue ?? PHASE_DURATIONS.NIGHT);
  if (!savedRoleSet && fallbackId) {
    await prisma.appSetting.create({ data: { settingKey: SETTING_KEYS.selectedRoleSetId, settingValue: fallbackId } });
  }
  if (!savedDaySeconds) {
    await prisma.appSetting.create({ data: { settingKey: SETTING_KEYS.daySeconds, settingValue: String(PHASE_DURATIONS.DAY) } });
  }
  if (!savedNightSeconds) {
    await prisma.appSetting.create({ data: { settingKey: SETTING_KEYS.nightSeconds, settingValue: String(PHASE_DURATIONS.NIGHT) } });
  }
}

async function ensureIdentity(ipAddress: string): Promise<string> {
  const displayName = `プレイヤー${runtime.participants.size + 1}`;
  const identity = await prisma.playerIdentity.upsert({
    where: { ipAddress },
    create: { ipAddress, displayName, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });
  return identity.displayName;
}

function getSelectedRoleSet(): RoleSetDefinition | null {
  if (!runtime.selectedRoleSetId) {
    return null;
  }
  return runtime.roleSetById.get(runtime.selectedRoleSetId) ?? null;
}

function getLobbySnapshot(viewerIpAddress: string | null = null): LobbySnapshot {
  const selectedRoleSet = getSelectedRoleSet();
  const connectedCount = Array.from(runtime.participants.values()).filter((entry) => entry.isConnected).length;
  let cannotStartReason: string | null = null;
  let canStart = false;

  if (runtime.game && runtime.game.status !== 'FINISHED') {
    cannotStartReason = 'ゲーム進行中です';
  } else if (!selectedRoleSet) {
    cannotStartReason = '配役が選択されていません';
  } else if (connectedCount < 4 || connectedCount > 16) {
    cannotStartReason = '参加人数は4人から16人です';
  } else if (selectedRoleSet.requiredPlayerCount !== connectedCount) {
    cannotStartReason = `配役の要求人数は${selectedRoleSet.requiredPlayerCount}人です`;
  } else {
    canStart = true;
  }

  return {
    selectedRoleSetId: runtime.selectedRoleSetId,
    selectedRoleSet,
    participants: Array.from(runtime.participants.values())
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt))
      .map(({ connectionId, displayName, isConnected, joinedAt, ipAddress }) => ({
        connectionId,
        displayName,
        isConnected,
        isSelf: viewerIpAddress !== null && viewerIpAddress === ipAddress,
        joinedAt,
      })),
    roleSets: runtime.roleSets,
    canStart,
    cannotStartReason,
  };
}

function broadcast(event: string, payload: unknown) {
  const message = JSON.stringify({ event, payload });
  for (const participant of runtime.participants.values()) {
    if (participant.socket && participant.socket.readyState === participant.socket.OPEN) {
      participant.socket.send(message);
    }
  }
}

async function logAction(category: string, payload: unknown, gameId?: string) {
  await prisma.actionLog.create({
    data: {
      actionLogId: randomUUID(),
      gameId,
      category,
      payloadJson: JSON.stringify(payload),
    },
  });
}

function pushGameLog(
  game: RuntimeGame,
  message: string,
  options?: { visibility?: 'PUBLIC' | 'PRIVATE'; ownerPlayerId?: string | null },
) {
  const visibility = options?.visibility ?? 'PUBLIC';
  game.eventLogs.unshift({
    id: randomUUID(),
    message,
    createdAt: new Date().toISOString(),
    isPrivate: visibility === 'PRIVATE',
    visibility,
    ownerPlayerId: options?.ownerPlayerId ?? null,
  });
  game.eventLogs = game.eventLogs.slice(0, 100);
}

function pushAbilityExecutionLog(game: RuntimeGame, actor: RuntimePlayer, queued: RuntimeQueuedAbility, ability: AbilityDefinition) {
  if (!isManualAbility(ability)) {
    return;
  }
  const targetNames = queued.targetIds
    .map((targetId) => game.players.find((entry) => entry.id === targetId)?.displayName)
    .filter((name): name is string => Boolean(name));

  if (targetNames.length > 0) {
    pushGameLog(game, `${actor.displayName}が${ability.displayName}を使用しました。対象：${targetNames.join('、')}`);
    return;
  }

  pushGameLog(game, `${actor.displayName}が${ability.displayName}を使用しました。`);
}

function shouldRevealRoleOnDeath(roleId: string) {
  return roleId === 'detective' || roleId === 'hyena' || roleId === 'wealthy';
}

function shouldHideDeathCauseUntilGameEnd(cause: DeathCause | null) {
  return cause === 'LINE_OF_DUTY' || cause === 'EXORCISM';
}

function getPublicRoleRevealMessage(player: RuntimePlayer) {
  const roleName = runtime.roleById.get(player.roleId)?.displayName ?? player.roleId;
  return `${player.displayName}は${roleName}でした。`;
}

async function createCustomRoleSet(input: {
  displayName: string;
  requiredPlayerCount: number;
  monsterWinRequiredKills: number;
  roles: RoleSetDefinition['roles'];
}) {
  const existingIds = runtime.roleSets
    .map((entry) => /^role-set-custom-(\d+)$/.exec(entry.id))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]));
  const nextId = `role-set-custom-${String((existingIds.length > 0 ? Math.max(...existingIds) : 0) + 1).padStart(3, '0')}`;
  const roleSet: RoleSetDefinition = {
    id: nextId,
    displayName: input.displayName,
    requiredPlayerCount: input.requiredPlayerCount,
    monsterWinRequiredKills: input.monsterWinRequiredKills,
    roles: input.roles,
    version: '1.0.0',
    enabled: true,
  };
  const filePath = dataPath('role-sets', `${nextId}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(roleSet, null, 2)}\n`, 'utf8');
  await loadRoleSets();
  await persistSelectedRoleSet(nextId);
  return roleSet;
}

function getInHandCards(game: RuntimeGame, playerId: string) {
  return game.deckCards
    .filter((card) => card.ownerPlayerId === playerId && card.zone === 'IN_HAND')
    .sort((left, right) => left.drawOrder - right.drawOrder);
}

function toAssignedItemCard(card: RuntimeDeckCard): AssignedItemCard {
  return {
    cardId: card.cardId,
    itemId: card.itemId,
    displayName: card.displayName,
    zone: card.zone,
    ownerPlayerId: card.ownerPlayerId,
    isActivating: card.isActivating,
    reservedAbilityId: card.reservedAbilityId ?? null,
  };
}

function refreshPendingItemOverflow(game: RuntimeGame, player: RuntimePlayer) {
  const cards = getInHandCards(game, player.id);
  const overflowCount = Math.max(0, cards.length - runtime.config.itemHandLimit);
  if (overflowCount < 1) {
    game.pendingItemOverflowByPlayerId.delete(player.id);
    return;
  }
  game.pendingItemOverflowByPlayerId.set(player.id, {
    ownerPlayerId: player.id,
    overflowCount,
    cards: cards.map(toAssignedItemCard),
  });
}

function applyFinalResults(game: RuntimeGame, winningCamp: 'HUMAN' | 'MONSTER' | 'EVIL_GOD') {
  for (const player of game.players) {
    revealPlayerRole(player);
    const faction = getRoleFaction(player.roleId);
    let resultStatus: GameResultStatus = 'LOSE';
    if (winningCamp === 'HUMAN') {
      resultStatus = faction === 'HUMAN' ? 'WIN' : 'LOSE';
    } else if (winningCamp === 'EVIL_GOD') {
      resultStatus = player.roleId === 'evil-god' ? 'WIN' : 'LOSE';
    } else if (player.roleId === 'hyena') {
      resultStatus = player.status === 'ALIVE' ? 'WIN' : 'LOSE';
    } else {
      resultStatus = faction === 'MONSTER' ? 'WIN' : 'LOSE';
    }
    player.resultStatus = resultStatus;
  }
}

function revealPlayerRole(player: RuntimePlayer) {
  if (player.publicRoleId === player.roleId) {
    return false;
  }
  player.publicRoleId = player.roleId;
  return true;
}

async function persistSelectedRoleSet(roleSetId: string) {
  runtime.selectedRoleSetId = roleSetId;
  await prisma.appSetting.upsert({
    where: { settingKey: SETTING_KEYS.selectedRoleSetId },
    create: { settingKey: SETTING_KEYS.selectedRoleSetId, settingValue: roleSetId },
    update: { settingValue: roleSetId },
  });
}

async function persistPhaseSettings(settings: PhaseSettings) {
  runtime.phaseSettings = settings;
  await prisma.appSetting.upsert({
    where: { settingKey: SETTING_KEYS.daySeconds },
    create: { settingKey: SETTING_KEYS.daySeconds, settingValue: String(settings.daySeconds) },
    update: { settingValue: String(settings.daySeconds) },
  });
  await prisma.appSetting.upsert({
    where: { settingKey: SETTING_KEYS.nightSeconds },
    create: { settingKey: SETTING_KEYS.nightSeconds, settingValue: String(settings.nightSeconds) },
    update: { settingValue: String(settings.nightSeconds) },
  });
}

function buildDeckCards(players: RuntimePlayer[]): RuntimeDeckCard[] {
  const cards: RuntimeDeckCard[] = [];
  let drawOrder = 0;
  for (const item of runtime.items) {
    for (let serial = 1; serial <= item.cardCount; serial += 1) {
      cards.push({
        cardId: randomUUID(),
        itemId: item.itemId,
        displayName: item.displayName,
        zone: 'DRAW_PILE',
        ownerPlayerId: null,
        isActivating: false,
        reservedAbilityId: null,
        drawOrder,
        serialInItem: serial,
      });
      drawOrder += 1;
    }
  }
  const shuffled = shuffle(cards).map((card, index) => ({ ...card, drawOrder: index }));
  let cursor = 0;
  for (const player of players) {
    for (let dealt = 0; dealt < 2; dealt += 1) {
      shuffled[cursor] = {
        ...shuffled[cursor],
        zone: 'IN_HAND',
        ownerPlayerId: player.id,
      };
      cursor += 1;
    }
  }
  return shuffled;
}

function assignRoles(roleSet: RoleSetDefinition, participants: RuntimeParticipant[]): RuntimePlayer[] {
  const orderedParticipants = shuffle(participants);
  const roles = shuffle(roleSet.roles.flatMap((entry) => Array.from({ length: entry.resolvedCount ?? entry.min }, () => entry.roleId)));
  return orderedParticipants.map((participant, index) => {
    const roleId = roles[index];
    const hobbyId = shuffle(runtime.hobbies)[0].hobbyId;
    return {
      id: randomUUID(),
      seatOrder: index + 1,
      ipAddress: participant.ipAddress,
      rawIpAddress: participant.rawIpAddress,
      displayName: participant.displayName,
      publicRoleId: null,
      resultStatus: null,
      roleId,
      roleAbilityIds: [...(runtime.roleById.get(roleId)?.abilityIds ?? [])],
      hobbyId,
      hobbyAbilityIds: [...(runtime.hobbyById.get(hobbyId)?.abilityIds ?? [])],
      status: 'ALIVE',
      stateTags: [],
      deathCause: null,
      isConnected: true,
    };
  });
}

async function saveGame(game: RuntimeGame) {
  await prisma.game.create({
    data: {
      gameId: game.gameId,
      status: game.status,
      selectedRoleSetId: game.roleSet.id,
      dayNumber: game.dayNumber,
      phaseType: game.phase,
      startedAt: new Date(),
      monsterWinRequiredKills: game.roleSet.monsterWinRequiredKills,
      monsterKillCount: game.monsterKillCount,
      monsterKillGoalReachedDay: game.monsterKillGoalReachedDay,
    },
  });

  await prisma.gamePlayer.createMany({
    data: game.players.map((player) => ({
      gamePlayerId: player.id,
      gameId: game.gameId,
      seatOrder: player.seatOrder,
      ipAddress: player.ipAddress,
      displayName: player.displayName,
      roleId: player.roleId,
      hobbyId: player.hobbyId,
      status: player.status,
      isConnected: player.isConnected,
      deathCause: player.deathCause,
    })),
  });

  const deckId = randomUUID();
  await prisma.gameItemDeck.create({
    data: {
      gameItemDeckId: deckId,
      gameId: game.gameId,
      drawCount: game.deckCards.filter((card) => card.zone === 'DRAW_PILE').length,
      discardCount: 0,
    },
  });

  await prisma.gameItemDeckCard.createMany({
    data: game.deckCards.map((card) => ({
      gameItemDeckCardId: card.cardId,
      gameItemDeckId: deckId,
      itemId: card.itemId,
      serialInItem: card.serialInItem,
      zone: card.zone,
      drawOrder: card.drawOrder,
      ownerGamePlayerId: card.ownerPlayerId,
    })),
  });
}

function buildAbilityKey(sourceType: AbilitySourceType, sourceId: string, abilityId: string, itemCardId: string | null = null) {
  return [sourceType, sourceId, abilityId, itemCardId ?? ''].join('::');
}

function getOrderedPlayers(game: RuntimeGame) {
  return [...game.players].sort((left, right) => left.seatOrder - right.seatOrder);
}

function getNextAlivePlayer(game: RuntimeGame, actorId: string) {
  const orderedPlayers = getOrderedPlayers(game);
  const actorIndex = orderedPlayers.findIndex((player) => player.id === actorId);
  if (actorIndex < 0) {
    return null;
  }
  for (let offset = 1; offset < orderedPlayers.length; offset += 1) {
    const candidate = orderedPlayers[(actorIndex + offset) % orderedPlayers.length];
    if (candidate.status === 'ALIVE') {
      return candidate;
    }
  }
  return null;
}

function areItemActionsUnlocked(game: RuntimeGame) {
  if (game.itemsDisabledUntilNightEndDay !== null && game.itemsDisabledUntilNightEndDay >= game.dayNumber) {
    return false;
  }
  return game.dayNumber > 1 || (game.dayNumber === 1 && (game.phase === 'DAY' || game.phase === 'VOTE' || game.phase === 'NIGHT'));
}

function hasAliveDetective(game: RuntimeGame) {
  return game.players.some((player) => player.roleId === 'detective' && player.status === 'ALIVE');
}

function hasAliveEvilGod(game: RuntimeGame) {
  return game.players.some((player) => player.roleId === 'evil-god' && player.status === 'ALIVE');
}

function hasDeadPlayer(game: RuntimeGame) {
  return game.players.some((player) => player.status === 'DEAD');
}

function getPlayerHobbyType(game: RuntimeGame, player: RuntimePlayer): HobbyType {
  return game.hobbyTypeOverrideByPlayerId.get(player.id) ?? runtime.hobbyById.get(player.hobbyId)?.hobbyType ?? 'SPECIAL';
}

function hasPlayerState(player: RuntimePlayer, state: RuntimePlayerStateTag) {
  return player.stateTags.includes(state);
}

function addPlayerState(player: RuntimePlayer, state: RuntimePlayerStateTag) {
  if (player.stateTags.includes(state)) {
    return;
  }
  player.stateTags = [...player.stateTags, state];
}

function removePlayerState(player: RuntimePlayer, state: RuntimePlayerStateTag) {
  player.stateTags = player.stateTags.filter((entry) => entry !== state);
}

function canActWhileDead(player: RuntimePlayer) {
  return hasPlayerState(player, 'ZOMBIE');
}

function canVoteWhileDead(player: RuntimePlayer) {
  return hasPlayerState(player, 'ZOMBIE') || hasPlayerState(player, 'VOTABLE');
}

function canPerformActions(player: RuntimePlayer) {
  return player.status === 'ALIVE' || canActWhileDead(player);
}

function canVote(player: RuntimePlayer) {
  return player.status === 'ALIVE' || canVoteWhileDead(player);
}

function isTrialDay(game: RuntimeGame) {
  return game.phase === 'DAY' && game.lastNightDeaths > 0;
}

function canUseAbilityNow(game: RuntimeGame, actor: RuntimePlayer, sourceType: AbilitySourceType, ability: AbilityDefinition) {
  if (!isManualAbility(ability)) {
    return false;
  }
  if (ability.implementationKey === 'detective-kiseru-investigate') {
    return !hasAliveDetective(game);
  }
  if (ability.implementationKey === 'grave-robber-shovel-reveal-role') {
    return hasDeadPlayer(game);
  }
  if (ability.implementationKey === 'grave-guide-steal-random-from-dead') {
    return hasDeadPlayer(game);
  }
  if (ability.implementationKey === 'twisted-hourglass-extend-day' || ability.implementationKey === 'warped-silver-watch-shorten-day') {
    return isTrialDay(game);
  }
  if (ability.implementationKey === 'protein-bar-gain-two-if-single-item') {
    return getInHandCards(game, actor.id).length === 1;
  }
  if (ability.implementationKey === 'chocolate-grant-skill-and-spell') {
    const alive = game.players.filter((player) => player.status === 'ALIVE');
    const skillOrSpecial = alive.filter((player) => {
      const type = getPlayerHobbyType(game, player);
      return type === 'SKILL' || type === 'SPECIAL';
    });
    const spellOrSpecial = alive.filter((player) => {
      const type = getPlayerHobbyType(game, player);
      return type === 'SPELL' || type === 'SPECIAL';
    });
    return skillOrSpecial.some((first) => spellOrSpecial.some((second) => second.id !== first.id));
  }
  if (sourceType === 'ITEM') {
    return areItemActionsUnlocked(game);
  }
  return true;
}

function clearVotePhaseEffects(game: RuntimeGame) {
  game.bonusVoteCountByPlayerId.clear();
  game.blockedVoteByPlayerId.clear();
  game.untargetableVoteTargetPlayerIds.clear();
}

async function restoreCanceledQueuedAbilities(game: RuntimeGame, entries: RuntimeQueuedAbility[]) {
  for (const queued of entries) {
    if (queued.sourceType !== 'ITEM' || !queued.itemCardId) {
      continue;
    }
    const card = game.deckCards.find((entry) => entry.cardId === queued.itemCardId);
    if (!card || card.zone !== 'IN_HAND') {
      continue;
    }
    card.isActivating = false;
    card.reservedAbilityId = null;
    await persistDeckCard(game, card);
    if (card.ownerPlayerId) {
      syncReservedItemState(game, card.ownerPlayerId);
    }
  }
}

function setCurrentPhaseTimer(game: RuntimeGame, durationMs: number) {
  game.currentTimerEndsAt = new Date(Date.now() + durationMs).toISOString();
  schedulePhaseTimeout(game, durationMs);
}

function getAbilityTargetOptions(game: RuntimeGame, actor: RuntimePlayer, ability: AbilityDefinition): AbilityTargetOption[] {
  if (ability.targetCount < 1) {
    return [];
  }

  if (ability.implementationKey === 'amulet-protect') {
    return game.players
      .filter((player) => player.status === 'ALIVE' && player.id !== actor.id)
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'magic-book-protect') {
    return game.players
      .filter((player) => player.status === 'ALIVE' && player.id !== actor.id)
      .filter((player) => getPlayerHobbyType(game, player) === 'SPELL')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'grave-robber-shovel-reveal-role') {
    return game.players
      .filter((player) => player.status === 'DEAD')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'damp-tiara-block-vote') {
    return game.players
      .filter((player) => player.status === 'ALIVE' && player.id !== actor.id)
      .filter((player) => getPlayerHobbyType(game, player) === 'SPELL')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'string-of-control-force-discard') {
    return game.players
      .filter((player) => player.status === 'ALIVE')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'grave-guide-steal-random-from-dead') {
    return game.players
      .filter((player) => player.status === 'DEAD')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'chocolate-grant-skill-and-spell') {
    return game.players
      .filter((player) => player.status === 'ALIVE')
      .filter((player) => {
        const type = getPlayerHobbyType(game, player);
        if (!(type === 'SKILL' || type === 'SPECIAL')) {
          return false;
        }
        return game.players.some((candidate) => {
          if (candidate.status !== 'ALIVE' || candidate.id === player.id) {
            return false;
          }
          const candidateType = getPlayerHobbyType(game, candidate);
          return candidateType === 'SPELL' || candidateType === 'SPECIAL';
        });
      })
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'tarot-deck-silence-and-grant-item') {
    return game.players
      .filter((player) => player.status === 'ALIVE')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'dissolution-fluid-discard-all-items' || ability.implementationKey === 'prophecy-diary-steal-by-item') {
    return game.players
      .filter((player) => player.status === 'ALIVE' && player.id !== actor.id)
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'detective-investigate') {
    return game.players
      .filter((player) => player.status === 'ALIVE')
      .filter((player) => game.investigateBlockedNightByPlayerId.get(player.id) !== game.dayNumber)
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (ability.implementationKey === 'detective-kiseru-investigate') {
    return [];
  }

  if (ability.implementationKey === 'special-detective-kiseru-investigate') {
    return game.players
      .filter((player) => player.status === 'ALIVE')
      .filter((player) => game.investigateBlockedNightByPlayerId.get(player.id) !== game.dayNumber)
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  if (
    ability.implementationKey === 'special-fumie-detect-cultist'
    || ability.implementationKey === 'special-suspicious-jewel-detect-evil-god'
    || ability.implementationKey === 'special-mirror-of-truth-detect-villager'
    || ability.implementationKey === 'hazy-cloak-untargetable-vote'
  ) {
    return game.players
      .filter((player) => player.status === 'ALIVE')
      .map((player) => ({ id: player.id, displayName: player.displayName }));
  }

  return game.players
    .filter((player) => player.status === 'ALIVE')
    .map((player) => ({ id: player.id, displayName: player.displayName }));
}

function isActivationTimingValue(timing: AbilityTiming) {
  return ACTIVATION_TIMINGS.has(timing);
}

function isTriggerTimingValue(timing: AbilityTiming) {
  return TRIGGER_TIMINGS.has(timing);
}

function isManualAbility(ability: AbilityDefinition) {
  if (ability.abilityType === 'ACTIVE') {
    return ability.timing !== 'NONE' && isActivationTimingValue(ability.timing);
  }
  if (ability.abilityType !== 'PROFESSION') {
    return false;
  }
  return ability.timing !== 'NONE'
    && isActivationTimingValue(ability.timing)
    && ability.timing !== 'NIGHT';
}

function getAbilityTriggerTiming(ability: AbilityDefinition | undefined): AbilityTriggerTiming | null {
  if (!ability || ability.timing === 'NONE') {
    return null;
  }
  if (ability.abilityType === 'TRIGGERED') {
    return isTriggerTimingValue(ability.timing) ? ability.timing as AbilityTriggerTiming : null;
  }
  if (ability.abilityType === 'PROFESSION' && !isManualAbility(ability)) {
    return isTriggerTimingValue(ability.timing) ? ability.timing as AbilityTriggerTiming : null;
  }
  return null;
}

function doesAbilityActivateAtPhaseStart(ability: AbilityDefinition, phase: Exclude<PhaseType, 'LOBBY' | 'RESULT'>) {
  if (!isManualAbility(ability)) {
    return false;
  }
  if (ability.timing === 'ANY') {
    return true;
  }
  if (ability.timing === 'DAY') {
    return phase === 'DAY' || phase === 'VOTE';
  }
  if (ability.timing === 'NIGHT') {
    return phase === 'NIGHT';
  }
  if (ability.timing === 'MORNING_START') {
    return phase === 'MORNING';
  }
  if (ability.timing === 'DAY_START') {
    return phase === 'DAY';
  }
  if (ability.timing === 'VOTE_START') {
    return phase === 'VOTE';
  }
  return ability.timing === 'NIGHT_START' && phase === 'NIGHT';
}

function getReservedAbilities(game: RuntimeGame, playerId: string) {
  return game.reservedAbilitiesByPlayerId.get(playerId) ?? [];
}

function setReservedAbilities(game: RuntimeGame, playerId: string, entries: RuntimeReservedAbility[]) {
  if (entries.length < 1) {
    game.reservedAbilitiesByPlayerId.delete(playerId);
    return;
  }
  game.reservedAbilitiesByPlayerId.set(playerId, entries);
}

function removeReservedAbility(game: RuntimeGame, playerId: string, abilityKey: string) {
  setReservedAbilities(game, playerId, getReservedAbilities(game, playerId).filter((entry) => entry.abilityKey !== abilityKey));
}

function syncReservedItemState(game: RuntimeGame, playerId: string) {
  const reservedByCardId = new Map(
    getReservedAbilities(game, playerId)
      .filter((entry) => entry.sourceType === 'ITEM' && entry.itemCardId)
      .map((entry) => [entry.itemCardId as string, entry.abilityId]),
  );
  for (const card of game.deckCards.filter((entry) => entry.ownerPlayerId === playerId && entry.zone === 'IN_HAND')) {
    card.reservedAbilityId = reservedByCardId.get(card.cardId) ?? null;
  }
}

function clearPlayerReservations(game: RuntimeGame, playerId: string) {
  game.reservedAbilitiesByPlayerId.delete(playerId);
  game.pendingReservedAbilitiesByPlayerId.delete(playerId);
  syncReservedItemState(game, playerId);
}

function clearGrantedTriggeredAbilities(game: RuntimeGame, playerId: string) {
  game.grantedTriggeredAbilitiesByPlayerId.delete(playerId);
}

function getGrantedTriggeredAbilities(game: RuntimeGame, playerId: string) {
  return game.grantedTriggeredAbilitiesByPlayerId.get(playerId) ?? [];
}

function setGrantedTriggeredAbilities(game: RuntimeGame, playerId: string, entries: RuntimeGrantedTriggeredAbility[]) {
  if (entries.length < 1) {
    game.grantedTriggeredAbilitiesByPlayerId.delete(playerId);
    return;
  }
  game.grantedTriggeredAbilitiesByPlayerId.set(playerId, entries);
}

function clearProtectedStateIfGrantMissing(game: RuntimeGame, player: RuntimePlayer) {
  const hasGrant = getGrantedTriggeredAbilities(game, player.id).some((entry) => entry.abilityId === PROTECTED_SPECIAL_ABILITY_ID);
  if (!hasGrant) {
    removePlayerState(player, 'PROTECTED');
  }
}

function grantTriggeredAbility(game: RuntimeGame, playerId: string, sourceItemId: string, abilityId: string) {
  setGrantedTriggeredAbilities(game, playerId, [
    ...getGrantedTriggeredAbilities(game, playerId),
    {
      grantId: randomUUID(),
      sourceItemId,
      abilityId,
    },
  ]);
}

function consumeGrantedTriggeredAbility(game: RuntimeGame, playerId: string, grantId: string | null) {
  if (!grantId) {
    return null;
  }
  const granted = getGrantedTriggeredAbilities(game, playerId).find((entry) => entry.grantId === grantId) ?? null;
  if (!granted) {
    return null;
  }
  setGrantedTriggeredAbilities(
    game,
    playerId,
    getGrantedTriggeredAbilities(game, playerId).filter((entry) => entry.grantId !== grantId),
  );
  return granted;
}

function isSpecialGrantingAbility(ability: AbilityDefinition) {
  return SPECIAL_GRANTING_IMPLEMENTATION_KEYS.has(ability.implementationKey);
}

function requiresPromptTargetSelection(ability: AbilityDefinition) {
  return ability.targetCount > 0 && !isSpecialGrantingAbility(ability);
}

function getGrantedSpecialAbilityId(ability: AbilityDefinition) {
  return GRANTED_SPECIAL_ABILITY_IDS_BY_IMPLEMENTATION_KEY.get(ability.implementationKey) ?? null;
}

function isGrantedTriggeredPrompt(game: RuntimeGame, actor: RuntimePlayer, prompt: RuntimeAbilityPrompt) {
  return getGrantedTriggeredAbilities(game, actor.id).some((entry) => entry.grantId === prompt.itemCardId);
}

function getPendingTriggeredAbilities(game: RuntimeGame, playerId: string) {
  return game.pendingTriggeredAbilitiesByPlayerId.get(playerId) ?? [];
}

function appendPendingTriggeredAbilities(game: RuntimeGame, playerId: string, sources: TriggeredAbilitySource[]) {
  if (sources.length < 1) {
    return;
  }
  game.pendingTriggeredAbilitiesByPlayerId.set(playerId, [
    ...getPendingTriggeredAbilities(game, playerId),
    ...sources,
  ]);
}

function setPendingTriggeredAbilities(game: RuntimeGame, playerId: string, sources: TriggeredAbilitySource[]) {
  if (sources.length < 1) {
    game.pendingTriggeredAbilitiesByPlayerId.delete(playerId);
    return;
  }
  game.pendingTriggeredAbilitiesByPlayerId.set(playerId, sources);
}

function isTriggeredSourceStillAvailable(game: RuntimeGame, actor: RuntimePlayer, source: TriggeredAbilitySource) {
  if (getGrantedTriggeredAbilities(game, actor.id).some((entry) => entry.grantId === source.itemCardId && entry.abilityId === source.ability.abilityId)) {
    return true;
  }
  if (source.sourceType === 'ROLE') {
    return actor.roleAbilityIds.includes(source.ability.abilityId);
  }
  if (source.sourceType === 'HOBBY') {
    return actor.hobbyAbilityIds.includes(source.ability.abilityId);
  }
  const card = game.deckCards.find((entry) => entry.cardId === source.itemCardId && entry.ownerPlayerId === actor.id && entry.zone === 'IN_HAND');
  const item = card ? runtime.itemById.get(card.itemId) : null;
  return Boolean(card && item?.abilityIds.includes(source.ability.abilityId));
}

function getAvailableAbilityKeys(game: RuntimeGame, actor: RuntimePlayer): string[] {
  const keys: string[] = [];
  const pendingPrompt = game.pendingAbilityPromptByPlayerId.get(actor.id);
  if (pendingPrompt) {
    keys.push(pendingPrompt.abilityKey);
  }
  if (game.pendingItemOverflowByPlayerId.has(actor.id)) {
    return keys;
  }
  if (game.isPaused || !canPerformActions(actor)) {
    return keys;
  }

  for (const abilityId of actor.roleAbilityIds) {
    const ability = runtime.abilityById.get(abilityId);
    if (ability && canUseAbilityNow(game, actor, 'ROLE', ability)) {
      keys.push(buildAbilityKey('ROLE', actor.roleId, abilityId));
    }
  }
  for (const abilityId of actor.hobbyAbilityIds) {
    const ability = runtime.abilityById.get(abilityId);
    if (ability && canUseAbilityNow(game, actor, 'HOBBY', ability)) {
      keys.push(buildAbilityKey('HOBBY', actor.hobbyId, abilityId));
    }
  }
  for (const card of game.deckCards.filter((entry) => entry.ownerPlayerId === actor.id && entry.zone === 'IN_HAND' && !entry.isActivating)) {
    const item = runtime.itemById.get(card.itemId);
    const abilityId = item?.abilityIds.find((entry) => {
      const ability = runtime.abilityById.get(entry);
      return ability ? canUseAbilityNow(game, actor, 'ITEM', ability) : false;
    });
    if (abilityId) {
      keys.push(buildAbilityKey('ITEM', card.itemId, abilityId, card.cardId));
    }
  }
  return keys;
}

function buildGameSnapshot(ipAddress: string): GameSnapshot | null {
  const game = runtime.game;
  if (!game) {
    return null;
  }
  const me = game.players.find((player) => player.ipAddress === ipAddress) ?? null;
  const myCards = me
    ? getInHandCards(game, me.id)
    : [];
  const pendingPrompt = me ? game.pendingAbilityPromptByPlayerId.get(me.id) ?? null : null;
  const pendingItemOverflow = me ? game.pendingItemOverflowByPlayerId.get(me.id) ?? null : null;
  const knownMonsterPlayerId = me?.roleId === 'cultist' && game.status !== 'FINISHED' ? getMonster(game)?.id ?? null : null;
  const myVoteTargetId = me ? game.votes.get(me.id) ?? null : null;
  return {
    gameId: game.gameId,
    status: game.status,
    phase: game.phase,
    isPaused: game.isPaused,
    phaseSettings: getPhaseSettings(),
    dayNumber: Math.max(game.dayNumber, 1),
    players: game.players.map((player) => ({
      id: player.id,
      seatOrder: player.seatOrder,
      displayName: player.displayName,
      publicRoleId: player.publicRoleId ?? (game.status === 'FINISHED' ? player.roleId : null),
      publicHobbyId: player.hobbyId,
      itemCount: getInHandCards(game, player.id).length,
      resultStatus: player.resultStatus,
      roleId: me?.id === player.id ? player.roleId : undefined,
      hobbyId: me?.id === player.id ? player.hobbyId : undefined,
      itemCards: me?.id === player.id ? myCards : undefined,
      status: player.status,
      stateTags: player.stateTags,
      deathCause: player.deathCause,
      isConnected: player.isConnected,
    })),
    roleSetId: game.roleSet.id,
    roleSetName: game.roleSet.displayName,
    resolvedRoleSet: game.roleSet,
    drawPileCount: game.deckCards.filter((card) => card.zone === 'DRAW_PILE').length,
    discardPileCount: game.deckCards.filter((card) => card.zone === 'DISCARDED').length,
    currentTimerEndsAt: game.currentTimerEndsAt,
    itemActionsUnlocked: areItemActionsUnlocked(game),
    canUseNightAction: false,
    nightTargets: [],
    myRoleId: me?.roleId ?? null,
    myRoleAbilityIds: me?.roleAbilityIds ?? [],
    myHobbyId: me?.hobbyId ?? null,
    myHobbyAbilityIds: me?.hobbyAbilityIds ?? [],
    availableAbilityKeys: me ? getAvailableAbilityKeys(game, me) : [],
    reservedAbilityKeys: me ? getReservedAbilities(game, me.id).map((entry) => entry.abilityKey) : [],
    myVoteTargetId,
    pendingAbilityPrompt: pendingPrompt,
    pendingItemOverflow,
    knownMonsterPlayerId,
    myItemCards: myCards,
    logs: game.eventLogs
      .filter((entry) => entry.visibility === 'PUBLIC' || entry.ownerPlayerId === me?.id)
      .slice(0, 20)
      .map((entry) => ({
        id: entry.id,
        message: entry.message,
        createdAt: entry.createdAt,
        isPrivate: entry.visibility === 'PRIVATE',
      })),
  };
}

async function broadcastLobby() {
  for (const participant of runtime.participants.values()) {
    if (participant.socket && participant.socket.readyState === participant.socket.OPEN) {
      participant.socket.send(JSON.stringify({ event: 'lobby.updated', payload: getLobbySnapshot(participant.ipAddress) }));
    }
  }
}

async function broadcastGame() {
  if (!runtime.game) {
    return;
  }
  for (const participant of runtime.participants.values()) {
    if (participant.socket && participant.socket.readyState === participant.socket.OPEN) {
      participant.socket.send(JSON.stringify({ event: 'game.snapshot', payload: buildGameSnapshot(participant.ipAddress) }));
    }
  }
}

async function syncGamePersistence() {
  const game = runtime.game;
  if (!game) {
    return;
  }
  await prisma.game.update({
    where: { gameId: game.gameId },
    data: {
      status: game.status,
      dayNumber: game.dayNumber,
      phaseType: game.phase,
      monsterKillCount: game.monsterKillCount,
      monsterKillGoalReachedDay: game.monsterKillGoalReachedDay,
      finishedAt: game.status === 'FINISHED' ? new Date() : null,
    },
  });
  for (const player of game.players) {
    await prisma.gamePlayer.update({
      where: { gamePlayerId: player.id },
      data: {
        displayName: player.displayName,
        status: player.status,
        isConnected: player.isConnected,
        deathCause: player.deathCause,
      },
    });
  }
}

function clearPhaseTimeout() {
  if (runtime.game?.phaseTimeout) {
    clearTimeout(runtime.game.phaseTimeout);
    runtime.game.phaseTimeout = undefined;
  }
}

async function handlePhaseTimeout(gameId: string, phase: Exclude<PhaseType, 'LOBBY' | 'RESULT'>) {
  if (!runtime.game || runtime.game.gameId !== gameId || runtime.game.status !== 'IN_PROGRESS' || runtime.game.isPaused) {
    return;
  }
  if (!(await canAdvancePhase(runtime.game))) {
    runtime.game.currentTimerEndsAt = new Date(Date.now() + 1000).toISOString();
    schedulePhaseTimeout(runtime.game, 1000);
    await broadcastGame();
    return;
  }
  if (phase === 'MORNING') {
    await resolveMorningEnd();
    return;
  }
  if (phase === 'DAY') {
    if (runtime.game.lastNightDeaths > 0) {
      await enterPhase('VOTE');
    } else {
      await enterPhase('NIGHT', { triggerTiming: 'NIGHT' });
    }
    return;
  }
  if (phase === 'VOTE') {
    await resolveVotes();
    return;
  }
  if (phase === 'NIGHT') {
    await resolveNightEnd();
  }
}

function schedulePhaseTimeout(game: RuntimeGame, durationMs: number) {
  clearPhaseTimeout();
  game.phaseTimeout = setTimeout(() => {
    void handlePhaseTimeout(game.gameId, game.phase as Exclude<PhaseType, 'LOBBY' | 'RESULT'>);
  }, durationMs);
}

async function finishGame(reason: string) {
  if (!runtime.game) {
    return;
  }
  const game = runtime.game;
  const winningCamp = reason === '人間陣営の勝利'
    ? 'HUMAN'
    : reason === '邪神陣営の勝利'
      ? 'EVIL_GOD'
      : 'MONSTER';
  applyFinalResults(game, winningCamp);
  pushGameLog(game, `ゲームが終了しました。${reason}です。`);
  game.status = 'FINISHED';
  game.phase = 'RESULT';
  game.isPaused = false;
  game.currentTimerEndsAt = null;
  game.pausedRemainingMs = null;
  clearPhaseTimeout();
  await syncGamePersistence();
  await logAction('game.finished', { reason }, game.gameId);
  broadcast('game.finished', { reason });
  await broadcastGame();
}

async function endGameToLobby(reason: string) {
  const game = runtime.game;
  if (!game) {
    return;
  }
  game.status = 'FINISHED';
  game.phase = 'RESULT';
  game.isPaused = false;
  game.currentTimerEndsAt = null;
  game.pausedRemainingMs = null;
  clearPhaseTimeout();
  await syncGamePersistence();
  await logAction('game.endedToLobby', { reason }, game.gameId);
  broadcast('game.finished', { reason });
  runtime.game = null;
  for (const [connectionId, participant] of Array.from(runtime.participants.entries())) {
    if (!participant.isConnected) {
      runtime.participants.delete(connectionId);
    }
  }
  broadcast('game.cleared', { reason });
  await broadcastLobby();
}

function getPhaseDurationMs(phase: Exclude<PhaseType, 'LOBBY' | 'RESULT'>): number {
  const durationSeconds = phase === 'MORNING'
    ? PHASE_DURATIONS.MORNING
    : phase === 'DAY'
      ? runtime.phaseSettings.daySeconds
      : phase === 'VOTE'
        ? PHASE_DURATIONS.VOTE
        : runtime.phaseSettings.nightSeconds;
  return durationSeconds * 1000;
}

async function pauseGame() {
  const game = runtime.game;
  if (!game || game.status !== 'IN_PROGRESS') {
    throw new Error('進行中のゲームがありません。');
  }
  if (game.isPaused) {
    return;
  }
  const defaultDurationMs = getPhaseDurationMs(game.phase as Exclude<PhaseType, 'LOBBY' | 'RESULT'>);
  const remainingMs = game.currentTimerEndsAt
    ? Math.max(1000, new Date(game.currentTimerEndsAt).getTime() - Date.now())
    : defaultDurationMs;
  game.isPaused = true;
  game.pausedRemainingMs = remainingMs;
  game.currentTimerEndsAt = null;
  clearPhaseTimeout();
  await logAction('game.paused', { phase: game.phase, remainingMs }, game.gameId);
  await broadcastGame();
}

async function resumeGame() {
  const game = runtime.game;
  if (!game || game.status !== 'IN_PROGRESS') {
    throw new Error('進行中のゲームがありません。');
  }
  if (!game.isPaused) {
    return;
  }
  const durationMs = game.pausedRemainingMs ?? getPhaseDurationMs(game.phase as Exclude<PhaseType, 'LOBBY' | 'RESULT'>);
  game.isPaused = false;
  game.pausedRemainingMs = null;
  game.currentTimerEndsAt = new Date(Date.now() + durationMs).toISOString();
  schedulePhaseTimeout(game, durationMs);
  await logAction('game.resumed', { phase: game.phase, remainingMs: durationMs }, game.gameId);
  await broadcastGame();
}

function getMonster(game: RuntimeGame) {
  return game.players.find((player) => player.roleId === 'monster') ?? null;
}

function isStealthActive(game: RuntimeGame, player: RuntimePlayer): boolean {
  const hobby = runtime.hobbyById.get(player.hobbyId);
  if (!hobby?.abilityIds.includes('stealth')) {
    return false;
  }
  if (game.dayNumber < 3) {
    return true;
  }
  return game.dayNumber === 3 && game.phase === 'MORNING';
}

function isProtectedFromDying(game: RuntimeGame, player: RuntimePlayer): boolean {
  if (game.morningStartProtectionPlayerIds.has(player.id)) {
    return true;
  }
  const protectedUntilMorningEndDay = game.protectedFromDyingUntilMorningEndByPlayerId.get(player.id);
  if (typeof protectedUntilMorningEndDay !== 'number') {
    return false;
  }
  if (game.dayNumber < protectedUntilMorningEndDay) {
    return true;
  }
  return game.dayNumber === protectedUntilMorningEndDay && game.phase === 'MORNING';
}

function getTriggeredAbilitySources(game: RuntimeGame, player: RuntimePlayer, timing: AbilityTriggerTiming): TriggeredAbilitySource[] {
  const sources: TriggeredAbilitySource[] = [];
  const grotesqueIdolImplementationKey = 'grotesque-idol-disable-items-on-execution-death';
  const itemTriggersLocked = !areItemActionsUnlocked(game);

  const shouldIncludeAbility = (ability: AbilityDefinition) => {
    if (ability.implementationKey === 'crystal-skull-talkable-on-execution-death' && player.deathCause !== 'EXECUTION') {
      return false;
    }
    if (ability.implementationKey === grotesqueIdolImplementationKey && player.deathCause !== 'EXECUTION') {
      return false;
    }
    return true;
  };

  for (const abilityId of player.roleAbilityIds) {
    const ability = runtime.abilityById.get(abilityId);
    if (
      ability
      && getAbilityTriggerTiming(ability) === timing
      && shouldIncludeAbility(ability)
      && !(ability.implementationKey === 'detective-investigate' && game.blockedDetectiveInvestigateNightByPlayerId.get(player.id) === game.dayNumber)
    ) {
      sources.push({ sourceType: 'ROLE', sourceId: player.roleId, ability, itemCardId: null });
    }
  }

  for (const abilityId of player.hobbyAbilityIds) {
    const ability = runtime.abilityById.get(abilityId);
    if (ability && getAbilityTriggerTiming(ability) === timing && shouldIncludeAbility(ability)) {
      sources.push({ sourceType: 'HOBBY', sourceId: player.hobbyId, ability, itemCardId: null });
    }
  }

  const inHandCards = getInHandCards(game, player.id);
  const hasGrotesqueIdolExecutionTrigger = !itemTriggersLocked && timing === 'SELF_DEATH' && player.deathCause === 'EXECUTION' && inHandCards.some((card) => {
    const item = runtime.itemById.get(card.itemId);
    return item?.abilityIds.some((abilityId) => runtime.abilityById.get(abilityId)?.implementationKey === grotesqueIdolImplementationKey) ?? false;
  });

  if (!itemTriggersLocked) {
    for (const card of inHandCards) {
      const item = runtime.itemById.get(card.itemId);
      if (!item) {
        continue;
      }
      for (const abilityId of item.abilityIds) {
        const ability = runtime.abilityById.get(abilityId);
        if (!ability || getAbilityTriggerTiming(ability) !== timing || !shouldIncludeAbility(ability)) {
          continue;
        }
        if (hasGrotesqueIdolExecutionTrigger && ability.implementationKey !== grotesqueIdolImplementationKey) {
          continue;
        }
        sources.push({ sourceType: 'ITEM', sourceId: card.itemId, ability, itemCardId: card.cardId });
      }
    }

    if (!hasGrotesqueIdolExecutionTrigger) {
      for (const granted of getGrantedTriggeredAbilities(game, player.id)) {
        const ability = runtime.abilityById.get(granted.abilityId);
        if (ability && getAbilityTriggerTiming(ability) === timing && shouldIncludeAbility(ability)) {
          sources.push({
            sourceType: 'ITEM',
            sourceId: granted.sourceItemId,
            ability,
            itemCardId: granted.grantId,
          });
        }
      }
    }
  }

  return sources;
}

async function triggerAbilitySources(game: RuntimeGame, actor: RuntimePlayer, sources: TriggeredAbilitySource[]) {
  appendPendingTriggeredAbilities(game, actor.id, sources);
  await continueTriggeredDeclarations(game, actor);
}

async function setPlayerStatus(
  game: RuntimeGame,
  player: RuntimePlayer,
  nextStatus: PlayerStatus,
  context: { cause?: DeathCause; reason: string },
) {
  const previousStatus = player.status;
  if (nextStatus === 'DYING' && (isStealthActive(game, player) || isProtectedFromDying(game, player))) {
    await logAction('player.statusChangeBlocked', {
      playerId: player.id,
      nextStatus,
      reason: context.reason,
      blockedBy: isStealthActive(game, player) ? 'stealth' : 'protection',
    }, game.gameId);
    return false;
  }
  if (player.status === nextStatus && (nextStatus !== 'DEAD' || player.deathCause === context.cause)) {
    return false;
  }
  player.status = nextStatus;
  if (nextStatus !== 'ALIVE') {
    clearPlayerReservations(game, player.id);
    clearGrantedTriggeredAbilities(game, player.id);
    game.pendingProphecyDiaryTargetByPlayerId.delete(player.id);
    game.pendingChocolateFirstTargetByPlayerId.delete(player.id);
    removePlayerState(player, 'PROTECTED');
  }
  if (nextStatus !== 'DEAD') {
    player.deathCause = nextStatus === 'ALIVE' ? null : player.deathCause;
    if (nextStatus === 'DYING') {
      await triggerAbilitySources(game, player, getTriggeredAbilitySources(game, player, 'SELF_DYING'));
    } else if (nextStatus === 'ALIVE' && previousStatus === 'DYING') {
      await triggerAbilitySources(game, player, getTriggeredAbilitySources(game, player, 'SELF_RECOVERED'));
    }
    return true;
  }
  player.deathCause = context.cause ?? player.deathCause;
  return true;
}

async function evaluateVictory() {
  const game = runtime.game;
  if (!game) {
    return false;
  }
  const monster = getMonster(game);
  if (!monster || monster.status === 'DEAD') {
    await finishGame('人間陣営の勝利');
    return true;
  }
  return false;
}

async function evaluateMonsterVictoryAfterVote(game: RuntimeGame) {
  const monster = getMonster(game);
  if (!monster || monster.status === 'DEAD') {
    return false;
  }
  if (game.monsterKillGoalReachedDay === null || game.dayNumber < game.monsterKillGoalReachedDay) {
    return false;
  }
  await finishGame('人外陣営の勝利');
  return true;
}

async function persistDeckCard(game: RuntimeGame, card: RuntimeDeckCard) {
  await prisma.gameItemDeckCard.update({
    where: { gameItemDeckCardId: card.cardId },
    data: {
      zone: card.zone,
      ownerGamePlayerId: card.ownerPlayerId,
      usedAt: card.zone === 'DISCARDED' ? new Date() : null,
    },
  });
  await prisma.gameItemDeck.update({
    where: { gameId: game.gameId },
    data: {
      drawCount: game.deckCards.filter((entry) => entry.zone === 'DRAW_PILE').length,
      discardCount: game.deckCards.filter((entry) => entry.zone === 'DISCARDED').length,
    },
  });
}

function buildAbilityPrompt(
  game: RuntimeGame,
  actor: RuntimePlayer,
  sourceType: AbilitySourceType,
  sourceId: string,
  ability: AbilityDefinition,
  promptType: AbilityPrompt['promptType'],
  itemCardId: string | null = null,
): RuntimeAbilityPrompt {
  const options = getAbilityTargetOptions(game, actor, ability);
  const resolvedTargetCount = Math.min(ability.targetCount, options.length);
  return {
    actorPlayerId: actor.id,
    promptType,
    abilityKey: buildAbilityKey(sourceType, sourceId, ability.abilityId, itemCardId),
    abilityId: ability.abilityId,
    displayName: ability.displayName,
    description: ability.description,
    sourceType,
    sourceId,
    itemCardId,
    canCancel: ability.canCancel,
    minTargets: resolvedTargetCount,
    maxTargets: resolvedTargetCount,
    options,
  };
}

function getItemLabel(itemId: string) {
  return runtime.itemById.get(itemId)?.displayName ?? itemId;
}

function getItemTargetOptions(): AbilityTargetOption[] {
  return runtime.items.map((item) => ({ id: item.itemId, displayName: item.displayName }));
}

function buildProphecyDiaryItemPrompt(
  game: RuntimeGame,
  actor: RuntimePlayer,
  sourceType: AbilitySourceType,
  sourceId: string,
  ability: AbilityDefinition,
  itemCardId: string | null,
  targetPlayerId: string,
): RuntimeAbilityPrompt {
  const target = game.players.find((entry) => entry.id === targetPlayerId);
  return {
    actorPlayerId: actor.id,
    promptType: 'TARGET',
    abilityKey: buildAbilityKey(sourceType, sourceId, ability.abilityId, itemCardId),
    abilityId: ability.abilityId,
    displayName: ability.displayName,
    description: `${target?.displayName ?? '対象'}が所持しているか確認するアイテムを選択してください。`,
    sourceType,
    sourceId,
    itemCardId,
    canCancel: ability.canCancel,
    minTargets: 1,
    maxTargets: 1,
    options: getItemTargetOptions(),
  };
}

function buildChocolateSpellPrompt(
  game: RuntimeGame,
  actor: RuntimePlayer,
  sourceType: AbilitySourceType,
  sourceId: string,
  ability: AbilityDefinition,
  itemCardId: string | null,
  firstTargetPlayerId: string,
): RuntimeAbilityPrompt {
  return {
    actorPlayerId: actor.id,
    promptType: 'TARGET',
    abilityKey: buildAbilityKey(sourceType, sourceId, ability.abilityId, itemCardId),
    abilityId: ability.abilityId,
    displayName: ability.displayName,
    description: '次に、呪文タイプ（または特殊タイプ）のプレイヤーを1人選択してください。',
    sourceType,
    sourceId,
    itemCardId,
    canCancel: ability.canCancel,
    minTargets: 1,
    maxTargets: 1,
    options: game.players
      .filter((player) => player.status === 'ALIVE' && player.id !== firstTargetPlayerId)
      .filter((player) => {
        const type = getPlayerHobbyType(game, player);
        return type === 'SPELL' || type === 'SPECIAL';
      })
      .map((player) => ({ id: player.id, displayName: player.displayName })),
  };
}

function getAbilityUsageLabel(sourceType: AbilitySourceType) {
  if (sourceType === 'ITEM') {
    return 'アイテム';
  }
  if (sourceType === 'HOBBY') {
    return '趣味能力';
  }
  return '職業能力';
}

function pushAbilityDeclarationLog(game: RuntimeGame, actor: RuntimePlayer, sourceType: AbilitySourceType) {
  pushGameLog(game, `${actor.displayName}が${getAbilityUsageLabel(sourceType)}の使用を宣言しています。`);
}

function classifyDetectiveResult(game: RuntimeGame, target: RuntimePlayer): '人間' | '人外' {
  if (target.roleId === 'evil-god') {
    const deadCount = game.players.filter((player) => player.status === 'DEAD').length;
    return deadCount === 0 ? '人間' : '人外';
  }
  if (target.roleId === 'monster' && game.players.some((player) => player.roleId === 'ghost' && player.status === 'ALIVE')) {
    return '人間';
  }
  if (target.roleId === 'stray-dog' || target.roleId === 'guard-dog') {
    return '人外';
  }
  const faction = getRoleFaction(target.roleId);
  return faction === 'MONSTER' ? '人外' : '人間';
}

function classifyFumieResult(target: RuntimePlayer): '裏切り者' | '裏切り者ではありません' {
  return target.roleId === 'cultist' ? '裏切り者' : '裏切り者ではありません';
}

function classifySuspiciousJewelResult(target: RuntimePlayer): '邪神' | '邪神ではありません' {
  return target.roleId === 'evil-god' ? '邪神' : '邪神ではありません';
}

function classifyMirrorOfTruthResult(target: RuntimePlayer): '一般人' | '一般人ではありません' {
  return target.roleId === 'villager' ? '一般人' : '一般人ではありません';
}

function resolveGrantedInvestigationLog(game: RuntimeGame, actor: RuntimePlayer, ability: AbilityDefinition, target: RuntimePlayer) {
  if (ability.implementationKey === 'special-fumie-detect-cultist') {
    pushGameLog(game, `踏み絵判定：${target.displayName}は${classifyFumieResult(target)}でした。`, {
      visibility: 'PRIVATE',
      ownerPlayerId: actor.id,
    });
    return;
  }
  if (ability.implementationKey === 'special-detective-kiseru-investigate') {
    pushGameLog(game, `調査結果：${target.displayName}は${classifyDetectiveResult(game, target)}でした。`, {
      visibility: 'PRIVATE',
      ownerPlayerId: actor.id,
    });
    if (target.roleId === 'ghost' && target.status === 'ALIVE') {
      queueHiddenCorpse(game, target.id, 'EXORCISM', actor.id);
    }
    return;
  }
  if (ability.implementationKey === 'special-suspicious-jewel-detect-evil-god') {
    pushGameLog(game, `宝石判定：${target.displayName}は${classifySuspiciousJewelResult(target)}でした。`, {
      visibility: 'PRIVATE',
      ownerPlayerId: actor.id,
    });
    return;
  }
  if (ability.implementationKey === 'special-mirror-of-truth-detect-villager') {
    pushGameLog(game, `鏡判定：${target.displayName}は${classifyMirrorOfTruthResult(target)}でした。`, {
      visibility: 'PRIVATE',
      ownerPlayerId: actor.id,
    });
  }
}

function queueHiddenCorpse(game: RuntimeGame, targetPlayerId: string, deathCause: DeathCause, causedByPlayerId: string | null = null) {
  if (game.pendingMorningEffects.some((effect) => effect.type === 'DISCOVER_DEAD' && effect.targetPlayerId === targetPlayerId)) {
    return;
  }
  game.pendingMorningEffects.push({
    effectId: randomUUID(),
    type: 'DISCOVER_DEAD',
    targetPlayerId,
    causedByPlayerId,
    deathCause,
  });
}

function isValidTargetSelection(prompt: RuntimeAbilityPrompt, targetIds: string[]) {
  if (prompt.maxTargets === 0) {
    return targetIds.length === 0;
  }
  if (targetIds.length !== prompt.maxTargets) {
    return false;
  }
  const optionIds = new Set(prompt.options.map((entry) => entry.id));
  return targetIds.every((entry) => optionIds.has(entry));
}

function replaceMonsterScoutAbility(actor: RuntimePlayer) {
  if (!actor.roleAbilityIds.includes('monster-scout-assault')) {
    return;
  }
  actor.roleAbilityIds = actor.roleAbilityIds.map((entry) => (entry === 'monster-scout-assault' ? 'monster-assault' : entry));
}

async function discardItemCard(game: RuntimeGame, card: RuntimeDeckCard) {
  const ownerPlayerId = card.ownerPlayerId;
  if (ownerPlayerId && card.reservedAbilityId) {
    removeReservedAbility(game, ownerPlayerId, buildAbilityKey('ITEM', card.itemId, card.reservedAbilityId, card.cardId));
  }
  card.zone = 'DISCARDED';
  card.ownerPlayerId = null;
  card.isActivating = false;
  card.reservedAbilityId = null;
  await persistDeckCard(game, card);
  if (ownerPlayerId) {
    syncReservedItemState(game, ownerPlayerId);
    const owner = game.players.find((player) => player.id === ownerPlayerId);
    if (owner) {
      refreshPendingItemOverflow(game, owner);
    }
  }
}

async function discardAllInHandItems(game: RuntimeGame, ownerPlayerId: string) {
  const cards = getInHandCards(game, ownerPlayerId);
  for (const card of cards) {
    await discardItemCard(game, card);
  }
}

async function discardCardsByIds(game: RuntimeGame, ownerPlayerId: string, cardIds: string[]) {
  for (const cardId of cardIds) {
    const card = game.deckCards.find((entry) => entry.cardId === cardId && entry.ownerPlayerId === ownerPlayerId && entry.zone === 'IN_HAND');
    if (card) {
      await discardItemCard(game, card);
    }
  }
}

async function discardItemsForPlayer(game: RuntimeGame, ownerPlayerId: string, count: number, mode: 'OLDEST' | 'RANDOM' = 'OLDEST') {
  const inHand = getInHandCards(game, ownerPlayerId);
  if (inHand.length < 1 || count < 1) {
    return [] as RuntimeDeckCard[];
  }
  const ordered = mode === 'RANDOM' ? shuffle(inHand) : [...inHand].sort((left, right) => left.drawOrder - right.drawOrder);
  const selected = ordered.slice(0, count);
  for (const card of selected) {
    await discardItemCard(game, card);
  }
  return selected;
}

function drawTopItemCard(game: RuntimeGame) {
  return game.deckCards
    .filter((card) => card.zone === 'DRAW_PILE')
    .sort((left, right) => left.drawOrder - right.drawOrder)[0] ?? null;
}

async function grantItemsFromDeck(game: RuntimeGame, recipientIds: string[], count = 1) {
  const touchedPlayerIds = new Set<string>();
  for (const recipientId of recipientIds) {
    const player = game.players.find((entry) => entry.id === recipientId);
    if (!player) {
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      const card = drawTopItemCard(game);
      if (!card) {
        break;
      }
      card.zone = 'IN_HAND';
      card.ownerPlayerId = player.id;
      card.isActivating = false;
      card.reservedAbilityId = null;
      await persistDeckCard(game, card);
      touchedPlayerIds.add(player.id);
    }
  }
  for (const playerId of touchedPlayerIds) {
    const player = game.players.find((entry) => entry.id === playerId);
    if (player) {
      refreshPendingItemOverflow(game, player);
    }
  }
}

async function transferAllInHandItems(game: RuntimeGame, fromPlayerId: string, toPlayerId: string) {
  const cards = getInHandCards(game, fromPlayerId);
  for (const card of cards) {
    card.ownerPlayerId = toPlayerId;
    card.isActivating = false;
    card.reservedAbilityId = null;
    await persistDeckCard(game, card);
  }
  syncReservedItemState(game, fromPlayerId);
  syncReservedItemState(game, toPlayerId);
  const fromPlayer = game.players.find((entry) => entry.id === fromPlayerId);
  const toPlayer = game.players.find((entry) => entry.id === toPlayerId);
  if (fromPlayer) {
    refreshPendingItemOverflow(game, fromPlayer);
  }
  if (toPlayer) {
    refreshPendingItemOverflow(game, toPlayer);
  }
}

async function triggerSelfDeathAbilities(game: RuntimeGame, player: RuntimePlayer) {
  await triggerAbilitySources(game, player, getTriggeredAbilitySources(game, player, 'SELF_DEATH'));
}

async function handleDeathSideEffects(
  game: RuntimeGame,
  player: RuntimePlayer,
  context: { phase: PhaseType; cause: DeathCause; reason: string; causedByPlayerId?: string | null },
) {
  const changed = await setPlayerStatus(game, player, 'DEAD', { cause: context.cause, reason: context.reason });
  if (!changed) {
    return false;
  }
  if ((shouldRevealRoleOnDeath(player.roleId) || (context.cause === 'ASSAULT' && game.revealedOnAssaultDeathPlayerIds.has(player.id))) && revealPlayerRole(player)) {
    pushGameLog(game, getPublicRoleRevealMessage(player));
  }
  game.revealedOnAssaultDeathPlayerIds.delete(player.id);
  await triggerSelfDeathAbilities(game, player);
  await prisma.deathRecord.create({
    data: {
      deathRecordId: randomUUID(),
      gameId: game.gameId,
      gamePlayerId: player.id,
      dayNumber: game.dayNumber,
      phaseType: context.phase,
      cause: context.cause,
      causedByGamePlayerId: context.causedByPlayerId ?? null,
    },
  });
  return true;
}

function queueAbilityProcessing(game: RuntimeGame) {
  queueMicrotask(() => {
    void processAbilityQueue(game.gameId);
  });
}

async function queueAbility(
  game: RuntimeGame,
  actor: RuntimePlayer,
  sourceType: AbilitySourceType,
  sourceId: string,
  ability: AbilityDefinition,
  targetIds: string[],
  itemCardId: string | null = null,
) {
  const abilityKey = buildAbilityKey(sourceType, sourceId, ability.abilityId, itemCardId);
  removeReservedAbility(game, actor.id, abilityKey);
  if (sourceType === 'ITEM' && itemCardId) {
    const card = game.deckCards.find((entry) => entry.cardId === itemCardId && entry.ownerPlayerId === actor.id);
    if (card) {
      card.isActivating = true;
      card.reservedAbilityId = null;
      await persistDeckCard(game, card);
    }
  }
  syncReservedItemState(game, actor.id);
  game.abilityQueue.push({
    queueId: randomUUID(),
    abilityKey,
    abilityId: ability.abilityId,
    actorPlayerId: actor.id,
    sourceType,
    sourceId,
    itemCardId,
    targetIds,
  });
  if (isManualAbility(ability)) {
    pushAbilityDeclarationLog(game, actor, sourceType);
  }
  if (targetIds.length > 0) {
    await prisma.nightAction.upsert({
      where: {
        gameId_dayNumber_actorGamePlayerId_actionKey: {
          gameId: game.gameId,
          dayNumber: game.dayNumber,
          actorGamePlayerId: actor.id,
          actionKey: ability.abilityId,
        },
      },
      create: {
        nightActionId: randomUUID(),
        gameId: game.gameId,
        dayNumber: game.dayNumber,
        actorGamePlayerId: actor.id,
        actionKey: ability.abilityId,
        targetGamePlayerId: targetIds[0] ?? null,
      },
      update: { targetGamePlayerId: targetIds[0] ?? null, submittedAt: new Date() },
    });
  }
  await logAction('ability.queued', { actorId: actor.id, abilityId: ability.abilityId, sourceType, targetIds }, game.gameId);
  await broadcastGame();
  queueAbilityProcessing(game);
}

function orderQueuedAbilities(queue: RuntimeQueuedAbility[]) {
  const groups = new Map<number, RuntimeQueuedAbility[]>();
  const priorityOf = (sourceType: AbilitySourceType) => (sourceType === 'ROLE' ? 0 : sourceType === 'HOBBY' ? 1 : 2);
  for (const entry of queue) {
    const priority = priorityOf(entry.sourceType);
    const current = groups.get(priority) ?? [];
    current.push(entry);
    groups.set(priority, current);
  }
  return Array.from(groups.entries())
    .sort((left, right) => left[0] - right[0])
    .flatMap(([, entries]) => shuffle(entries));
}

function validateQueuedTargets(game: RuntimeGame, actor: RuntimePlayer, ability: AbilityDefinition, targetIds: string[]) {
  if (ability.implementationKey === 'prophecy-diary-steal-by-item') {
    if (targetIds.length !== 2) {
      return false;
    }
    const [targetPlayerId, targetItemId] = targetIds;
    const playerValid = game.players.some((entry) => entry.id === targetPlayerId && entry.status === 'ALIVE' && entry.id !== actor.id);
    const itemValid = runtime.itemById.has(targetItemId);
    return playerValid && itemValid;
  }
  if (ability.implementationKey === 'chocolate-grant-skill-and-spell') {
    if (targetIds.length !== 2 || targetIds[0] === targetIds[1]) {
      return false;
    }
    const [firstTargetId, secondTargetId] = targetIds;
    const first = game.players.find((entry) => entry.id === firstTargetId && entry.status === 'ALIVE');
    const second = game.players.find((entry) => entry.id === secondTargetId && entry.status === 'ALIVE');
    if (!first || !second) {
      return false;
    }
    const firstType = getPlayerHobbyType(game, first);
    const secondType = getPlayerHobbyType(game, second);
    return (firstType === 'SKILL' || firstType === 'SPECIAL') && (secondType === 'SPELL' || secondType === 'SPECIAL');
  }
  const targetOptions = new Set(getAbilityTargetOptions(game, actor, ability).map((entry) => entry.id));
  return targetIds.every((entry) => targetOptions.has(entry));
}

async function resolveQueuedAbility(game: RuntimeGame, queued: RuntimeQueuedAbility) {
  const ability = runtime.abilityById.get(queued.abilityId);
  const actor = game.players.find((entry) => entry.id === queued.actorPlayerId);
  if (!ability || !actor) {
    return;
  }
  const consumedGranted = consumeGrantedTriggeredAbility(game, actor.id, queued.itemCardId);
  if (consumedGranted?.abilityId === PROTECTED_SPECIAL_ABILITY_ID) {
    removePlayerState(actor, 'PROTECTED');
  }
  let resolved = false;
  const targetsAreValid = validateQueuedTargets(game, actor, ability, queued.targetIds);
  if (!targetsAreValid) {
    await logAction('ability.skipped', { actorId: actor.id, abilityId: ability.abilityId, reason: 'invalid-target' }, game.gameId);
  } else if (ability.implementationKey === 'monster-scout-assault') {
    const targetId = queued.targetIds[0];
    if (targetId) {
      game.pendingMorningEffects.push({
        effectId: randomUUID(),
        type: 'DISCARD_ITEM',
        targetPlayerId: targetId,
        causedByPlayerId: actor.id,
      });
    }
    replaceMonsterScoutAbility(actor);
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'monster-assault') {
    const targetId = queued.targetIds[0];
    if (targetId) {
      game.pendingMorningEffects.push({
        effectId: randomUUID(),
        type: 'MAKE_DYING',
        targetPlayerId: targetId,
        causedByPlayerId: actor.id,
      });
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'detective-investigate') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target) {
      pushGameLog(game, `調査結果：${target.displayName}は${classifyDetectiveResult(game, target)}でした。`, {
        visibility: 'PRIVATE',
        ownerPlayerId: actor.id,
      });
      if (target.roleId === 'ghost' && target.status === 'ALIVE') {
        queueHiddenCorpse(game, target.id, 'EXORCISM', actor.id);
      }
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'fumie-detect-cultist') {
    const grantedAbilityId = getGrantedSpecialAbilityId(ability);
    if (grantedAbilityId) {
      grantTriggeredAbility(game, actor.id, queued.sourceId, grantedAbilityId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'detective-kiseru-investigate') {
    const grantedAbilityId = getGrantedSpecialAbilityId(ability);
    if (grantedAbilityId) {
      grantTriggeredAbility(game, actor.id, queued.sourceId, grantedAbilityId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'suspicious-jewel-detect-evil-god') {
    const grantedAbilityId = getGrantedSpecialAbilityId(ability);
    if (grantedAbilityId) {
      grantTriggeredAbility(game, actor.id, queued.sourceId, grantedAbilityId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'white-reagent-detect-evil-god') {
    pushGameLog(game, `白い試薬判定：${hasAliveEvilGod(game) ? '生存者の中に邪神がいます。' : '生存者の中に邪神はいません。'}`, {
      visibility: 'PRIVATE',
      ownerPlayerId: actor.id,
    });
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, evilGodAlive: hasAliveEvilGod(game) }, game.gameId);
  } else if (ability.implementationKey === 'grave-robber-shovel-reveal-role') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target && target.status === 'DEAD') {
      revealPlayerRole(target);
      const role = runtime.roleById.get(target.roleId);
      pushGameLog(game, `墓暴き結果：${target.displayName}の役職は${role?.displayName ?? target.roleId}です。${role?.description ?? ''}`, {
        visibility: 'PRIVATE',
        ownerPlayerId: actor.id,
      });
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'mirror-of-truth-detect-villager') {
    const grantedAbilityId = getGrantedSpecialAbilityId(ability);
    if (grantedAbilityId) {
      grantTriggeredAbility(game, actor.id, queued.sourceId, grantedAbilityId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'sleeping-pill-block-detective') {
    for (const detective of game.players.filter((entry) => entry.roleId === 'detective' && entry.status === 'ALIVE')) {
      game.blockedDetectiveInvestigateNightByPlayerId.set(detective.id, game.dayNumber + 1);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, blockedNightDay: game.dayNumber + 1 }, game.gameId);
  } else if (ability.implementationKey === 'king-seal-double-vote') {
    game.bonusVoteCountByPlayerId.set(actor.id, 1);
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'damp-tiara-block-vote') {
    const targetId = queued.targetIds[0];
    if (targetId) {
      game.blockedVoteByPlayerId.add(targetId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'hazy-cloak-untargetable-vote') {
    const targetId = queued.targetIds[0];
    if (targetId) {
      game.untargetableVoteTargetPlayerIds.add(targetId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'twisted-hourglass-extend-day') {
    if (isTrialDay(game)) {
      setCurrentPhaseTimer(game, Math.max(0, (new Date(game.currentTimerEndsAt ?? new Date().toISOString()).getTime() - Date.now())) + 180000);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, phase: game.phase }, game.gameId);
  } else if (ability.implementationKey === 'warped-silver-watch-shorten-day') {
    if (isTrialDay(game)) {
      game.cancelQueuedAbilitiesRequested = true;
      game.abilityQueue = [];
      setCurrentPhaseTimer(game, 1000);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, phase: game.phase }, game.gameId);
  } else if (ability.implementationKey === 'guard-dog-guard') {
    const targetId = queued.targetIds[0];
    if (targetId) {
      game.guardAssignments.set(actor.id, targetId);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'wealthy-inheritance') {
    await grantItemsFromDeck(game, queued.targetIds, 1);
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'amulet-protect') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target) {
      const grantedAbilityId = getGrantedSpecialAbilityId(ability);
      if (grantedAbilityId) {
        grantTriggeredAbility(game, target.id, queued.sourceId, grantedAbilityId);
      }
      addPlayerState(target, 'PROTECTED');
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'health-pack-heal') {
    await setPlayerStatus(game, actor, 'ALIVE', { reason: 'item.healthPack' });
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'dying-message-block-assault') {
    game.blockedMonsterAssaultNightDay = game.dayNumber;
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, blockedNightDay: game.dayNumber }, game.gameId);
  } else if (ability.implementationKey === 'substitute-doll-redirect-dying') {
    const nextPlayer = getNextAlivePlayer(game, actor.id);
    await setPlayerStatus(game, actor, 'ALIVE', { reason: 'item.substituteDoll' });
    if (nextPlayer) {
      await setPlayerStatus(game, nextPlayer, 'DYING', { cause: 'ASSAULT', reason: 'item.substituteDoll' });
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, redirectedTargetId: nextPlayer?.id ?? null }, game.gameId);
  } else if (ability.implementationKey === 'magic-book-protect') {
    const targetId = queued.targetIds[0];
    if (targetId) {
      game.investigateBlockedNightByPlayerId.set(targetId, game.dayNumber + 1);
      game.protectedFromDyingUntilMorningEndByPlayerId.set(targetId, game.dayNumber + 2);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'will-reveal-role') {
    game.revealedOnAssaultDeathPlayerIds.add(actor.id);
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'handgun-protect') {
    const grantedAbilityId = getGrantedSpecialAbilityId(ability);
    if (grantedAbilityId) {
      grantTriggeredAbility(game, actor.id, queued.sourceId, grantedAbilityId);
    }
    addPlayerState(actor, 'PROTECTED');
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'special-protected-survive-dying') {
    await setPlayerStatus(game, actor, 'ALIVE', { reason: 'special.protected' });
    removePlayerState(actor, 'PROTECTED');
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'zombie-powder-stay-until-night-end') {
    addPlayerState(actor, 'ZOMBIE');
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'brain-vault-votable-on-assault-death') {
    addPlayerState(actor, 'VOTABLE');
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'morishio-talkable-on-assault-death') {
    addPlayerState(actor, 'TALKABLE');
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'crystal-skull-talkable-on-execution-death') {
    if (actor.deathCause === 'EXECUTION') {
      addPlayerState(actor, 'TALKABLE');
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'grotesque-idol-disable-items-on-execution-death') {
    if (actor.deathCause === 'EXECUTION') {
      game.itemsDisabledUntilNightEndDay = game.dayNumber;
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, blockedNightDay: game.dayNumber }, game.gameId);
  } else if (ability.implementationKey === 'odd-ring-redying-on-recover') {
    await setPlayerStatus(game, actor, 'DYING', { reason: 'item.oddRing' });
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'tarot-deck-silence-and-grant-item') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target && target.status === 'ALIVE') {
      addPlayerState(target, 'SILENT');
      await grantItemsFromDeck(game, [target.id], 1);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'dissolution-fluid-discard-all-items') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target && target.status === 'ALIVE' && target.id !== actor.id) {
      await discardAllInHandItems(game, actor.id);
      await discardAllInHandItems(game, target.id);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'string-of-control-force-discard') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target && target.status === 'ALIVE') {
      await discardItemsForPlayer(game, target.id, 1, 'RANDOM');
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'protein-bar-gain-two-if-single-item') {
    if (getInHandCards(game, actor.id).length === 1) {
      await grantItemsFromDeck(game, [actor.id], 2);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId }, game.gameId);
  } else if (ability.implementationKey === 'chocolate-grant-skill-and-spell') {
    const targetIds = queued.targetIds.filter((entry, index, list) => list.indexOf(entry) === index);
    if (targetIds.length > 0) {
      await grantItemsFromDeck(game, targetIds, 1);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'grave-guide-steal-random-from-dead') {
    const targetId = queued.targetIds[0];
    const target = targetId ? game.players.find((entry) => entry.id === targetId) : null;
    if (target && target.status === 'DEAD') {
      const targetCards = getInHandCards(game, target.id);
      const card = targetCards.length > 0 ? shuffle(targetCards)[0] : null;
      if (card) {
        card.zone = 'IN_HAND';
        card.ownerPlayerId = actor.id;
        card.isActivating = false;
        card.reservedAbilityId = null;
        await persistDeckCard(game, card);
        syncReservedItemState(game, target.id);
        refreshPendingItemOverflow(game, actor);
        refreshPendingItemOverflow(game, target);
      }
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds: queued.targetIds }, game.gameId);
  } else if (ability.implementationKey === 'quill-shift-to-spell-or-gain-item') {
    const hobbyType = getPlayerHobbyType(game, actor);
    if (hobbyType === 'SKILL') {
      game.hobbyTypeOverrideByPlayerId.set(actor.id, 'SPELL');
    } else {
      await grantItemsFromDeck(game, [actor.id], 1);
    }
    resolved = true;
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, hobbyTypeBefore: hobbyType }, game.gameId);
  } else if (ability.implementationKey === 'prophecy-diary-steal-by-item') {
    const targetPlayerId = queued.targetIds[0];
    const targetItemId = queued.targetIds[1];
    const target = targetPlayerId ? game.players.find((entry) => entry.id === targetPlayerId) : null;
    if (target && target.status === 'ALIVE' && target.id !== actor.id && targetItemId) {
      const hasItem = getInHandCards(game, target.id).some((card) => card.itemId === targetItemId);
      if (hasItem) {
        await transferAllInHandItems(game, target.id, actor.id);
      }
    }
    resolved = true;
    await logAction('ability.resolved', {
      actorId: actor.id,
      abilityId: ability.abilityId,
      targetPlayerId: targetPlayerId ?? null,
      targetItemId: targetItemId ?? null,
    }, game.gameId);
  }
  if (queued.sourceType === 'ITEM' && queued.itemCardId) {
    const card = game.deckCards.find((entry) => entry.cardId === queued.itemCardId);
    if (card) {
      await discardItemCard(game, card);
    }
  }
  if (resolved) {
    pushAbilityExecutionLog(game, actor, queued, ability);
  }
}

async function processAbilityQueue(gameId: string) {
  const game = runtime.game;
  if (!game || game.gameId !== gameId || game.isProcessingAbilityQueue) {
    return;
  }
  game.isProcessingAbilityQueue = true;
  try {
    while (game.abilityQueue.length > 0) {
      const nextBatch = orderQueuedAbilities(game.abilityQueue.splice(0));
      for (let index = 0; index < nextBatch.length; index += 1) {
        const queued = nextBatch[index];
        await resolveQueuedAbility(game, queued);
        if (game.cancelQueuedAbilitiesRequested) {
          const canceledEntries = nextBatch.slice(index + 1);
          if (game.abilityQueue.length > 0) {
            canceledEntries.push(...game.abilityQueue.splice(0));
          }
          await restoreCanceledQueuedAbilities(game, canceledEntries);
          game.cancelQueuedAbilitiesRequested = false;
          break;
        }
      }
    }
    for (const actor of game.players) {
      await continuePendingAbilityWork(game, actor);
    }
    await syncGamePersistence();
    await broadcastGame();
  } finally {
    game.isProcessingAbilityQueue = false;
  }
}

async function settlePendingPrompts(game: RuntimeGame) {
  return game.pendingAbilityPromptByPlayerId.size < 1;
}

async function canAdvancePhase(game: RuntimeGame) {
  if (!(await settlePendingPrompts(game))) {
    return false;
  }
  if (game.pendingItemOverflowByPlayerId.size > 0) {
    return false;
  }
  if (game.isProcessingAbilityQueue) {
    return false;
  }
  if (game.abilityQueue.length > 0) {
    await processAbilityQueue(game.gameId);
    if (game.abilityQueue.length > 0 || game.isProcessingAbilityQueue) {
      return false;
    }
  }
  if (game.pendingTriggeredAbilitiesByPlayerId.size > 0 || game.pendingReservedAbilitiesByPlayerId.size > 0) {
    for (const actor of game.players) {
      await continuePendingAbilityWork(game, actor);
    }
    if (game.pendingAbilityPromptByPlayerId.size > 0 || game.pendingTriggeredAbilitiesByPlayerId.size > 0 || game.pendingReservedAbilitiesByPlayerId.size > 0) {
      return false;
    }
    if (game.isProcessingAbilityQueue || game.abilityQueue.length > 0) {
      return false;
    }
  }
  return true;
}

async function notifyTriggerTiming(game: RuntimeGame, timing: AbilityTriggerTiming) {
  let hasTriggeredSource = false;
  for (const actor of game.players.filter((entry) => entry.status === 'ALIVE')) {
    const sources = getTriggeredAbilitySources(game, actor, timing);
    if (sources.length > 0) {
      hasTriggeredSource = true;
      await triggerAbilitySources(game, actor, sources);
    }
  }
  if (hasTriggeredSource) {
    await logAction('ability.triggerTimingNotified', { timing }, game.gameId);
  }
}

async function continueTriggeredDeclarations(game: RuntimeGame, actor: RuntimePlayer) {
  if (game.pendingAbilityPromptByPlayerId.has(actor.id) || game.pendingItemOverflowByPlayerId.has(actor.id)) {
    return;
  }
  const remaining = [...getPendingTriggeredAbilities(game, actor.id)];
  while (remaining.length > 0) {
    const source = remaining.shift();
    if (!source) {
      break;
    }
    if (!isTriggeredSourceStillAvailable(game, actor, source)) {
      continue;
    }
    if (getGrantedTriggeredAbilities(game, actor.id).some((entry) => entry.grantId === source.itemCardId) && source.ability.targetCount > 0) {
      setPendingTriggeredAbilities(game, actor.id, remaining);
      game.pendingAbilityPromptByPlayerId.set(
        actor.id,
        buildAbilityPrompt(game, actor, source.sourceType, source.sourceId, source.ability, 'TARGET', source.itemCardId),
      );
      await broadcastGame();
      return;
    }
    if (source.ability.targetCount > 0 || source.ability.canCancel) {
      setPendingTriggeredAbilities(game, actor.id, remaining);
      game.pendingAbilityPromptByPlayerId.set(
        actor.id,
        buildAbilityPrompt(game, actor, source.sourceType, source.sourceId, source.ability, 'CONFIRM', source.itemCardId),
      );
      await broadcastGame();
      return;
    }
    await queueAbility(game, actor, source.sourceType, source.sourceId, source.ability, [], source.itemCardId);
  }
  game.pendingTriggeredAbilitiesByPlayerId.delete(actor.id);
}

async function continueReservedDeclarations(game: RuntimeGame, actor: RuntimePlayer) {
  if (!canPerformActions(actor) || game.pendingAbilityPromptByPlayerId.has(actor.id) || game.pendingItemOverflowByPlayerId.has(actor.id) || getPendingTriggeredAbilities(game, actor.id).length > 0) {
    return;
  }
  const remaining = [...(game.pendingReservedAbilitiesByPlayerId.get(actor.id) ?? [])];
  while (remaining.length > 0) {
    const reserved = remaining.shift();
    if (!reserved) {
      break;
    }
    const ability = runtime.abilityById.get(reserved.abilityId);
    if (!ability || !isManualAbility(ability)) {
      removeReservedAbility(game, actor.id, reserved.abilityKey);
      continue;
    }
    if (!canUseAbilityNow(game, actor, reserved.sourceType, ability)) {
      removeReservedAbility(game, actor.id, reserved.abilityKey);
      syncReservedItemState(game, actor.id);
      continue;
    }
    if (reserved.sourceType === 'ROLE' && !actor.roleAbilityIds.includes(reserved.abilityId)) {
      removeReservedAbility(game, actor.id, reserved.abilityKey);
      continue;
    }
    if (reserved.sourceType === 'HOBBY' && !actor.hobbyAbilityIds.includes(reserved.abilityId)) {
      removeReservedAbility(game, actor.id, reserved.abilityKey);
      continue;
    }
    if (reserved.sourceType === 'ITEM') {
      const card = game.deckCards.find((entry) => entry.cardId === reserved.itemCardId && entry.ownerPlayerId === actor.id && entry.zone === 'IN_HAND');
      const item = card ? runtime.itemById.get(card.itemId) : null;
      if (!card || !item?.abilityIds.includes(reserved.abilityId) || card.isActivating) {
        removeReservedAbility(game, actor.id, reserved.abilityKey);
        syncReservedItemState(game, actor.id);
        continue;
      }
      if (requiresPromptTargetSelection(ability)) {
        game.pendingReservedAbilitiesByPlayerId.set(actor.id, remaining);
        game.pendingAbilityPromptByPlayerId.set(actor.id, buildAbilityPrompt(game, actor, 'ITEM', reserved.sourceId, ability, 'TARGET', reserved.itemCardId));
        card.isActivating = true;
        card.reservedAbilityId = null;
        await persistDeckCard(game, card);
        removeReservedAbility(game, actor.id, reserved.abilityKey);
        await broadcastGame();
        return;
      }
      await queueAbility(game, actor, 'ITEM', reserved.sourceId, ability, [], reserved.itemCardId);
      continue;
    }
    if (requiresPromptTargetSelection(ability)) {
      game.pendingReservedAbilitiesByPlayerId.set(actor.id, remaining);
      game.pendingAbilityPromptByPlayerId.set(actor.id, buildAbilityPrompt(game, actor, reserved.sourceType, reserved.sourceId, ability, 'TARGET', reserved.itemCardId));
      removeReservedAbility(game, actor.id, reserved.abilityKey);
      await broadcastGame();
      return;
    }
    await queueAbility(game, actor, reserved.sourceType, reserved.sourceId, ability, [], reserved.itemCardId);
  }
  game.pendingReservedAbilitiesByPlayerId.delete(actor.id);
}

async function continuePendingAbilityWork(game: RuntimeGame, actor: RuntimePlayer) {
  await continueTriggeredDeclarations(game, actor);
  await continueReservedDeclarations(game, actor);
}

async function processReservedAbilityDeclarations(game: RuntimeGame, phase: Exclude<PhaseType, 'LOBBY' | 'RESULT'>) {
  for (const actor of game.players.filter((entry) => canPerformActions(entry))) {
    const matching = getReservedAbilities(game, actor.id)
      .filter((entry) => {
        const ability = runtime.abilityById.get(entry.abilityId);
        return ability ? doesAbilityActivateAtPhaseStart(ability, phase) : false;
      })
      .sort((left, right) => {
        const priority = { ROLE: 0, HOBBY: 1, ITEM: 2 } as const;
        return priority[left.sourceType] - priority[right.sourceType];
      });
    if (matching.length < 1) {
      continue;
    }
    game.pendingReservedAbilitiesByPlayerId.set(actor.id, matching);
    await continueReservedDeclarations(game, actor);
  }
}

async function enterPhase(
  phase: Exclude<PhaseType, 'LOBBY' | 'RESULT'>,
  options?: { triggerTiming?: AbilityTriggerTiming },
) {
  const game = runtime.game;
  if (!game) {
    return;
  }
  clearPhaseTimeout();
  game.phase = phase;
  if (phase === 'NIGHT') {
    game.guardAssignments.clear();
  }
  game.isPaused = false;
  game.pausedRemainingMs = null;
  const durationMs = getPhaseDurationMs(phase);
  game.currentTimerEndsAt = new Date(Date.now() + durationMs).toISOString();
  if (phase === 'DAY') {
    pushGameLog(game, '昼になりました。');
  } else if (phase === 'VOTE') {
    pushGameLog(game, '投票時間になりました。');
  }
  await processReservedAbilityDeclarations(game, phase);
  await syncGamePersistence();
  broadcast('game.phaseChanged', { phase: game.phase, dayNumber: Math.max(game.dayNumber, 1), currentTimerEndsAt: game.currentTimerEndsAt });
  await broadcastGame();
  if (options?.triggerTiming) {
    await notifyTriggerTiming(game, options.triggerTiming);
  }
  schedulePhaseTimeout(game, durationMs);
}

async function resolveMorningStart() {
  const game = runtime.game;
  if (!game) {
    return;
  }
  game.lastNightDeaths = 0;
  const foundDyingNames: string[] = [];
  const foundDeadNames: string[] = [];
  while (game.pendingMorningEffects.length > 0) {
    const effect = game.pendingMorningEffects.shift();
    if (!effect) {
      continue;
    }
    const target = game.players.find((player) => player.id === effect.targetPlayerId);
    if (!target) {
      await logAction('morningEffect.skipped', { effectId: effect.effectId, targetPlayerId: effect.targetPlayerId }, game.gameId);
      continue;
    }
    if (effect.type === 'MAKE_DYING') {
      if (target.status !== 'ALIVE') {
        await logAction('morningEffect.skipped', { effectId: effect.effectId, targetPlayerId: effect.targetPlayerId }, game.gameId);
        continue;
      }
      const applied = await setPlayerStatus(game, target, 'DYING', { cause: 'ASSAULT', reason: 'monster.assault' });
      await logAction('monster.assault.applied', { targetId: target.id, applied }, game.gameId);
      if (applied) {
        foundDyingNames.push(target.displayName);
      }
      continue;
    }
    if (effect.type === 'DISCOVER_DEAD') {
      if (target.status !== 'ALIVE' || !effect.deathCause) {
        await logAction('morningEffect.skipped', { effectId: effect.effectId, targetPlayerId: effect.targetPlayerId }, game.gameId);
        continue;
      }
      const changed = await handleDeathSideEffects(game, target, {
        phase: 'MORNING',
        cause: effect.deathCause,
        reason: `morning.${effect.deathCause.toLowerCase()}`,
        causedByPlayerId: effect.causedByPlayerId,
      });
      if (changed) {
        foundDeadNames.push(target.displayName);
      }
      continue;
    }
    if (target.status !== 'ALIVE') {
      await logAction('morningEffect.skipped', { effectId: effect.effectId, targetPlayerId: effect.targetPlayerId }, game.gameId);
      continue;
    }
    const targetCard = game.deckCards
      .filter((card) => card.ownerPlayerId === target.id && card.zone === 'IN_HAND')
      .sort((left, right) => left.drawOrder - right.drawOrder)[0];
    if (!targetCard) {
      await logAction('monster.scoutAssault.applied', { targetId: target.id, discarded: false }, game.gameId);
      continue;
    }
    const discardedCards = await discardItemsForPlayer(game, target.id, 1, 'OLDEST');
    await logAction('monster.scoutAssault.applied', {
      targetId: target.id,
      discarded: discardedCards.length > 0,
      cardId: discardedCards[0]?.cardId ?? null,
    }, game.gameId);
  }
  game.morningStartProtectionPlayerIds.clear();
  game.guardAssignments.clear();
  pushGameLog(game, foundDyingNames.length > 0 ? `朝になりました。${foundDyingNames.join('、')}が瀕死で見つかりました。` : '朝になりました。');
  for (const name of foundDeadNames) {
    pushGameLog(game, `${name}は死体で発見されました。`);
  }
  if (await evaluateVictory()) {
    return;
  }
  await enterPhase('MORNING');
}

async function resolveMorningEnd() {
  const game = runtime.game;
  if (!game) {
    return;
  }
  const dyingPlayers = game.players.filter((player) => player.status === 'DYING');
  for (const player of dyingPlayers) {
    const pendingSource = getTriggeredAbilitySources(game, player, 'ASSAULT_DEATH').find((source) => !game.resolvedAssaultDeathAbilityKeys.has(buildAbilityKey(source.sourceType, source.sourceId, source.ability.abilityId, source.itemCardId)));
    if (!pendingSource) {
      continue;
    }
    game.pendingAbilityPromptByPlayerId.set(
      player.id,
      buildAbilityPrompt(game, player, pendingSource.sourceType, pendingSource.sourceId, pendingSource.ability, 'CONFIRM', pendingSource.itemCardId),
    );
    game.currentTimerEndsAt = new Date(Date.now() + 1000).toISOString();
    schedulePhaseTimeout(game, 1000);
    await broadcastGame();
    return;
  }
  for (const player of dyingPlayers) {
    await handleDeathSideEffects(game, player, {
      phase: 'MORNING',
      cause: 'ASSAULT',
      reason: 'morning.resolveDying',
      causedByPlayerId: getMonster(game)?.id ?? null,
    });
    game.lastNightDeaths += 1;
    game.monsterKillCount += 1;
    if (game.monsterKillCount >= game.roleSet.monsterWinRequiredKills && game.monsterKillGoalReachedDay === null) {
      game.monsterKillGoalReachedDay = game.dayNumber;
    }
  }
  game.resolvedAssaultDeathAbilityKeys.clear();
  for (const player of game.players) {
    const hadProtected = hasPlayerState(player, 'PROTECTED');
    setGrantedTriggeredAbilities(
      game,
      player.id,
      getGrantedTriggeredAbilities(game, player.id).filter((entry) => entry.abilityId !== PROTECTED_SPECIAL_ABILITY_ID),
    );
    clearProtectedStateIfGrantMissing(game, player);
    if (hadProtected && !hasPlayerState(player, 'PROTECTED')) {
      await logAction('player.state.cleared', { playerId: player.id, state: 'PROTECTED' }, game.gameId);
    }
  }
  for (const [playerId, protectedUntilDay] of Array.from(game.protectedFromDyingUntilMorningEndByPlayerId.entries())) {
    if (protectedUntilDay <= game.dayNumber) {
      game.protectedFromDyingUntilMorningEndByPlayerId.delete(playerId);
    }
  }
  if (await evaluateVictory()) {
    return;
  }
  await enterPhase('DAY', { triggerTiming: 'DAY_START' });
}

async function resolveVotes() {
  const game = runtime.game;
  if (!game) {
    return;
  }
  const tally = new Map<string, number>();
  for (const [voterId, targetId] of game.votes.entries()) {
    const voteWeight = 1 + (game.bonusVoteCountByPlayerId.get(voterId) ?? 0);
    tally.set(targetId, (tally.get(targetId) ?? 0) + voteWeight);
  }
  game.votes.clear();
  clearVotePhaseEffects(game);
  if (tally.size > 0) {
    const max = Math.max(...tally.values());
    const tied = Array.from(tally.entries()).filter(([, count]) => count === max).map(([id]) => id);
    const executedId = shuffle(tied)[0];
    const executed = game.players.find((player) => player.id === executedId);
    if (executed && executed.status === 'ALIVE') {
      await handleDeathSideEffects(game, executed, {
        phase: 'VOTE',
        cause: 'EXECUTION',
        reason: 'vote.execution',
      });
      if (executed.roleId === 'evil-god') {
        await finishGame('邪神陣営の勝利');
        return;
      }
    }
  }
  if (await evaluateVictory()) {
    return;
  }
  if (await evaluateMonsterVictoryAfterVote(game)) {
    return;
  }
  await enterPhase('NIGHT', { triggerTiming: 'NIGHT' });
}

async function resolveNightEndEffects(game: RuntimeGame) {
  const guardedTargetIds = new Map<string, string[]>();
  for (const [guardId, targetId] of game.guardAssignments.entries()) {
    const guard = game.players.find((player) => player.id === guardId && player.status === 'ALIVE');
    if (!guard) {
      continue;
    }
    const current = guardedTargetIds.get(targetId) ?? [];
    current.push(guardId);
    guardedTargetIds.set(targetId, current);
  }

  const queuedMorningEffects = [...game.pendingMorningEffects];
  const nextMorningEffects = [] as RuntimeGame['pendingMorningEffects'];
  for (const effect of queuedMorningEffects) {
    if (effect.type === 'DISCOVER_DEAD' && (effect.deathCause === 'LINE_OF_DUTY' || effect.deathCause === 'EXORCISM')) {
      const target = game.players.find((player) => player.id === effect.targetPlayerId);
      if (!target || target.status !== 'ALIVE' || !effect.deathCause) {
        await logAction('nightEndEffect.skipped', { effectId: effect.effectId, targetPlayerId: effect.targetPlayerId }, game.gameId);
        continue;
      }
      await handleDeathSideEffects(game, target, {
        phase: 'NIGHT',
        cause: effect.deathCause,
        reason: `night.${effect.deathCause.toLowerCase()}`,
        causedByPlayerId: effect.causedByPlayerId,
      });
      continue;
    }

    if (effect.type !== 'MAKE_DYING') {
      nextMorningEffects.push(effect);
      continue;
    }

    const target = game.players.find((player) => player.id === effect.targetPlayerId && player.status === 'ALIVE');
    if (!target) {
      nextMorningEffects.push(effect);
      continue;
    }

    const guardIds = guardedTargetIds.get(target.id) ?? [];
    if (guardIds.length < 1) {
      nextMorningEffects.push(effect);
      continue;
    }

    for (const guardId of guardIds) {
      const guard = game.players.find((player) => player.id === guardId);
      if (!guard || guard.status !== 'ALIVE') {
        continue;
      }
      await handleDeathSideEffects(game, guard, {
        phase: 'NIGHT',
        cause: 'LINE_OF_DUTY',
        reason: 'night.line_of_duty',
        causedByPlayerId: target.id,
      });
    }
    await logAction('monster.assault.guarded', { targetId: target.id, guardIds }, game.gameId);
  }

  game.pendingMorningEffects = nextMorningEffects;
  for (const [playerId, blockedNightDay] of Array.from(game.investigateBlockedNightByPlayerId.entries())) {
    if (blockedNightDay <= game.dayNumber) {
      game.investigateBlockedNightByPlayerId.delete(playerId);
    }
  }
  if (game.blockedMonsterAssaultNightDay === game.dayNumber) {
    game.blockedMonsterAssaultNightDay = null;
  }
  if (game.itemsDisabledUntilNightEndDay === game.dayNumber) {
    game.itemsDisabledUntilNightEndDay = null;
  }
  for (const player of game.players) {
    if (hasPlayerState(player, 'ZOMBIE')) {
      removePlayerState(player, 'ZOMBIE');
      await logAction('player.state.cleared', { playerId: player.id, state: 'ZOMBIE' }, game.gameId);
    }
    if (hasPlayerState(player, 'VOTABLE')) {
      removePlayerState(player, 'VOTABLE');
      await logAction('player.state.cleared', { playerId: player.id, state: 'VOTABLE' }, game.gameId);
    }
    if (hasPlayerState(player, 'SILENT')) {
      removePlayerState(player, 'SILENT');
      await logAction('player.state.cleared', { playerId: player.id, state: 'SILENT' }, game.gameId);
    }
  }
  game.guardAssignments.clear();
}

async function resolveNightEnd() {
  const game = runtime.game;
  if (!game) {
    return;
  }
  await resolveNightEndEffects(game);
  game.dayNumber += 1;
  await resolveMorningStart();
}

async function startGame() {
  const lobby = getLobbySnapshot();
  if (!lobby.canStart || !lobby.selectedRoleSet) {
    throw new Error(lobby.cannotStartReason ?? 'ゲームを開始できません');
  }
  const resolvedRoleSet = resolveRoleSet(lobby.selectedRoleSet);
  const participants = Array.from(runtime.participants.values())
    .filter((entry) => entry.isConnected)
    .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
  const players = assignRoles(resolvedRoleSet, participants);
  const deckCards = buildDeckCards(players);
  const game: RuntimeGame = {
    gameId: randomUUID(),
    status: 'IN_PROGRESS',
    phase: 'NIGHT',
    isPaused: false,
    dayNumber: 0,
    roleSet: resolvedRoleSet,
    players,
    deckCards,
    currentTimerEndsAt: null,
    pausedRemainingMs: null,
    monsterKillCount: 0,
    monsterKillGoalReachedDay: null,
    lastNightDeaths: 0,
    pendingAbilityPromptByPlayerId: new Map(),
    pendingProphecyDiaryTargetByPlayerId: new Map(),
    pendingChocolateFirstTargetByPlayerId: new Map(),
    hobbyTypeOverrideByPlayerId: new Map(),
    pendingTriggeredAbilitiesByPlayerId: new Map(),
    grantedTriggeredAbilitiesByPlayerId: new Map(),
    reservedAbilitiesByPlayerId: new Map(),
    pendingReservedAbilitiesByPlayerId: new Map(),
    pendingItemOverflowByPlayerId: new Map(),
    guardAssignments: new Map(),
    morningStartProtectionPlayerIds: new Set(),
    protectedFromDyingUntilMorningEndByPlayerId: new Map(),
    investigateBlockedNightByPlayerId: new Map(),
    blockedDetectiveInvestigateNightByPlayerId: new Map(),
    blockedMonsterAssaultNightDay: null,
    itemsDisabledUntilNightEndDay: null,
    bonusVoteCountByPlayerId: new Map(),
    blockedVoteByPlayerId: new Set(),
    untargetableVoteTargetPlayerIds: new Set(),
    revealedOnAssaultDeathPlayerIds: new Set(),
    resolvedAssaultDeathAbilityKeys: new Set(),
    abilityQueue: [],
    pendingMorningEffects: [],
    isProcessingAbilityQueue: false,
    cancelQueuedAbilitiesRequested: false,
    eventLogs: [],
    votes: new Map(),
  };
  runtime.game = game;
  const monster = getMonster(game);
  if (monster) {
    for (const player of game.players.filter((entry) => entry.roleId === 'cultist')) {
      pushGameLog(game, `あなたの崇拝する怪物は${monster.displayName}です。`, {
        visibility: 'PRIVATE',
        ownerPlayerId: player.id,
      });
    }
  }
  for (const player of game.players) {
    refreshPendingItemOverflow(game, player);
  }
  await saveGame(game);
  await logAction('game.started', { roleSetId: game.roleSet.id }, game.gameId);
  broadcast('game.started', { gameId: game.gameId });
  await notifyTriggerTiming(game, 'GAME_START');
  await enterPhase('NIGHT', { triggerTiming: 'ZERO_NIGHT' });
}

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use('/master-data-images', express.static(dataPath('images')));
app.use(express.static(clientDistDir));

app.get('/', (_req, res) => {
  sendRootDocument(res);
});

app.get('/api/bootstrap', async (req, res) => {
  const rawIpAddress = getIpAddress(req);
  const ipAddress = buildParticipantIdentityKey(rawIpAddress, getClientId(req));
  const displayName = await ensureIdentity(ipAddress);
  const response: BootstrapResponse = {
    serverTime: new Date().toISOString(),
    appState: runtime.game?.status ?? 'LOBBY',
    phaseSettings: getPhaseSettings(),
    self: {
      displayName,
      ipAddressHash: hashIp(rawIpAddress),
    },
    lobby: getLobbySnapshot(ipAddress),
    roles: runtime.roles,
    abilities: runtime.abilities,
    hobbies: runtime.hobbies,
    items: runtime.items,
    requireAdminPassword: runtime.config.requireAdminPassword,
  };
  res.json(response);
});

app.post('/api/admin/validate-password', (req, res) => {
  const schema = z.object({ password: z.string() });
  const parsed = schema.parse(req.body);
  const ok = parsed.password === runtime.config.adminPassword;
  res.json({ ok });
});

app.get('/api/role-sets', (_req, res) => {
  res.json(runtime.roleSets);
});

app.put('/api/me/display-name', async (req, res) => {
  const schema = z.object({ displayName: z.string().trim().min(1).max(24) });
  const parsed = schema.parse(req.body);
  const rawIpAddress = getIpAddress(req);
  const ipAddress = buildParticipantIdentityKey(rawIpAddress, getClientId(req));
  await prisma.playerIdentity.upsert({
    where: { ipAddress },
    create: { ipAddress, displayName: parsed.displayName, lastSeenAt: new Date() },
    update: { displayName: parsed.displayName, lastSeenAt: new Date() },
  });
  for (const participant of runtime.participants.values()) {
    if (participant.ipAddress === ipAddress) {
      participant.displayName = parsed.displayName;
    }
  }
  if (runtime.game) {
    const player = runtime.game.players.find((entry) => entry.ipAddress === ipAddress);
    if (player) {
      player.displayName = parsed.displayName;
    }
  }
  await logAction('lobby.displayNameChanged', { ipAddressHash: hashIp(rawIpAddress), displayName: parsed.displayName }, runtime.game?.gameId);
  await broadcastLobby();
  await broadcastGame();
  res.json({ displayName: parsed.displayName });
});

app.put('/api/lobby/selected-role-set', async (req, res) => {
  if (runtime.game && runtime.game.status === 'IN_PROGRESS') {
    res.status(409).json({ message: '進行中は配役変更できません。' });
    return;
  }
  const schema = z.object({ roleSetId: z.string().min(1) });
  const parsed = schema.parse(req.body);
  if (!runtime.roleSetById.has(parsed.roleSetId)) {
    res.status(404).json({ message: '配役が存在しません。' });
    return;
  }
  await persistSelectedRoleSet(parsed.roleSetId);
  await logAction('lobby.roleSetChanged', { roleSetId: parsed.roleSetId });
  await broadcastLobby();
  res.json(getLobbySnapshot(buildParticipantIdentityKey(getIpAddress(req), getClientId(req))));
});

app.post('/api/role-sets/custom', async (req, res) => {
  if (runtime.game && runtime.game.status === 'IN_PROGRESS') {
    res.status(409).json({ message: '進行中は配役を追加できません。' });
    return;
  }
  const schema = z.object({
    displayName: z.string().trim().min(1).max(40),
    requiredPlayerCount: z.number().int().min(4).max(16),
    monsterWinRequiredKills: z.number().int().min(1),
    roles: z.array(z.object({
      roleId: z.string().min(1),
      min: z.number().int().min(0),
      max: z.number().int().min(0),
    })).min(1),
  });
  const parsed = schema.parse(req.body);
  const filteredRoles = parsed.roles.filter((role) => role.min > 0 || role.max > 0);
  if (filteredRoles.length < 1) {
    res.status(400).json({ message: '1つ以上の役職を設定してください。' });
    return;
  }
  if (filteredRoles.some((role) => role.min > role.max)) {
    res.status(400).json({ message: '役職の最小人数と最大人数が不正です。' });
    return;
  }
  if (filteredRoles.some((role) => !runtime.roleById.has(role.roleId))) {
    res.status(400).json({ message: '存在しない役職が含まれています。' });
    return;
  }
  const minTotal = filteredRoles.reduce((sum, role) => sum + role.min, 0);
  const maxTotal = filteredRoles.reduce((sum, role) => sum + role.max, 0);
  if (minTotal > parsed.requiredPlayerCount || maxTotal < parsed.requiredPlayerCount) {
    res.status(400).json({ message: 'その人数では配役を構成できません。' });
    return;
  }
  if (parsed.monsterWinRequiredKills >= parsed.requiredPlayerCount) {
    res.status(400).json({ message: '規定殺害数が不正です。' });
    return;
  }
  try {
    const roleSet = await createCustomRoleSet({
      displayName: parsed.displayName,
      requiredPlayerCount: parsed.requiredPlayerCount,
      monsterWinRequiredKills: parsed.monsterWinRequiredKills,
      roles: filteredRoles,
    });
    await logAction('lobby.roleSetCreated', { roleSetId: roleSet.id });
    await broadcastLobby();
    res.json(getLobbySnapshot(buildParticipantIdentityKey(getIpAddress(req), getClientId(req))));
  } catch (error) {
    res.status(500).json({ message: error instanceof Error ? error.message : '配役の保存に失敗しました。' });
  }
});

app.post('/api/lobby/start', async (_req, res) => {
  try {
    await startGame();
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : '開始に失敗しました。' });
  }
});

app.put('/api/settings/phase-durations', async (req, res) => {
  const schema = z.object({
    daySeconds: z.number().int().min(10).max(3600),
    nightSeconds: z.number().int().min(10).max(3600),
  });
  const parsed = schema.parse(req.body);
  const settings: PhaseSettings = {
    daySeconds: parsed.daySeconds,
    nightSeconds: parsed.nightSeconds,
  };
  await persistPhaseSettings(settings);
  const game = runtime.game;
  if (game && game.status === 'IN_PROGRESS' && (game.phase === 'DAY' || game.phase === 'NIGHT')) {
    const durationMs = getPhaseDurationMs(game.phase);
    if (game.isPaused) {
      game.pausedRemainingMs = durationMs;
    } else {
      game.currentTimerEndsAt = new Date(Date.now() + durationMs).toISOString();
      schedulePhaseTimeout(game, durationMs);
    }
    await broadcastGame();
  }
  broadcast('settings.updated', settings);
  res.json(settings);
});

app.post('/api/game/abilities/activate', async (req, res) => {
  const schema = z.object({
    sourceType: z.enum(['ROLE', 'HOBBY', 'ITEM'] as [AbilitySourceType, AbilitySourceType, AbilitySourceType]),
    abilityId: z.string().min(1),
    itemCardId: z.string().uuid().nullable().optional(),
  });
  const parsed = schema.parse(req.body);
  const ipAddress = buildParticipantIdentityKey(getIpAddress(req), getClientId(req));
  const game = runtime.game;
  if (!game || game.status !== 'IN_PROGRESS') {
    res.status(409).json({ message: '進行中のゲームがありません。' });
    return;
  }
  if (game.isPaused) {
    res.status(409).json({ message: '一時停止中です。' });
    return;
  }
  const actor = game.players.find((entry) => entry.ipAddress === ipAddress);
  if (!actor || !canPerformActions(actor)) {
    res.status(403).json({ message: '現在は能力を使用できません。' });
    return;
  }
  if (game.pendingItemOverflowByPlayerId.has(actor.id)) {
    res.status(409).json({ message: '先に超過したアイテムを破棄してください。' });
    return;
  }
  const ability = runtime.abilityById.get(parsed.abilityId);
  if (!ability || !isManualAbility(ability)) {
    res.status(400).json({ message: 'その能力は予約操作から起動してください。' });
    return;
  }

  let sourceId = '';
  if (parsed.sourceType === 'ROLE') {
    if (!actor.roleAbilityIds.includes(parsed.abilityId)) {
      res.status(400).json({ message: '役職能力が不正です。' });
      return;
    }
    sourceId = actor.roleId;
  } else if (parsed.sourceType === 'HOBBY') {
    if (!actor.hobbyAbilityIds.includes(parsed.abilityId)) {
      res.status(400).json({ message: '趣味能力が不正です。' });
      return;
    }
    sourceId = actor.hobbyId;
  } else {
    res.status(400).json({ message: 'アイテムは予約操作から起動してください。' });
    return;
  }

  if (!canUseAbilityNow(game, actor, parsed.sourceType, ability)) {
    res.status(409).json({ message: '現在はその能力を使用できません。' });
    return;
  }

  if (requiresPromptTargetSelection(ability)) {
    game.pendingAbilityPromptByPlayerId.set(
      actor.id,
      buildAbilityPrompt(game, actor, parsed.sourceType, sourceId, ability, 'TARGET', parsed.itemCardId ?? null),
    );
    await broadcastGame();
    res.json({ ok: true });
    return;
  }

  await queueAbility(game, actor, parsed.sourceType, sourceId, ability, [], parsed.itemCardId ?? null);
  res.json({ ok: true });
});

app.post('/api/game/abilities/reservation', async (req, res) => {
  const schema = z.object({
    sourceType: z.enum(['ROLE', 'HOBBY', 'ITEM'] as [AbilitySourceType, AbilitySourceType, AbilitySourceType]),
    abilityId: z.string().min(1),
    itemCardId: z.string().uuid().nullable().optional(),
  });
  const parsed = schema.parse(req.body);
  const ipAddress = buildParticipantIdentityKey(getIpAddress(req), getClientId(req));
  const game = runtime.game;
  if (!game || game.status !== 'IN_PROGRESS') {
    res.status(409).json({ message: '進行中のゲームがありません。' });
    return;
  }
  if (game.isPaused) {
    res.status(409).json({ message: '一時停止中です。' });
    return;
  }
  const actor = game.players.find((entry) => entry.ipAddress === ipAddress);
  if (!actor || !canPerformActions(actor)) {
    res.status(403).json({ message: '現在は予約できません。' });
    return;
  }
  if (game.pendingItemOverflowByPlayerId.has(actor.id)) {
    res.status(409).json({ message: '先に超過したアイテムを破棄してください。' });
    return;
  }
  const ability = runtime.abilityById.get(parsed.abilityId);
  if (!ability || !isManualAbility(ability)) {
    res.status(400).json({ message: '予約できる起動型能力ではありません。' });
    return;
  }

  let sourceId = '';
  if (parsed.sourceType === 'ROLE') {
    if (!actor.roleAbilityIds.includes(parsed.abilityId)) {
      res.status(400).json({ message: '役職能力が不正です。' });
      return;
    }
    sourceId = actor.roleId;
  } else if (parsed.sourceType === 'HOBBY') {
    if (!actor.hobbyAbilityIds.includes(parsed.abilityId)) {
      res.status(400).json({ message: '趣味能力が不正です。' });
      return;
    }
    sourceId = actor.hobbyId;
  } else {
    const card = game.deckCards.find((entry) => entry.cardId === parsed.itemCardId && entry.ownerPlayerId === actor.id && entry.zone === 'IN_HAND');
    if (!card) {
      res.status(404).json({ message: 'アイテムが見つかりません。' });
      return;
    }
    if (card.isActivating) {
      res.status(409).json({ message: 'このアイテムはすでに宣言中です。' });
      return;
    }
    const item = runtime.itemById.get(card.itemId);
    if (!item?.abilityIds.includes(parsed.abilityId)) {
      res.status(400).json({ message: 'アイテム能力が不正です。' });
      return;
    }
    sourceId = card.itemId;
  }

  if (!canUseAbilityNow(game, actor, parsed.sourceType, ability)) {
    res.status(409).json({ message: '現在はその能力を予約できません。' });
    return;
  }

  const abilityKey = buildAbilityKey(parsed.sourceType, sourceId, parsed.abilityId, parsed.itemCardId ?? null);
  const currentReserved = getReservedAbilities(game, actor.id);
  const isReserved = currentReserved.some((entry) => entry.abilityKey === abilityKey);
  if (isReserved) {
    removeReservedAbility(game, actor.id, abilityKey);
  } else {
    setReservedAbilities(game, actor.id, [
      {
        abilityKey,
        abilityId: parsed.abilityId,
        sourceType: parsed.sourceType,
        sourceId,
        itemCardId: parsed.itemCardId ?? null,
      },
    ]);
  }
  syncReservedItemState(game, actor.id);
  await broadcastGame();
  res.json({ ok: true, reservedAbilityKeys: getReservedAbilities(game, actor.id).map((entry) => entry.abilityKey) });
});

app.post('/api/game/abilities/prompt', async (req, res) => {
  const schema = z.object({
    accept: z.boolean().optional(),
    targetIds: z.array(z.string().min(1)).optional(),
  });
  const parsed = schema.parse(req.body);
  const ipAddress = buildParticipantIdentityKey(getIpAddress(req), getClientId(req));
  const game = runtime.game;
  if (!game || game.status !== 'IN_PROGRESS') {
    res.status(409).json({ message: '進行中のゲームがありません。' });
    return;
  }
  const actor = game.players.find((entry) => entry.ipAddress === ipAddress);
  if (!actor) {
    res.status(403).json({ message: 'プレイヤー情報が見つかりません。' });
    return;
  }
  const prompt = game.pendingAbilityPromptByPlayerId.get(actor.id);
  if (!prompt) {
    res.status(409).json({ message: '解決待ちの能力がありません。' });
    return;
  }
  const ability = runtime.abilityById.get(prompt.abilityId);
  if (!ability) {
    game.pendingAbilityPromptByPlayerId.delete(actor.id);
    await broadcastGame();
    res.status(404).json({ message: '能力が存在しません。' });
    return;
  }

  if (getAbilityTriggerTiming(ability) === 'ASSAULT_DEATH') {
    game.resolvedAssaultDeathAbilityKeys.add(prompt.abilityKey);
  }

  if (prompt.promptType === 'CONFIRM') {
    if (parsed.accept === false && !prompt.canCancel) {
      res.status(400).json({ message: 'この能力はキャンセルできません。' });
      return;
    }
    if (parsed.accept === false) {
      game.pendingAbilityPromptByPlayerId.delete(actor.id);
      await logAction('ability.cancelled', { actorId: actor.id, abilityId: prompt.abilityId }, game.gameId);
      await continuePendingAbilityWork(game, actor);
      await broadcastGame();
      res.json({ ok: true });
      return;
    }
    if (requiresPromptTargetSelection(ability)) {
      game.pendingAbilityPromptByPlayerId.set(
        actor.id,
        buildAbilityPrompt(game, actor, prompt.sourceType, prompt.sourceId, ability, 'TARGET', prompt.itemCardId),
      );
      await broadcastGame();
      res.json({ ok: true });
      return;
    }
    game.pendingAbilityPromptByPlayerId.delete(actor.id);
    await queueAbility(game, actor, prompt.sourceType, prompt.sourceId, ability, [], prompt.itemCardId);
    await continuePendingAbilityWork(game, actor);
    res.json({ ok: true });
    return;
  }

  const targetIds = parsed.targetIds ?? [];
  if (!isValidTargetSelection(prompt, targetIds)) {
    res.status(400).json({ message: '対象が不正です。' });
    return;
  }
  if (ability.implementationKey === 'prophecy-diary-steal-by-item' && prompt.promptType === 'TARGET') {
    const stagedTargetId = game.pendingProphecyDiaryTargetByPlayerId.get(actor.id);
    const isItemSelectionStage = prompt.options.some((option) => runtime.itemById.has(option.id));
    if (!stagedTargetId || !isItemSelectionStage) {
      const targetPlayerId = targetIds[0];
      if (!targetPlayerId) {
        res.status(400).json({ message: '対象が不正です。' });
        return;
      }
      game.pendingProphecyDiaryTargetByPlayerId.set(actor.id, targetPlayerId);
      game.pendingAbilityPromptByPlayerId.set(
        actor.id,
        buildProphecyDiaryItemPrompt(game, actor, prompt.sourceType, prompt.sourceId, ability, prompt.itemCardId, targetPlayerId),
      );
      await broadcastGame();
      res.json({ ok: true });
      return;
    }
    const targetItemId = targetIds[0];
    if (!targetItemId) {
      res.status(400).json({ message: '対象が不正です。' });
      return;
    }
    game.pendingProphecyDiaryTargetByPlayerId.delete(actor.id);
    game.pendingAbilityPromptByPlayerId.delete(actor.id);
    await queueAbility(game, actor, prompt.sourceType, prompt.sourceId, ability, [stagedTargetId, targetItemId], prompt.itemCardId);
    await continuePendingAbilityWork(game, actor);
    res.json({ ok: true });
    return;
  }
  if (ability.implementationKey === 'chocolate-grant-skill-and-spell' && prompt.promptType === 'TARGET') {
    const stagedFirstTargetId = game.pendingChocolateFirstTargetByPlayerId.get(actor.id);
    if (!stagedFirstTargetId) {
      const firstTargetId = targetIds[0];
      if (!firstTargetId) {
        res.status(400).json({ message: '対象が不正です。' });
        return;
      }
      game.pendingChocolateFirstTargetByPlayerId.set(actor.id, firstTargetId);
      game.pendingAbilityPromptByPlayerId.set(
        actor.id,
        buildChocolateSpellPrompt(game, actor, prompt.sourceType, prompt.sourceId, ability, prompt.itemCardId, firstTargetId),
      );
      await broadcastGame();
      res.json({ ok: true });
      return;
    }
    const secondTargetId = targetIds[0];
    if (!secondTargetId) {
      res.status(400).json({ message: '対象が不正です。' });
      return;
    }
    game.pendingChocolateFirstTargetByPlayerId.delete(actor.id);
    game.pendingAbilityPromptByPlayerId.delete(actor.id);
    await queueAbility(game, actor, prompt.sourceType, prompt.sourceId, ability, [stagedFirstTargetId, secondTargetId], prompt.itemCardId);
    await continuePendingAbilityWork(game, actor);
    res.json({ ok: true });
    return;
  }
  game.pendingAbilityPromptByPlayerId.delete(actor.id);
  if (isGrantedTriggeredPrompt(game, actor, prompt)) {
    const target = game.players.find((entry) => entry.id === targetIds[0]);
    const granted = consumeGrantedTriggeredAbility(game, actor.id, prompt.itemCardId);
    if (!granted || !target) {
      await continuePendingAbilityWork(game, actor);
      await broadcastGame();
      res.json({ ok: true });
      return;
    }
    resolveGrantedInvestigationLog(game, actor, ability, target);
    await logAction('ability.resolved', { actorId: actor.id, abilityId: ability.abilityId, targetIds }, game.gameId);
    await continuePendingAbilityWork(game, actor);
    await broadcastGame();
    res.json({ ok: true });
    return;
  }
  await queueAbility(game, actor, prompt.sourceType, prompt.sourceId, ability, targetIds, prompt.itemCardId);
  await continuePendingAbilityWork(game, actor);
  res.json({ ok: true });
});

app.post('/api/game/items/discard-overflow', async (req, res) => {
  const schema = z.object({
    cardIds: z.array(z.string().uuid()).min(1),
  });
  const parsed = schema.parse(req.body);
  const ipAddress = buildParticipantIdentityKey(getIpAddress(req), getClientId(req));
  const game = runtime.game;
  if (!game || game.status !== 'IN_PROGRESS') {
    res.status(409).json({ message: '進行中のゲームがありません。' });
    return;
  }
  const actor = game.players.find((entry) => entry.ipAddress === ipAddress);
  if (!actor) {
    res.status(403).json({ message: 'プレイヤー情報が見つかりません。' });
    return;
  }
  const overflow = game.pendingItemOverflowByPlayerId.get(actor.id);
  if (!overflow) {
    res.status(409).json({ message: '破棄対象の超過アイテムがありません。' });
    return;
  }
  if (parsed.cardIds.length !== overflow.overflowCount) {
    res.status(400).json({ message: '破棄枚数が不正です。' });
    return;
  }
  const uniqueCardIds = new Set(parsed.cardIds);
  if (uniqueCardIds.size !== parsed.cardIds.length) {
    res.status(400).json({ message: '同じアイテムは複数回選択できません。' });
    return;
  }
  const ownedCards = getInHandCards(game, actor.id);
  const ownedCardIds = new Set(ownedCards.map((card) => card.cardId));
  if (parsed.cardIds.some((cardId) => !ownedCardIds.has(cardId))) {
    res.status(400).json({ message: '破棄対象が不正です。' });
    return;
  }
  await discardCardsByIds(game, actor.id, parsed.cardIds);
  refreshPendingItemOverflow(game, actor);
  await broadcastGame();
  res.json({ ok: true });
});

app.post('/api/game/vote', async (req, res) => {
  const schema = z.object({ targetId: z.string().uuid() });
  const parsed = schema.parse(req.body);
  const ipAddress = buildParticipantIdentityKey(getIpAddress(req), getClientId(req));
  const game = runtime.game;
  if (!game || game.phase !== 'VOTE') {
    res.status(409).json({ message: '現在は投票できません。' });
    return;
  }
  if (game.isPaused) {
    res.status(409).json({ message: '一時停止中です。' });
    return;
  }
  const voter = game.players.find((entry) => entry.ipAddress === ipAddress);
  if (!voter || !canVote(voter)) {
    res.status(403).json({ message: '現在は投票できません。' });
    return;
  }
  if (game.blockedVoteByPlayerId.has(voter.id)) {
    res.status(409).json({ message: 'この投票では投票できません。' });
    return;
  }
  if (parsed.targetId === voter.id) {
    res.status(400).json({ message: '自分には投票できません。' });
    return;
  }
  if (game.votes.has(voter.id)) {
    res.status(409).json({ message: 'すでに投票済みです。' });
    return;
  }
  const target = game.players.find((entry) => entry.id === parsed.targetId && entry.status === 'ALIVE');
  if (!target) {
    res.status(400).json({ message: '投票対象が不正です。' });
    return;
  }
  if (game.untargetableVoteTargetPlayerIds.has(target.id)) {
    res.status(409).json({ message: 'そのプレイヤーには投票できません。' });
    return;
  }
  game.votes.set(voter.id, target.id);
  pushGameLog(game, `${target.displayName}に投票しました。`, {
    visibility: 'PRIVATE',
    ownerPlayerId: voter.id,
  });
  await prisma.voteRecord.create({
    data: {
      voteRecordId: randomUUID(),
      gameId: game.gameId,
      dayNumber: game.dayNumber,
      voterGamePlayerId: voter.id,
      targetGamePlayerId: target.id,
    },
  });
  await logAction('vote.submitted', { voterId: voter.id, targetId: target.id, dayNumber: game.dayNumber }, game.gameId);
  await broadcastGame();
  const eligibleVoterCount = game.players.filter((entry) => canVote(entry) && !game.blockedVoteByPlayerId.has(entry.id)).length;
  if (game.votes.size >= eligibleVoterCount) {
    await resolveVotes();
  }
  res.json({ ok: true });
});

app.post('/api/game/pause', async (_req, res) => {
  try {
    await pauseGame();
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : '一時停止に失敗しました。' });
  }
});

app.post('/api/game/resume', async (_req, res) => {
  try {
    await resumeGame();
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : '再開に失敗しました。' });
  }
});

app.post('/api/game/end', async (_req, res) => {
  try {
    await endGameToLobby('ゲームを終了してロビーに戻りました。');
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ message: error instanceof Error ? error.message : 'ゲーム終了に失敗しました。' });
  }
});

wss.on('connection', async (socket: WebSocket, req: IncomingMessage) => {
  const rawIpAddress = getIpAddress(req);
  const ipAddress = buildParticipantIdentityKey(rawIpAddress, getClientId(req));
  const displayName = await ensureIdentity(ipAddress);
  const existingParticipant = findParticipantByIdentityKey(ipAddress);
  const participant: RuntimeParticipant = existingParticipant ?? {
    connectionId: randomUUID(),
    ipAddress,
    rawIpAddress,
    displayName,
    isConnected: true,
    isSelf: false,
    joinedAt: new Date().toISOString(),
    socket,
  };

  participant.rawIpAddress = rawIpAddress;
  participant.displayName = displayName;
  participant.isConnected = true;
  participant.socket = socket;
  runtime.participants.set(participant.connectionId, participant);
  if (runtime.game) {
    const player = runtime.game.players.find((entry) => entry.ipAddress === ipAddress);
    if (player) {
      player.isConnected = true;
    }
    await syncGamePersistence();
  }

  await logAction('lobby.connected', { connectionId: participant.connectionId, ipAddressHash: hashIp(rawIpAddress) }, runtime.game?.gameId);
  socket.send(JSON.stringify({ event: 'lobby.snapshot', payload: getLobbySnapshot(ipAddress) }));
  if (runtime.game) {
    socket.send(JSON.stringify({ event: 'game.snapshot', payload: buildGameSnapshot(ipAddress) }));
  }
  await broadcastLobby();
  await broadcastGame();

  socket.on('close', async () => {
    const current = runtime.participants.get(participant.connectionId);
    if (!current || current.socket !== socket) {
      return;
    }
    if (runtime.game) {
      current.isConnected = false;
      current.socket = undefined;
      const player = runtime.game.players.find((entry) => entry.ipAddress === current.ipAddress);
      if (player) {
        player.isConnected = false;
      }
      await syncGamePersistence();
    } else {
      runtime.participants.delete(current.connectionId);
    }
    await logAction('lobby.disconnected', { connectionId: current.connectionId, ipAddressHash: hashIp(current.rawIpAddress) }, runtime.game?.gameId);
    await broadcastLobby();
    await broadcastGame();
  });
});

async function bootstrap() {
  registerShutdownHandlers();
  await loadAppConfig();
  await loadRoleDefinitions();
  await loadAbilityDefinitions();
  await loadMasterData();
  await loadRoleSets();
  await ensureSettings();
  await listenServer();
  await openUpnpPortMapping();
  const clientShareAddress = await resolveClientShareAddress();
  console.log(`superJinroh server listening on http://localhost:${getServerPort()}`);
  if (clientShareAddress) {
    console.log('サーバーが起動しました。クライアントに以下のアドレスを共有してください：');
    console.log(clientShareAddress);
  } else {
    console.log('サーバーが起動しました。');
  }
}

bootstrap().catch(async (error) => {
  console.error(error);
  await shutdown('bootstrap failure', 1);
});
