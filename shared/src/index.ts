export type FactionType = 'HUMAN' | 'MONSTER' | 'EVIL_GOD';
export type HobbyType = 'SKILL' | 'SPELL' | 'SPECIAL';
export type AbilityType = 'PASSIVE' | 'ACTIVE' | 'TRIGGERED' | 'PROFESSION';
export type AbilityTriggerTiming = 'NONE' | 'GAME_START' | 'ZERO_NIGHT' | 'DAY_START' | 'NIGHT' | 'SELF_DEATH' | 'SELF_DYING' | 'SELF_RECOVERED' | 'ASSAULT_DEATH';
export type AbilityActivationTiming = 'NONE' | 'DAY' | 'NIGHT' | 'ANY' | 'MORNING_START' | 'DAY_START' | 'VOTE_START' | 'NIGHT_START';
export type AbilityTiming = AbilityTriggerTiming | AbilityActivationTiming;
export type PlayerStatus = 'ALIVE' | 'DYING' | 'DEAD';
export type DeathCause = 'EXECUTION' | 'ASSAULT' | 'LINE_OF_DUTY' | 'EXORCISM';
export type PhaseType = 'LOBBY' | 'MORNING' | 'DAY' | 'VOTE' | 'NIGHT' | 'RESULT';
export type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'FINISHED';
export type AbilitySourceType = 'ROLE' | 'HOBBY' | 'ITEM';
export type GameResultStatus = 'WIN' | 'LOSE';
export type PlayerStateTag = 'ZOMBIE' | 'TALKABLE' | 'PROTECTED' | 'VOTABLE' | 'SILENT';

export interface RoleCountDefinition {
  roleId: string;
  min: number;
  max: number;
  resolvedCount?: number;
}

export interface RoleDefinition {
  roleId: string;
  displayName: string;
  description: string;
  faction: FactionType;
  abilityIds: string[];
  enabled: boolean;
  imagePath: string | null;
}

export interface AbilityDefinition {
  abilityId: string;
  displayName: string;
  description: string;
  abilityType: AbilityType;
  timing: AbilityTiming;
  canCancel: boolean;
  targetCount: number;
  implementationKey: string;
  enabled: boolean;
}

export interface PhaseSettings {
  daySeconds: number;
  nightSeconds: number;
}

export interface RoleSetDefinition {
  id: string;
  displayName: string;
  requiredPlayerCount: number;
  monsterWinRequiredKills: number;
  roles: RoleCountDefinition[];
  version: string;
  enabled: boolean;
}

export interface HobbyDefinition {
  hobbyId: string;
  displayName: string;
  description: string;
  hobbyType: HobbyType;
  abilityIds: string[];
  enabled: boolean;
  imagePath: string | null;
}

export interface ItemDefinition {
  itemId: string;
  displayName: string;
  description: string;
  abilityIds: string[];
  cardCount: number;
  enabled: boolean;
  imagePath: string | null;
}

export interface LobbyParticipant {
  connectionId: string;
  displayName: string;
  isConnected: boolean;
  isSelf: boolean;
  joinedAt: string;
}

export interface LobbySnapshot {
  selectedRoleSetId: string | null;
  selectedRoleSet: RoleSetDefinition | null;
  participants: LobbyParticipant[];
  roleSets: RoleSetDefinition[];
  canStart: boolean;
  cannotStartReason: string | null;
}

export interface BootstrapResponse {
  serverTime: string;
  appState: GameStatus;
  phaseSettings: PhaseSettings;
  self: {
    displayName: string;
    ipAddressHash: string;
  };
  lobby: LobbySnapshot;
  roles: RoleDefinition[];
  abilities: AbilityDefinition[];
  hobbies: HobbyDefinition[];
  items: ItemDefinition[];
  requireAdminPassword: boolean;
}

export interface AssignedItemCard {
  cardId: string;
  itemId: string;
  displayName: string;
  zone: 'DRAW_PILE' | 'IN_HAND' | 'DISCARDED';
  ownerPlayerId: string | null;
  isActivating: boolean;
  reservedAbilityId: string | null;
}

export interface AbilityTargetOption {
  id: string;
  displayName: string;
}

export interface AbilityPrompt {
  promptType: 'CONFIRM' | 'TARGET';
  abilityKey: string;
  abilityId: string;
  displayName: string;
  description: string;
  sourceType: AbilitySourceType;
  sourceId: string;
  itemCardId: string | null;
  canCancel: boolean;
  minTargets: number;
  maxTargets: number;
  options: AbilityTargetOption[];
}

export interface GamePlayerView {
  id: string;
  seatOrder: number;
  displayName: string;
  publicRoleId: string | null;
  publicHobbyId: string;
  itemCount: number;
  resultStatus: GameResultStatus | null;
  roleId?: string;
  hobbyId?: string;
  itemCards?: AssignedItemCard[];
  status: PlayerStatus;
  stateTags: PlayerStateTag[];
  deathCause: DeathCause | null;
  isConnected: boolean;
}

export interface ItemOverflowPrompt {
  overflowCount: number;
  cards: AssignedItemCard[];
}

export interface GameLogEntry {
  id: string;
  message: string;
  createdAt: string;
  isPrivate: boolean;
}

export interface GameSnapshot {
  gameId: string;
  status: GameStatus;
  phase: PhaseType;
  isPaused: boolean;
  phaseSettings: PhaseSettings;
  dayNumber: number;
  players: GamePlayerView[];
  roleSetId: string;
  roleSetName: string;
  resolvedRoleSet: RoleSetDefinition | null;
  drawPileCount: number;
  discardPileCount: number;
  currentTimerEndsAt: string | null;
  itemActionsUnlocked: boolean;
  canUseNightAction: boolean;
  nightTargets: Array<{ id: string; displayName: string }>;
  myRoleId: string | null;
  myRoleAbilityIds: string[];
  myHobbyId: string | null;
  myHobbyAbilityIds: string[];
  availableAbilityKeys: string[];
  reservedAbilityKeys: string[];
  myVoteTargetId: string | null;
  pendingAbilityPrompt: AbilityPrompt | null;
  pendingItemOverflow: ItemOverflowPrompt | null;
  knownMonsterPlayerId: string | null;
  myItemCards: AssignedItemCard[];
  logs: GameLogEntry[];
}
