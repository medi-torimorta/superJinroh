export type FactionType = 'HUMAN' | 'MONSTER' | 'EVIL_GOD';
export type PlayerStatus = 'ALIVE' | 'DYING' | 'DEAD';
export type DeathCause = 'EXECUTION' | 'ASSAULT' | 'LINE_OF_DUTY';
export type PhaseType = 'LOBBY' | 'MORNING' | 'DAY' | 'VOTE' | 'NIGHT' | 'RESULT';
export type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'FINISHED';
export type AbilitySourceType = 'ROLE' | 'HOBBY' | 'ITEM';
export interface RoleCountDefinition {
    roleId: string;
    count: number;
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
    abilityIds: string[];
    enabled: boolean;
}
export interface ItemDefinition {
    itemId: string;
    displayName: string;
    abilityIds: string[];
    cardCount: number;
    enabled: boolean;
}
export interface LobbyParticipant {
    connectionId: string;
    displayName: string;
    isConnected: boolean;
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
    self: {
        displayName: string;
        ipAddressHash: string;
    };
    lobby: LobbySnapshot;
    hobbies: HobbyDefinition[];
    items: ItemDefinition[];
}
export interface AssignedItemCard {
    cardId: string;
    itemId: string;
    displayName: string;
    zone: 'DRAW_PILE' | 'IN_HAND' | 'DISCARDED';
    ownerPlayerId: string | null;
}
export interface GamePlayerView {
    id: string;
    seatOrder: number;
    displayName: string;
    roleId?: string;
    hobbyId?: string;
    itemCards?: AssignedItemCard[];
    status: PlayerStatus;
    deathCause: DeathCause | null;
    isConnected: boolean;
}
export interface GameSnapshot {
    gameId: string;
    status: GameStatus;
    phase: PhaseType;
    dayNumber: number;
    players: GamePlayerView[];
    roleSetId: string;
    roleSetName: string;
    drawPileCount: number;
    discardPileCount: number;
    currentTimerEndsAt: string | null;
    canUseNightAction: boolean;
    nightTargets: Array<{
        id: string;
        displayName: string;
    }>;
    myRoleId: string | null;
    myHobbyId: string | null;
    myItemCards: AssignedItemCard[];
}
