import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AbilityDefinition,
  AbilitySourceType,
  AbilityTiming,
  AbilityType,
  BootstrapResponse,
  FactionType,
  GameSnapshot,
  GameStatus,
  HobbyType,
  ItemDefinition,
  LobbySnapshot,
  PhaseSettings,
  PhaseType,
  PlayerStateTag,
  PlayerStatus,
  RoleDefinition,
  RoleSetDefinition,
} from '@super-jinroh/shared';
import packageJson from '../../package.json';

const DEFAULT_PORT = 11037;
const CLIENT_ID_STORAGE_KEY = 'super-jinroh-client-id';
const CLIENT_ID_HEADER = 'x-super-jinroh-client-id';

type SocketEnvelope<T> = {
  event: string;
  payload: T;
};

function getApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE?.trim();
  if (configured) {
    return configured;
  }
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return `http://localhost:${DEFAULT_PORT}`;
}

function createClientId(): string {
  if (typeof window === 'undefined') {
    return 'server-render';
  }
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  if (window.crypto?.getRandomValues) {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getClientId(): string {
  if (typeof window === 'undefined') {
    return 'server-render';
  }
  const existing = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const created = createClientId();
  window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
  return created;
}

function getWsUrl(clientId: string): string {
  const configured = import.meta.env.VITE_WS_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    url.searchParams.set('clientId', clientId);
    return url.toString();
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws?clientId=${encodeURIComponent(clientId)}`;
  }
  return `ws://localhost:${DEFAULT_PORT}/ws?clientId=${encodeURIComponent(clientId)}`;
}

const API_BASE = getApiBase();
const CLIENT_ID = getClientId();
const WS_URL = getWsUrl(CLIENT_ID);
const APP_VERSION = packageJson.version;

function mediaUrl(imagePath: string | null): string | null {
  return imagePath ? `${API_BASE}${imagePath}` : null;
}

function phaseLabel(phase: PhaseType): string {
  if (phase === 'MORNING') {
    return '朝';
  }
  if (phase === 'DAY') {
    return '昼';
  }
  if (phase === 'VOTE') {
    return '投票時間';
  }
  if (phase === 'NIGHT') {
    return '夜';
  }
  if (phase === 'RESULT') {
    return '結果';
  }
  return 'ロビー';
}

function statusLabel(status: PlayerStatus): string {
  if (status === 'ALIVE') {
    return '生存';
  }
  if (status === 'DYING') {
    return '瀕死';
  }
  return '死亡';
}

function playerStateTagLabel(state: PlayerStateTag): string {
  if (state === 'ZOMBIE') {
    return 'ゾンビ';
  }
  if (state === 'TALKABLE') {
    return '会話可能';
  }
  if (state === 'VOTABLE') {
    return '投票可能';
  }
  if (state === 'SILENT') {
    return '会話不能';
  }
  return '保護';
}

function playerStateTagClass(state: PlayerStateTag): string {
  if (state === 'ZOMBIE') {
    return 'is-zombie';
  }
  if (state === 'TALKABLE') {
    return 'is-talkable';
  }
  if (state === 'VOTABLE') {
    return 'is-votable';
  }
  if (state === 'SILENT') {
    return 'is-silent';
  }
  return 'is-protected';
}

function activationTimingLabel(timing: AbilityTiming): string {
  if (timing === 'MORNING_START') {
    return '朝開始時';
  }
  if (timing === 'DAY_START') {
    return '昼開始時';
  }
  if (timing === 'VOTE_START') {
    return '投票開始時';
  }
  if (timing === 'NIGHT_START') {
    return '夜開始時';
  }
  if (timing === 'DAY') {
    return '昼';
  }
  if (timing === 'NIGHT') {
    return '夜';
  }
  if (timing === 'ANY') {
    return 'いつでも';
  }
  return 'なし';
}

function deathCauseLabel(cause: GameSnapshot['players'][number]['deathCause'], revealActualCause: boolean): string {
  if (!cause) {
    return '不明';
  }
  if (!revealActualCause && (cause === 'LINE_OF_DUTY' || cause === 'EXORCISM')) {
    return '不明';
  }
  if (cause === 'ASSAULT') {
    return '襲撃死';
  }
  if (cause === 'EXECUTION') {
    return '処刑死';
  }
  if (cause === 'LINE_OF_DUTY') {
    return '殉職';
  }
  return '成仏';
}

function playerResultLabel(status: PlayerStatus, resultStatus: 'WIN' | 'LOSE' | null): string {
  if (!resultStatus) {
    return statusLabel(status);
  }
  return `${resultStatus === 'WIN' ? '勝利' : '敗北'} (${statusLabel(status)})`;
}

function formatPlayerStatusLabel(
  status: PlayerStatus,
  deathCause: GameSnapshot['players'][number]['deathCause'],
  resultStatus: 'WIN' | 'LOSE' | null,
  revealActualCause: boolean,
): string {
  const baseStatus = status === 'DEAD' ? `死亡 (${deathCauseLabel(deathCause, revealActualCause)})` : statusLabel(status);
  if (!resultStatus) {
    return baseStatus;
  }
  return `${resultStatus === 'WIN' ? '勝利' : '敗北'} (${baseStatus})`;
}

function renderPlayerStatusLabel(
  status: PlayerStatus,
  deathCause: GameSnapshot['players'][number]['deathCause'],
  resultStatus: 'WIN' | 'LOSE' | null,
  revealActualCause: boolean,
  showActualHiddenCause: boolean,
) {
  if (!showActualHiddenCause || status !== 'DEAD' || !deathCause || (deathCause !== 'LINE_OF_DUTY' && deathCause !== 'EXORCISM')) {
    return formatPlayerStatusLabel(status, deathCause, resultStatus, revealActualCause);
  }

  const deathLabel = (
    <>
      死亡 (<span className="player-private-death-cause">{deathCauseLabel(deathCause, true)}</span>)
    </>
  );

  if (!resultStatus) {
    return deathLabel;
  }

  return (
    <>
      {resultStatus === 'WIN' ? '勝利' : '敗北'} ({deathLabel})
    </>
  );
}

function formatRoleCountRange(role: RoleSetDefinition['roles'][number]): string {
  return role.min === role.max ? String(role.min) : `${role.min}~${role.max}`;
}

function formatDisplayedRoleCount(role: RoleSetDefinition['roles'][number], showResolvedCount: boolean): string {
  if (showResolvedCount && typeof role.resolvedCount === 'number') {
    return `${role.resolvedCount} (${formatRoleCountRange(role)})`;
  }
  return formatRoleCountRange(role);
}

function factionLabel(faction: FactionType): string {
  if (faction === 'HUMAN') {
    return '人間';
  }
  if (faction === 'MONSTER') {
    return '人外';
  }
  return '邪神';
}

function hobbyTypeLabel(hobbyType: HobbyType): string {
  if (hobbyType === 'SKILL') {
    return '技能';
  }
  if (hobbyType === 'SPELL') {
    return '呪文';
  }
  return '特殊';
}

function abilityTypeLabel(abilityType: AbilityType): string {
  if (abilityType === 'PASSIVE') {
    return '常在型';
  }
  if (abilityType === 'ACTIVE') {
    return '起動型';
  }
  if (abilityType === 'PROFESSION') {
    return '職業';
  }
  return '誘発型';
}

function buildAbilityKey(sourceType: AbilitySourceType, sourceId: string, abilityId: string, itemCardId: string | null = null): string {
  return [sourceType, sourceId, abilityId, itemCardId ?? ''].join('::');
}

function formatRemainingTime(targetIso: string | null): string {
  if (!targetIso) {
    return '0:00';
  }
  const remainingMs = Math.max(0, new Date(targetIso).getTime() - Date.now());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function FactionBadge({ faction }: { faction: FactionType }) {
  return <span className={`faction-badge faction-${faction.toLowerCase()}`}>{factionLabel(faction)}</span>;
}

function HobbyTypeBadge({ hobbyType }: { hobbyType: HobbyType }) {
  return <span className={`hobby-type-badge hobby-type-${hobbyType.toLowerCase()}`}>{hobbyTypeLabel(hobbyType)}</span>;
}

function AbilityTypeBadge({ abilityType }: { abilityType: AbilityType }) {
  return <span className={`ability-type-badge ability-type-${abilityType.toLowerCase()}`}>{abilityTypeLabel(abilityType)}</span>;
}

function isManualAbility(ability: AbilityDefinition) {
  if (ability.abilityType === 'ACTIVE') {
    return ability.timing !== 'NONE';
  }
  if (ability.abilityType !== 'PROFESSION') {
    return false;
  }
  return ability.timing !== 'NONE'
    && ability.timing !== 'GAME_START'
    && ability.timing !== 'ZERO_NIGHT'
    && ability.timing !== 'NIGHT'
    && ability.timing !== 'SELF_DEATH'
    && ability.timing !== 'SELF_DYING'
    && ability.timing !== 'ASSAULT_DEATH';
}

function AbilityList({
  abilityIds,
  abilityCatalog,
  sourceType,
  sourceId,
  itemCardId = null,
  remainingUseCount,
  availableAbilityKeys,
  reservedAbilityKeys,
  showReservedOverlay = true,
  onAbilityClick,
}: {
  abilityIds: string[];
  abilityCatalog: Map<string, AbilityDefinition>;
  sourceType?: AbilitySourceType;
  sourceId?: string;
  itemCardId?: string | null;
  remainingUseCount?: number | null;
  availableAbilityKeys?: Set<string>;
  reservedAbilityKeys?: Set<string>;
  showReservedOverlay?: boolean;
  onAbilityClick?: (abilityId: string, itemCardId?: string | null) => void;
}) {
  if (abilityIds.length === 0) {
    return null;
  }

  return (
    <div className="ability-list">
      {abilityIds.map((abilityId) => {
        const ability = abilityCatalog.get(abilityId);
        if (!ability) {
          return null;
        }
        const abilityKey = sourceType && sourceId ? buildAbilityKey(sourceType, sourceId, abilityId, itemCardId) : null;
        const isExhausted = sourceType === 'HOBBY' && remainingUseCount === 0;
        const isAvailable = !isExhausted && (abilityKey ? availableAbilityKeys?.has(abilityKey) ?? false : false);
        const isReserved = abilityKey ? reservedAbilityKeys?.has(abilityKey) ?? false : false;
        const showAvailableBorder = isAvailable && sourceType !== 'ITEM';
        return (
          <div
            className={`ability-entry${showAvailableBorder ? ' is-available' : ''}${isReserved ? ' is-reserved' : ''}${isExhausted ? ' is-exhausted' : ''}${isAvailable && onAbilityClick ? ' is-clickable' : ''}`}
            key={ability.abilityId}
            onClick={isAvailable && onAbilityClick ? () => onAbilityClick(ability.abilityId, itemCardId) : undefined}
            role={isAvailable && onAbilityClick ? 'button' : undefined}
            tabIndex={isAvailable && onAbilityClick ? 0 : undefined}
          >
            <div className="title-with-badge ability-line">
              <strong>{sourceType === 'ITEM' ? '効果' : ability.displayName}</strong>
              {sourceType !== 'ROLE' ? <AbilityTypeBadge abilityType={ability.abilityType} /> : null}
            </div>
            {sourceType === 'HOBBY' && remainingUseCount !== undefined ? <div className="ability-remaining-count">残り回数: {remainingUseCount ?? '-'}</div> : null}
            <span className="ability-description-inline">{ability.description}</span>
            {isReserved && showReservedOverlay ? (
              <div className="reservation-overlay" aria-hidden="true">
                <span className="reservation-pill">宣言予約中</span>
              </div>
            ) : null}
            {isExhausted ? <div className="ability-disabled-overlay" aria-hidden="true" /> : null}
          </div>
        );
      })}
    </div>
  );
}

function RoleTooltip({
  roleDefinition,
  abilityCatalog,
}: {
  roleDefinition?: RoleDefinition;
  abilityCatalog: Map<string, AbilityDefinition>;
}) {
  if (!roleDefinition) {
    return null;
  }

  const imageUrl = mediaUrl(roleDefinition.imagePath);

  return (
    <div className="role-tooltip">
      {imageUrl ? (
        <img className="role-tooltip-image" src={imageUrl} alt={roleDefinition.displayName} />
      ) : (
        <div className="role-tooltip-image placeholder">NO IMAGE</div>
      )}
      <div className="role-tooltip-body">
        <div className="title-with-badge">
          <strong>{roleDefinition.displayName}</strong>
          <FactionBadge faction={roleDefinition.faction} />
        </div>
        <p>{roleDefinition.description}</p>
        <AbilityList abilityIds={roleDefinition.abilityIds} abilityCatalog={abilityCatalog} sourceType="ROLE" sourceId={roleDefinition.roleId} />
      </div>
    </div>
  );
}

function HobbyTooltip({
  hobbyDefinition,
  abilityCatalog,
}: {
  hobbyDefinition?: { displayName: string; description: string; imagePath: string | null; hobbyType: HobbyType; abilityIds: string[] };
  abilityCatalog: Map<string, AbilityDefinition>;
}) {
  if (!hobbyDefinition) {
    return null;
  }

  const imageUrl = mediaUrl(hobbyDefinition.imagePath);

  return (
    <div className="role-tooltip hobby-tooltip">
      {imageUrl ? (
        <img className="role-tooltip-image" src={imageUrl} alt={hobbyDefinition.displayName} />
      ) : (
        <div className="role-tooltip-image placeholder">NO IMAGE</div>
      )}
      <div className="role-tooltip-body">
        <div className="title-with-badge">
          <strong>{hobbyDefinition.displayName}</strong>
          <HobbyTypeBadge hobbyType={hobbyDefinition.hobbyType} />
        </div>
        <p>{hobbyDefinition.description}</p>
        <AbilityList abilityIds={hobbyDefinition.abilityIds} abilityCatalog={abilityCatalog} sourceType="HOBBY" sourceId={hobbyDefinition.displayName} />
      </div>
    </div>
  );
}

function RoleRowTrigger({
  roleDefinition,
  countLabel,
  abilityCatalog,
}: {
  roleDefinition?: RoleDefinition;
  countLabel: string;
  abilityCatalog: Map<string, AbilityDefinition>;
}) {
  const [open, setOpen] = useState(false);

  if (!roleDefinition) {
    return null;
  }

  return (
    <div
      className={`role-row role-row-trigger${open ? ' is-open' : ''}`}
      onClick={() => setOpen((value) => !value)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="role-row-main">
        <span>{roleDefinition.displayName}</span>
        <span>{countLabel}</span>
      </div>
      <RoleTooltip roleDefinition={roleDefinition} abilityCatalog={abilityCatalog} />
    </div>
  );
}

function RoleSetRoleList({
  roleSet,
  roleCatalog,
  interactiveRoles,
  abilityCatalog,
  showResolvedCount = false,
}: {
  roleSet: RoleSetDefinition | null;
  roleCatalog: Map<string, RoleDefinition>;
  interactiveRoles: boolean;
  abilityCatalog: Map<string, AbilityDefinition>;
  showResolvedCount?: boolean;
}) {
  return (
    <div className="list">
      {roleSet?.roles.map((role) => {
        const roleDefinition = roleCatalog.get(role.roleId);
        const countLabel = formatDisplayedRoleCount(role, showResolvedCount);
        return (
          interactiveRoles ? (
            <RoleRowTrigger key={role.roleId} roleDefinition={roleDefinition} countLabel={countLabel} abilityCatalog={abilityCatalog} />
          ) : (
            <div className="role-row" key={role.roleId}>
              <span>{roleDefinition?.displayName ?? role.roleId}</span>
              <span>{countLabel}</span>
            </div>
          )
        );
      })}
    </div>
  );
}

function RoleSetSummary({
  roleSet,
  roleCatalog,
  interactiveRoles = false,
  abilityCatalog,
  showRoleSetName = true,
  showResolvedCount = false,
}: {
  roleSet: RoleSetDefinition | null;
  roleCatalog: Map<string, RoleDefinition>;
  interactiveRoles?: boolean;
  abilityCatalog: Map<string, AbilityDefinition>;
  showRoleSetName?: boolean;
  showResolvedCount?: boolean;
}) {
  return (
    <div className="role-set-summary">
      <div className="role-set-meta">
        {showRoleSetName ? (
          <div className="role-set-highlight">
            <span className="role-set-label">配役名</span>
            <span className="role-set-value">{roleSet?.displayName ?? '未選択'}</span>
          </div>
        ) : null}
        <div className="role-set-highlight">
          <span className="role-set-label">規定殺害人数</span>
          <span className="role-set-value">{roleSet?.monsterWinRequiredKills ?? '-'}</span>
        </div>
      </div>
      <RoleSetRoleList roleSet={roleSet} roleCatalog={roleCatalog} interactiveRoles={interactiveRoles} abilityCatalog={abilityCatalog} showResolvedCount={showResolvedCount} />
    </div>
  );
}

function RoleSetTooltip({
  roleSet,
  roleCatalog,
  abilityCatalog,
  showResolvedCount = false,
}: {
  roleSet: RoleSetDefinition | null;
  roleCatalog: Map<string, RoleDefinition>;
  abilityCatalog: Map<string, AbilityDefinition>;
  showResolvedCount?: boolean;
}) {
  if (!roleSet) {
    return null;
  }

  return (
    <div className="role-tooltip role-set-tooltip">
      <RoleSetSummary roleSet={roleSet} roleCatalog={roleCatalog} abilityCatalog={abilityCatalog} showRoleSetName={false} showResolvedCount={showResolvedCount} />
    </div>
  );
}

function ResizeButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <button
      className="panel-resize-btn"
      type="button"
      title={collapsed ? '拡大' : '縮小'}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      {!imgFailed ? (
        <img
          src={`${API_BASE}/master-data-images/ui/resize.webp`}
          alt=""
          className="panel-resize-img"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span>●</span>
      )}
    </button>
  );
}

function ItemIcons({ count, className }: { count: number; className?: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  if (count === 0 || imgFailed) return null;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <img
          key={i}
          src={`${API_BASE}/master-data-images/ui/item.webp`}
          alt=""
          className={`item-icon-tiny${className ? ` ${className}` : ''}`}
          onError={i === 0 ? () => setImgFailed(true) : undefined}
        />
      ))}
    </>
  );
}

function MasterInfoBlock({
  title,
  displayName,
  description,
  imagePath,
  faction,
  hobbyType,
  abilityIds,
  abilityCatalog,
  sourceType,
  sourceId,
  remainingUseCount,
  availableAbilityKeys,
  reservedAbilityKeys,
  onAbilityClick,
  collapsed,
  onToggle,
  collapsedTitle,
  collapsedTitleAddon,
  titleHoverLabel,
  titleHoverContent,
}: {
  title: string;
  displayName: string;
  description: string;
  imagePath: string | null;
  faction?: FactionType;
  hobbyType?: HobbyType;
  abilityIds: string[];
  abilityCatalog: Map<string, AbilityDefinition>;
  sourceType?: AbilitySourceType;
  sourceId?: string;
  remainingUseCount?: number | null;
  availableAbilityKeys?: Set<string>;
  reservedAbilityKeys?: Set<string>;
  onAbilityClick?: (abilityId: string, itemCardId?: string | null) => void;
  collapsed: boolean;
  onToggle: () => void;
  collapsedTitle?: string;
  collapsedTitleAddon?: ReactNode;
  titleHoverLabel?: string;
  titleHoverContent?: ReactNode;
}) {
  const imageUrl = mediaUrl(imagePath);
  const shownTitle = collapsed && collapsedTitle ? collapsedTitle : title;

  return (
    <article
      className={`card master-card${collapsed ? ' is-collapsed is-collapsed-clickable' : ''}`}
      onClick={collapsed ? onToggle : undefined}
      role={collapsed ? 'button' : undefined}
      tabIndex={collapsed ? 0 : undefined}
      onKeyDown={collapsed ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      } : undefined}
    >
      <div className="title-with-badge panel-title-row">
        <div className="master-title-main">
          <h2>{shownTitle}</h2>
          {collapsed && collapsedTitleAddon ? <span className="master-title-addon">{collapsedTitleAddon}</span> : null}
          {!collapsed && titleHoverLabel && titleHoverContent ? (
            <span className="panel-hover-label-wrapper">
              <span className="panel-hover-label">{titleHoverLabel}</span>
              <div className="panel-floating-role-set">{titleHoverContent}</div>
            </span>
          ) : null}
        </div>
        <ResizeButton collapsed={collapsed} onToggle={onToggle} />
      </div>
      {!collapsed && (
        <>
          {imageUrl ? (
            <img className="master-card-image" src={imageUrl} alt={displayName} />
          ) : (
            <div className="master-card-image placeholder">NO IMAGE</div>
          )}
          <div className="master-card-body">
            <div className="title-with-badge">
              <strong>{displayName}</strong>
              {faction ? <FactionBadge faction={faction} /> : null}
              {hobbyType ? <HobbyTypeBadge hobbyType={hobbyType} /> : null}
            </div>
            <p>{description}</p>
            <AbilityList
              abilityIds={abilityIds}
              abilityCatalog={abilityCatalog}
              sourceType={sourceType}
              sourceId={sourceId}
              itemCardId={null}
              remainingUseCount={remainingUseCount}
              availableAbilityKeys={availableAbilityKeys}
              reservedAbilityKeys={reservedAbilityKeys}
              onAbilityClick={onAbilityClick}
            />
          </div>
        </>
      )}
    </article>
  );
}

function SpectatorInfoBlock() {
  const [showImage, setShowImage] = useState(true);
  const imageUrl = `${API_BASE}/master-data-images/ui/spectator.webp`;

  return (
    <article className="card master-card spectator-card">
      <div className="title-with-badge panel-title-row">
        <h2>観戦中</h2>
      </div>
      {showImage ? (
        <img className="master-card-image" src={imageUrl} alt="観戦中" onError={() => setShowImage(false)} />
      ) : (
        <div className="master-card-image placeholder">観戦中</div>
      )}
      <div className="master-card-body">
        <strong>観戦中</strong>
        <p className="spectator-card-note">このゲームでは役職と趣味の情報は表示されません。</p>
      </div>
    </article>
  );
}

function SpectatorInfoCard({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const [showImage, setShowImage] = useState(true);
  const imageUrl = `${API_BASE}/master-data-images/ui/spectator.webp`;

  return (
    <article
      className={`card master-card spectator-card${collapsed ? ' is-collapsed is-collapsed-clickable' : ''}`}
      onClick={collapsed ? onToggle : undefined}
      role={collapsed ? 'button' : undefined}
      tabIndex={collapsed ? 0 : undefined}
      onKeyDown={collapsed ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      } : undefined}
    >
      <div className="title-with-badge panel-title-row">
        <h2>観戦中</h2>
        <ResizeButton collapsed={collapsed} onToggle={onToggle} />
      </div>
      {!collapsed ? (
        <>
          {showImage ? (
            <img className="master-card-image" src={imageUrl} alt="観戦中" onError={() => setShowImage(false)} />
          ) : (
            <div className="master-card-image placeholder">観戦中</div>
          )}
          <div className="master-card-body">
            <strong>観戦中</strong>
            <p className="spectator-card-note">このゲームでは役職と趣味の情報は表示されません。</p>
          </div>
        </>
      ) : null}
    </article>
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      [CLIENT_ID_HEADER]: CLIENT_ID,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: 'request failed' }));
    throw new Error(body.message ?? 'request failed');
  }
  return response.json() as Promise<T>;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [appState, setAppState] = useState<GameStatus>('LOBBY');
  const [phaseSettings, setPhaseSettings] = useState<PhaseSettings>({ daySeconds: 300, nightSeconds: 90 });
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [statusMessage, setStatusMessage] = useState<string>('loading...');
  const [personalOpen, setPersonalOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminPasswordDialogOpen, setAdminPasswordDialogOpen] = useState(false);
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [rolePanelCollapsed, setRolePanelCollapsed] = useState(false);
  const [hobbyPanelCollapsed, setHobbyPanelCollapsed] = useState(false);
  const [itemPanelCollapsed, setItemPanelCollapsed] = useState(false);
  const [playerPanelCollapsed, setPlayerPanelCollapsed] = useState(false);
  const [spectatorPanelCollapsed, setSpectatorPanelCollapsed] = useState(false);
  const [collapseOthersOnExpand, setCollapseOthersOnExpand] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const [selectedRoleSetId, setSelectedRoleSetId] = useState('');
  const [daySeconds, setDaySeconds] = useState('300');
  const [nightSeconds, setNightSeconds] = useState('90');
  const [timerLabel, setTimerLabel] = useState('0:00');
  const [selectedPromptTargets, setSelectedPromptTargets] = useState<string[]>([]);
  const [flashedLogIds, setFlashedLogIds] = useState<string[]>([]);
  const [selectedOverflowCardIds, setSelectedOverflowCardIds] = useState<string[]>([]);
  const [showOverflowConfirm, setShowOverflowConfirm] = useState(false);
  const [customRoleSetOpen, setCustomRoleSetOpen] = useState(false);
  const [customRoleSetName, setCustomRoleSetName] = useState('');
  const [customRequiredPlayerCount, setCustomRequiredPlayerCount] = useState('5');
  const [customMonsterWinRequiredKills, setCustomMonsterWinRequiredKills] = useState('2');
  const [customRoleRanges, setCustomRoleRanges] = useState<Record<string, { min: string; max: string }>>({});
  const previousLogIdsRef = useRef<string[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchJson<BootstrapResponse>(`${API_BASE}/api/bootstrap`);
        setBootstrap(data);
        setAppState(data.appState);
        setPhaseSettings(data.phaseSettings);
        setDaySeconds(String(data.phaseSettings.daySeconds));
        setNightSeconds(String(data.phaseSettings.nightSeconds));
        setLobby(data.lobby);
        setDisplayName(data.self.displayName);
        setSelectedRoleSetId(data.lobby.selectedRoleSetId ?? '');
        setStatusMessage('connected');
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : 'bootstrap failed');
      }
    })();
  }, []);

  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    socket.onopen = () => setStatusMessage('websocket connected');
    socket.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as SocketEnvelope<unknown>;
      if (parsed.event === 'lobby.snapshot' || parsed.event === 'lobby.updated') {
        const nextLobby = parsed.payload as LobbySnapshot;
        setLobby(nextLobby);
        setSelectedRoleSetId(nextLobby.selectedRoleSetId ?? '');
      }
      if (parsed.event === 'game.snapshot') {
        const nextGame = parsed.payload as GameSnapshot;
        setGame(nextGame);
        setPhaseSettings(nextGame.phaseSettings);
        setDaySeconds(String(nextGame.phaseSettings.daySeconds));
        setNightSeconds(String(nextGame.phaseSettings.nightSeconds));
        setAppState('IN_PROGRESS');
      }
      if (parsed.event === 'game.finished') {
        const payload = parsed.payload as { reason: string };
        setStatusMessage(payload.reason);
      }
      if (parsed.event === 'game.cleared') {
        const payload = parsed.payload as { reason?: string };
        setGame(null);
        setAppState('LOBBY');
        if (payload.reason) {
          setStatusMessage(payload.reason);
        }
      }
      if (parsed.event === 'settings.updated') {
        const settings = parsed.payload as PhaseSettings;
        setPhaseSettings(settings);
        setDaySeconds(String(settings.daySeconds));
        setNightSeconds(String(settings.nightSeconds));
      }
    };
    socket.onclose = () => setStatusMessage('websocket closed');
    return () => socket.close();
  }, []);

  const roleCatalog = useMemo(() => new Map((bootstrap?.roles ?? []).map((entry) => [entry.roleId, entry])), [bootstrap]);
  const abilityCatalog = useMemo(() => new Map((bootstrap?.abilities ?? []).map((entry) => [entry.abilityId, entry])), [bootstrap]);
  const hobbyCatalog = useMemo(() => new Map((bootstrap?.hobbies ?? []).map((entry) => [entry.hobbyId, entry])), [bootstrap]);
  const itemCatalog = useMemo(() => new Map((bootstrap?.items ?? []).map((entry) => [entry.itemId, entry])), [bootstrap]);
  const isGameActive = appState !== 'LOBBY';
  const activeRoleSet = useMemo(() => {
    if (game?.resolvedRoleSet) {
      return game.resolvedRoleSet;
    }
    if (game && lobby) {
      return lobby.roleSets.find((entry) => entry.id === game.roleSetId) ?? lobby.selectedRoleSet;
    }
    return lobby?.selectedRoleSet ?? null;
  }, [game, lobby]);
  const myRole = useMemo(() => (game?.myRoleId ? roleCatalog.get(game.myRoleId) ?? null : null), [game, roleCatalog]);
  const myHobby = useMemo(() => (game?.myHobbyId ? hobbyCatalog.get(game.myHobbyId) ?? null : null), [game, hobbyCatalog]);
  const isSpectator = useMemo(() => game?.status === 'IN_PROGRESS' && !myRole && !myHobby, [game, myHobby, myRole]);
  const selfPlayerId = useMemo(() => game?.players.find((player) => player.roleId !== undefined)?.id ?? null, [game]);
  const availableAbilityKeySet = useMemo(() => new Set(game?.availableAbilityKeys ?? []), [game]);
  const reservedAbilityKeySet = useMemo(() => new Set(game?.reservedAbilityKeys ?? []), [game]);
  const aliveCount = useMemo(() => game?.players.filter((player) => player.status === 'ALIVE').length ?? 0, [game]);
  const visibleLogs = useMemo(() => {
    if (!game) {
      return [];
    }
    return logExpanded ? game.logs.slice(0, 20).reverse() : game.logs.slice(0, 5).reverse();
  }, [game, logExpanded]);
  const pendingItemOverflow = game?.pendingItemOverflow ?? null;
  const selectedOverflowItems = useMemo(
    () => game?.myItemCards.filter((card) => selectedOverflowCardIds.includes(card.cardId)) ?? [],
    [game, selectedOverflowCardIds],
  );

  useEffect(() => {
    if (!bootstrap) {
      return;
    }
    setCustomRoleRanges((current) => {
      if (Object.keys(current).length > 0) {
        return current;
      }
      return Object.fromEntries(bootstrap.roles.map((role) => [role.roleId, { min: '0', max: '0' }]));
    });
  }, [bootstrap]);

  useEffect(() => {
    const prompt = game?.pendingAbilityPrompt;
    if (!prompt) {
      setSelectedPromptTargets([]);
      return;
    }
    if (prompt.promptType === 'TARGET' && prompt.maxTargets === 1 && prompt.options[0]) {
      setSelectedPromptTargets([prompt.options[0].id]);
      return;
    }
    setSelectedPromptTargets([]);
  }, [
    game?.pendingAbilityPrompt?.abilityKey,
    game?.pendingAbilityPrompt?.promptType,
    game?.pendingAbilityPrompt?.maxTargets,
    game?.pendingAbilityPrompt?.options.map((option) => option.id).join(','),
  ]);

  useEffect(() => {
    if (!pendingItemOverflow) {
      setSelectedOverflowCardIds([]);
      setShowOverflowConfirm(false);
      return;
    }
    const validCardIds = new Set(pendingItemOverflow.cards.map((card) => card.cardId));
    setSelectedOverflowCardIds((current) => current.filter((cardId) => validCardIds.has(cardId)).slice(0, pendingItemOverflow.overflowCount));
  }, [pendingItemOverflow]);

  useEffect(() => {
    if (!pendingItemOverflow) {
      setShowOverflowConfirm(false);
      return;
    }
    setShowOverflowConfirm(selectedOverflowCardIds.length === pendingItemOverflow.overflowCount);
  }, [pendingItemOverflow, selectedOverflowCardIds]);

  useEffect(() => {
    if (!game) {
      setTimerLabel('0:00');
      return;
    }
    const updateTimer = () => {
      setTimerLabel(game.isPaused ? '一時停止中' : formatRemainingTime(game.currentTimerEndsAt));
    };
    updateTimer();
    const timerId = window.setInterval(updateTimer, 1000);
    return () => window.clearInterval(timerId);
  }, [game]);

  useEffect(() => {
    if (!game) {
      previousLogIdsRef.current = [];
      setFlashedLogIds([]);
      return;
    }
    const currentLogIds = game.logs.map((entry) => entry.id);
    const previousLogIds = previousLogIdsRef.current;
    previousLogIdsRef.current = currentLogIds;
    if (previousLogIds.length < 1) {
      return;
    }
    const newLogIds = currentLogIds.filter((id) => !previousLogIds.includes(id));
    if (newLogIds.length < 1) {
      return;
    }
    setFlashedLogIds((current) => Array.from(new Set([...current, ...newLogIds])));
    const timeoutId = window.setTimeout(() => {
      setFlashedLogIds((current) => current.filter((id) => !newLogIds.includes(id)));
    }, 700);
    return () => window.clearTimeout(timeoutId);
  }, [game]);

  async function submitDisplayName() {
    const payload = await fetchJson<{ displayName: string }>(`${API_BASE}/api/me/display-name`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    });
    setDisplayName(payload.displayName);
  }

  async function submitRoleSet() {
    if (!selectedRoleSetId) {
      return;
    }
    if (selectedRoleSetId === '__custom__') {
      setCustomRoleSetOpen(true);
      return;
    }
    const payload = await fetchJson<LobbySnapshot>(`${API_BASE}/api/lobby/selected-role-set`, {
      method: 'PUT',
      body: JSON.stringify({ roleSetId: selectedRoleSetId }),
    });
    setLobby(payload);
    setSelectedRoleSetId(payload.selectedRoleSetId ?? '');
  }

  async function submitCustomRoleSet() {
    const requiredPlayerCount = Number(customRequiredPlayerCount);
    const monsterWinRequiredKills = Number(customMonsterWinRequiredKills);
    if (!customRoleSetName.trim()) {
      setStatusMessage('配役名を入力してください');
      return;
    }
    if (!Number.isInteger(requiredPlayerCount) || !Number.isInteger(monsterWinRequiredKills)) {
      setStatusMessage('人数と規定殺害数は整数で入力してください');
      return;
    }
    try {
      const payload = await fetchJson<LobbySnapshot>(`${API_BASE}/api/role-sets/custom`, {
        method: 'POST',
        body: JSON.stringify({
          displayName: customRoleSetName.trim(),
          requiredPlayerCount,
          monsterWinRequiredKills,
          roles: Object.entries(customRoleRanges).map(([roleId, range]) => ({
            roleId,
            min: Number(range.min),
            max: Number(range.max),
          })),
        }),
      });
      setLobby(payload);
      setSelectedRoleSetId(payload.selectedRoleSetId ?? '');
      setCustomRoleSetOpen(false);
      setStatusMessage('カスタム配役を保存しました');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'カスタム配役の保存に失敗しました');
    }
  }

  async function startGame() {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/lobby/start`, { method: 'POST' });
    setAppState('IN_PROGRESS');
    setAdminOpen(false);
  }

  async function pauseGame() {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/pause`, { method: 'POST' });
  }

  async function resumeGame() {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/resume`, { method: 'POST' });
  }

  async function endGame() {
    if (!window.confirm('進行中ゲームを終了してロビーに戻りますか？')) {
      return;
    }
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/end`, { method: 'POST' });
  }

  async function submitPhaseSettings() {
    const payload = await fetchJson<PhaseSettings>(`${API_BASE}/api/settings/phase-durations`, {
      method: 'PUT',
      body: JSON.stringify({ daySeconds: Number(daySeconds), nightSeconds: Number(nightSeconds) }),
    });
    setPhaseSettings(payload);
    setDaySeconds(String(payload.daySeconds));
    setNightSeconds(String(payload.nightSeconds));
  }

  async function submitVote(targetId: string) {
    try {
      await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/vote`, {
        method: 'POST',
        body: JSON.stringify({ targetId }),
      });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '投票に失敗しました');
    }
  }

  async function toggleAbilityReservation(sourceType: AbilitySourceType, abilityId: string, itemCardId?: string | null) {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/abilities/reservation`, {
      method: 'POST',
      body: JSON.stringify({ sourceType, abilityId, itemCardId: itemCardId ?? null }),
    });
  }

  async function resolveAbilityPrompt(accept: boolean) {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/abilities/prompt`, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
  }

  async function submitPromptTargets() {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/abilities/prompt`, {
      method: 'POST',
      body: JSON.stringify({ targetIds: selectedPromptTargets }),
    });
  }

  function togglePromptTarget(targetId: string) {
    setSelectedPromptTargets((current) => (
      current.includes(targetId) ? current.filter((entry) => entry !== targetId) : [...current, targetId]
    ));
  }

  function handleItemClick(cardId: string, item: ItemDefinition, reservableAbilityId: string | null) {
    if (!reservableAbilityId) {
      setStatusMessage(`${item.displayName} は予約できません`);
      return;
    }
    void toggleAbilityReservation('ITEM', reservableAbilityId, cardId);
  }

  function toggleOverflowCard(cardId: string) {
    if (!pendingItemOverflow) {
      return;
    }
    setSelectedOverflowCardIds((current) => {
      if (current.includes(cardId)) {
        return current.filter((entry) => entry !== cardId);
      }
      if (current.length >= pendingItemOverflow.overflowCount) {
        return current;
      }
      return [...current, cardId];
    });
  }

  async function submitOverflowDiscard() {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/game/items/discard-overflow`, {
      method: 'POST',
      body: JSON.stringify({ cardIds: selectedOverflowCardIds }),
    });
    setSelectedOverflowCardIds([]);
    setShowOverflowConfirm(false);
  }

  function updateCustomRoleRange(roleId: string, key: 'min' | 'max', value: string) {
    setCustomRoleRanges((current) => ({
      ...current,
      [roleId]: {
        ...(current[roleId] ?? { min: '0', max: '0' }),
        [key]: value,
      },
    }));
  }

  function isLocalhost(): boolean {
    if (typeof window === 'undefined') return false;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  }

  async function handleAdminOpen() {
    if (!bootstrap?.requireAdminPassword || isLocalhost() || adminAuthenticated) {
      setAdminOpen((o) => !o);
      return;
    }
    setAdminPasswordDialogOpen(true);
  }

  async function submitAdminPassword() {
    try {
      const result = await fetchJson<{ ok: boolean }>(`${API_BASE}/api/admin/validate-password`, {
        method: 'POST',
        body: JSON.stringify({ password: adminPasswordInput }),
      });
      if (result.ok) {
        setAdminAuthenticated(true);
        setAdminPasswordDialogOpen(false);
        setAdminPasswordInput('');
        setAdminOpen(true);
      } else {
        setStatusMessage('パスワードが違います');
      }
    } catch {
      setStatusMessage('パスワード確認に失敗しました');
    }
  }

  function togglePanel(panel: 'role' | 'hobby' | 'item' | 'player' | 'spectator') {
    const states = {
      role: rolePanelCollapsed,
      hobby: hobbyPanelCollapsed,
      item: itemPanelCollapsed,
      player: playerPanelCollapsed,
      spectator: spectatorPanelCollapsed,
    };
    const expanding = states[panel];
    if (expanding && collapseOthersOnExpand) {
      setRolePanelCollapsed(panel !== 'role');
      setHobbyPanelCollapsed(panel !== 'hobby');
      setItemPanelCollapsed(panel !== 'item');
      setPlayerPanelCollapsed(panel !== 'player');
      setSpectatorPanelCollapsed(panel !== 'spectator');
    } else {
      if (panel === 'role') setRolePanelCollapsed((v) => !v);
      if (panel === 'hobby') setHobbyPanelCollapsed((v) => !v);
      if (panel === 'item') setItemPanelCollapsed((v) => !v);
      if (panel === 'player') setPlayerPanelCollapsed((v) => !v);
      if (panel === 'spectator') setSpectatorPanelCollapsed((v) => !v);
    }
  }

  return (
    <main className="app-shell">
      {game ? <div className="phase-timer">{game.dayNumber}日目 {phaseLabel(game.phase)} ({timerLabel})</div> : null}
      <div className="title-row">
        <img className="title-icon" src={`${API_BASE}/master-data-images/ui/superJinroh.png`} alt="" aria-hidden="true" />
        <h1 className="title">超級の人狼</h1>
        <span className="title-version">ver. {APP_VERSION}</span>
      </div>
      <p className="subtitle">能力付きアイテム人狼だよ！</p>
      <div className="controls-inline">
        <div className="badge">{statusMessage}</div>
        <button className="secondary" onClick={() => setPersonalOpen((o) => !o)}>個人設定</button>
        <button className="secondary" onClick={() => void handleAdminOpen()}>管理設定</button>
      </div>

      {adminPasswordDialogOpen ? (
        <div className="ability-overlay">
          <div className="ability-dialog card">
            <h2>管理設定のパスワード</h2>
            <div className="controls">
              <label className="setting-field">
                <div>パスワード</div>
                <input
                  type="password"
                  value={adminPasswordInput}
                  onChange={(e) => setAdminPasswordInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitAdminPassword(); }}
                />
              </label>
              <div className="controls-inline">
                <button className="secondary" onClick={() => { setAdminPasswordDialogOpen(false); setAdminPasswordInput(''); }}>キャンセル</button>
                <button className="primary" onClick={() => void submitAdminPassword()}>確認</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {personalOpen ? (
        <section style={{ marginTop: '24px' }}>
          <article className="card">
            <h2>個人設定</h2>
            <div className="controls">
              <div className="setting-row">
                <label className="setting-field">
                  <div>プレイヤー名</div>
                  <input value={displayName} maxLength={24} onChange={(event) => setDisplayName(event.target.value)} />
                </label>
                <button className="primary" onClick={() => void submitDisplayName()}>決定</button>
              </div>
              <label className="setting-checkbox-row">
                <input type="checkbox" checked={collapseOthersOnExpand} onChange={(e) => setCollapseOthersOnExpand(e.target.checked)} />
                <span>選択したパネル以外を縮小する</span>
              </label>
            </div>
          </article>
        </section>
      ) : null}

      {adminOpen && lobby ? (
        <section style={{ marginTop: '24px' }}>
          <article className="card">
            <h2>管理設定</h2>
            <div className="controls">
              {!isGameActive ? (
                <div className="setting-row">
                  <label className="setting-field">
                    <div>配役選択</div>
                    <select value={selectedRoleSetId} onChange={(event) => setSelectedRoleSetId(event.target.value)}>
                      {lobby.roleSets.map((roleSet) => (
                        <option key={roleSet.id} value={roleSet.id}>{roleSet.displayName}</option>
                      ))}
                      <option value="__custom__">新規作成</option>
                    </select>
                  </label>
                  <button className="primary" onClick={() => void submitRoleSet()}>決定</button>
                </div>
              ) : null}
              <div className="setting-row">
                <label className="setting-field">
                  <div>昼フェーズ秒数</div>
                  <input value={daySeconds} inputMode="numeric" onChange={(event) => setDaySeconds(event.target.value)} />
                </label>
                <label className="setting-field">
                  <div>夜フェーズ秒数</div>
                  <input value={nightSeconds} inputMode="numeric" onChange={(event) => setNightSeconds(event.target.value)} />
                </label>
                <button className="primary" onClick={() => void submitPhaseSettings()}>時間を保存</button>
              </div>
              {game ? (
                <div className="settings-actions">
                  <button className="secondary" onClick={() => void pauseGame()} disabled={game.isPaused}>一時停止</button>
                  <button className="danger" onClick={() => void endGame()}>ゲームを終了する</button>
                </div>
              ) : null}
            </div>
          </article>
        </section>
      ) : null}

      {customRoleSetOpen ? (
        <div className="ability-overlay">
          <div className="ability-dialog card custom-role-set-dialog">
            <h2>配役を新規作成</h2>
            <div className="controls">
              <label className="setting-field">
                <div>配役名</div>
                <input value={customRoleSetName} onChange={(event) => setCustomRoleSetName(event.target.value)} />
              </label>
              <div className="setting-row">
                <label className="setting-field">
                  <div>人数</div>
                  <input value={customRequiredPlayerCount} inputMode="numeric" onChange={(event) => setCustomRequiredPlayerCount(event.target.value)} />
                </label>
                <label className="setting-field">
                  <div>規定殺害数</div>
                  <input value={customMonsterWinRequiredKills} inputMode="numeric" onChange={(event) => setCustomMonsterWinRequiredKills(event.target.value)} />
                </label>
              </div>
              <div className="list custom-role-set-list">
                {bootstrap?.roles.map((role) => (
                  <div className="role-row" key={role.roleId}>
                    <span>{role.displayName}</span>
                    <div className="controls-inline compact">
                      <input
                        className="custom-role-range-input"
                        value={customRoleRanges[role.roleId]?.min ?? '0'}
                        inputMode="numeric"
                        onChange={(event) => updateCustomRoleRange(role.roleId, 'min', event.target.value)}
                      />
                      <span>~</span>
                      <input
                        className="custom-role-range-input"
                        value={customRoleRanges[role.roleId]?.max ?? '0'}
                        inputMode="numeric"
                        onChange={(event) => updateCustomRoleRange(role.roleId, 'max', event.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="controls-inline">
                <button className="secondary" onClick={() => setCustomRoleSetOpen(false)}>閉じる</button>
                <button className="primary" onClick={() => void submitCustomRoleSet()}>保存</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {lobby && !isGameActive ? (
        <section className="grid two" style={{ marginTop: '24px' }}>
          <article className="card">
            <h2>ロビー</h2>
            <div className="list">
              {lobby.participants.map((participant) => (
                <div className={`player-row${participant.isSelf ? ' is-self' : ''}`} key={participant.connectionId}>
                  <span className="player-name-with-tag">
                    <span>{participant.displayName}</span>
                    {participant.isSelf ? <span className="self-tag">あなた</span> : null}
                  </span>
                  <span className="badge">{participant.isConnected ? '接続中' : '切断'}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <h2>配役({lobby.selectedRoleSet?.requiredPlayerCount ?? '-'}人)</h2>
            <RoleSetSummary roleSet={lobby.selectedRoleSet} roleCatalog={roleCatalog} interactiveRoles abilityCatalog={abilityCatalog} />
            <div className="controls" style={{ marginTop: '20px' }}>
              <button className="primary" onClick={() => void startGame()} disabled={!lobby.canStart}>ゲーム開始</button>
              {!lobby.canStart ? <div className="warning">{lobby.cannotStartReason}</div> : null}
            </div>
          </article>
        </section>
      ) : null}

      {game ? (
        <>
          {game.pendingAbilityPrompt ? (
            <div className="ability-overlay">
              <div className="ability-dialog card">
                <h2>{game.pendingAbilityPrompt.displayName}</h2>
                <p className="section-note">{game.pendingAbilityPrompt.description}</p>
                {game.pendingAbilityPrompt.promptType === 'CONFIRM' ? (
                  <div className="controls-inline">
                    {game.pendingAbilityPrompt.canCancel ? (
                      <button className="secondary" onClick={() => void resolveAbilityPrompt(false)}>使わない</button>
                    ) : null}
                    <button className="primary" onClick={() => void resolveAbilityPrompt(true)}>確認</button>
                  </div>
                ) : (
                  <div className="controls">
                    {game.pendingAbilityPrompt.maxTargets > 1 ? (
                      <div className="list">
                        {game.pendingAbilityPrompt.options.map((option) => (
                          <label className="target-option" key={option.id}>
                            <input type="checkbox" checked={selectedPromptTargets.includes(option.id)} onChange={() => togglePromptTarget(option.id)} />
                            <span>{option.displayName}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <select value={selectedPromptTargets[0] ?? ''} onChange={(event) => setSelectedPromptTargets(event.target.value ? [event.target.value] : [])}>
                        {game.pendingAbilityPrompt.options.map((option) => (
                          <option key={option.id} value={option.id}>{option.displayName}</option>
                        ))}
                      </select>
                    )}
                    <button className="primary" onClick={() => void submitPromptTargets()} disabled={selectedPromptTargets.length !== game.pendingAbilityPrompt.maxTargets}>決定</button>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {showOverflowConfirm && pendingItemOverflow ? (
            <div className="ability-overlay">
              <div className="ability-dialog card">
                <h2>アイテム破棄</h2>
                <p className="section-note">{`${selectedOverflowItems.map((card) => card.displayName).join(', ')}を破棄します。よろしいですか？`}</p>
                <div className="controls-inline">
                  <button className="secondary" onClick={() => setShowOverflowConfirm(false)}>戻る</button>
                  <button className="danger" onClick={() => void submitOverflowDiscard()}>破棄する</button>
                </div>
              </div>
            </div>
          ) : null}

          {game.isPaused ? (
            <div className="pause-overlay">
              <div className="pause-dialog">
                <strong>一時停止中</strong>
                <button className="primary" onClick={() => void resumeGame()}>再開</button>
              </div>
            </div>
          ) : null}

          <section className="game-dashboard" style={{ marginTop: '24px' }}>
            <aside className="game-sidebar">
              {isSpectator ? <SpectatorInfoCard collapsed={spectatorPanelCollapsed} onToggle={() => togglePanel('spectator')} /> : null}
              {!isSpectator && myRole ? (
                <MasterInfoBlock
                  title="役職"
                  displayName={myRole.displayName}
                  description={myRole.description}
                  imagePath={myRole.imagePath}
                  faction={myRole.faction}
                  abilityIds={game.myRoleAbilityIds}
                  abilityCatalog={abilityCatalog}
                  sourceType="ROLE"
                  sourceId={myRole.roleId}
                  availableAbilityKeys={availableAbilityKeySet}
                  reservedAbilityKeys={reservedAbilityKeySet}
                  onAbilityClick={(abilityId) => void toggleAbilityReservation('ROLE', abilityId)}
                  collapsed={rolePanelCollapsed}
                  onToggle={() => togglePanel('role')}
                  collapsedTitle={`役職：${myRole.displayName}`}
                  collapsedTitleAddon={<FactionBadge faction={myRole.faction} />}
                  titleHoverLabel="（配役表）"
                  titleHoverContent={
                    <RoleSetSummary
                      roleSet={activeRoleSet}
                      roleCatalog={roleCatalog}
                      abilityCatalog={abilityCatalog}
                      showResolvedCount={game.status === 'FINISHED'}
                    />
                  }
                />
              ) : null}
              {!isSpectator && myHobby ? (
                <MasterInfoBlock
                  title="趣味"
                  displayName={myHobby.displayName}
                  description={myHobby.description}
                  imagePath={myHobby.imagePath}
                  hobbyType={myHobby.hobbyType}
                  abilityIds={game.myHobbyAbilityIds}
                  abilityCatalog={abilityCatalog}
                  sourceType="HOBBY"
                  sourceId={myHobby.hobbyId}
                  remainingUseCount={game.myHobbyUseCountRemaining}
                  availableAbilityKeys={availableAbilityKeySet}
                  reservedAbilityKeys={reservedAbilityKeySet}
                  onAbilityClick={(abilityId) => void toggleAbilityReservation('HOBBY', abilityId)}
                  collapsed={hobbyPanelCollapsed}
                  onToggle={() => togglePanel('hobby')}
                  collapsedTitle={`趣味：${myHobby.displayName}`}
                  collapsedTitleAddon={<HobbyTypeBadge hobbyType={myHobby.hobbyType} />}
                />
              ) : null}
            </aside>

            <div className="game-content">
              {game.status === 'FINISHED' ? (
                <article className="card">
                  <h2>結果</h2>
                  <RoleSetSummary roleSet={activeRoleSet} roleCatalog={roleCatalog} abilityCatalog={abilityCatalog} showRoleSetName={false} showResolvedCount />
                </article>
              ) : null}

              <article
                className={`card item-section-card${pendingItemOverflow ? ' is-overflow' : ''}${itemPanelCollapsed ? ' is-collapsed is-collapsed-clickable' : ''}`}
                onClick={itemPanelCollapsed ? () => togglePanel('item') : undefined}
                role={itemPanelCollapsed ? 'button' : undefined}
                tabIndex={itemPanelCollapsed ? 0 : undefined}
                onKeyDown={itemPanelCollapsed ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    togglePanel('item');
                  }
                } : undefined}
              >
                <div className="title-with-badge panel-title-row">
                  <h2>
                    {pendingItemOverflow ? 'アイテム(超過-破棄対象を選択)' : (
                      <><span>アイテム</span><ItemIcons count={game.myItemCards.length} /></>
                    )}
                  </h2>
                  <ResizeButton collapsed={itemPanelCollapsed} onToggle={() => togglePanel('item')} />
                </div>
                {!itemPanelCollapsed && (
                  <div className="item-grid">
                  {game.myItemCards.map((card) => {
                    const itemDefinition = itemCatalog.get(card.itemId);
                    const imageUrl = mediaUrl(itemDefinition?.imagePath ?? null);
                    const manualTimings = (itemDefinition?.abilityIds ?? [])
                      .map((abilityId) => abilityCatalog.get(abilityId))
                      .filter((ability): ability is AbilityDefinition => Boolean(ability && isManualAbility(ability)))
                      .map((ability) => activationTimingLabel(ability.timing));
                    const reservableAbilityId = itemDefinition?.abilityIds.find((abilityId) => {
                      const ability = abilityCatalog.get(abilityId);
                      if (!ability || !isManualAbility(ability)) {
                        return false;
                      }
                      const abilityKey = buildAbilityKey('ITEM', card.itemId, abilityId, card.cardId);
                      return availableAbilityKeySet.has(abilityKey);
                    }) ?? null;
                    const reservable = Boolean(reservableAbilityId);
                    const isSelectedForDiscard = selectedOverflowCardIds.includes(card.cardId);
                    const isReserved = card.reservedAbilityId !== null;

                    return (
                      <button
                        className={`item-card${reservable ? ' actionable' : ''}${card.isActivating ? ' is-activating' : ''}${isReserved ? ' is-reserved' : ''}${pendingItemOverflow ? ' is-overflow-target' : ''}${isSelectedForDiscard ? ' is-selected-for-discard' : ''}`}
                        key={card.cardId}
                        type="button"
                        disabled={pendingItemOverflow ? false : !reservable || game.isPaused || card.isActivating}
                        onClick={() => {
                          if (pendingItemOverflow) {
                            toggleOverflowCard(card.cardId);
                            return;
                          }
                          if (itemDefinition) {
                            handleItemClick(card.cardId, itemDefinition, reservableAbilityId);
                          }
                        }}
                      >
                        {imageUrl ? (
                          <img className="item-card-image" src={imageUrl} alt={itemDefinition?.displayName ?? card.displayName} />
                        ) : (
                          <div className="item-card-image placeholder">NO IMAGE</div>
                        )}
                        <div className="master-card-body">
                          <strong>{itemDefinition?.displayName ?? card.displayName}</strong>
                          <AbilityList
                            abilityIds={itemDefinition?.abilityIds ?? []}
                            abilityCatalog={abilityCatalog}
                            sourceType="ITEM"
                            sourceId={card.itemId}
                            itemCardId={card.cardId}
                            availableAbilityKeys={availableAbilityKeySet}
                            reservedAbilityKeys={reservedAbilityKeySet}
                            showReservedOverlay={false}
                          />
                          {itemDefinition?.description ? <p className="item-description">{itemDefinition.description}</p> : null}
                          {manualTimings.length > 0 ? <div className="item-activation-timing">宣言: {manualTimings.join(' / ')}</div> : null}
                          {pendingItemOverflow ? (
                            <div className="section-note">{isSelectedForDiscard ? '破棄候補に選択中' : 'クリックで破棄候補に選択'}</div>
                          ) : null}
                          {card.isActivating ? <div className="section-note">起動中</div> : null}
                        </div>
                        {isReserved ? (
                          <div className="reservation-overlay" aria-hidden="true">
                            <span className="reservation-pill">宣言予約中</span>
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                )}
              </article>
            </div>
          </section>

          <section className="player-area" style={{ marginTop: '24px' }}>
            <article
              className={`card player-list-card${playerPanelCollapsed ? ' is-collapsed is-collapsed-clickable' : ''}`}
              onClick={playerPanelCollapsed ? () => togglePanel('player') : undefined}
              role={playerPanelCollapsed ? 'button' : undefined}
              tabIndex={playerPanelCollapsed ? 0 : undefined}
              onKeyDown={playerPanelCollapsed ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  togglePanel('player');
                }
              } : undefined}
            >
              <div className="title-with-badge panel-title-row">
                <h2>プレイヤー一覧</h2>
                <ResizeButton collapsed={playerPanelCollapsed} onToggle={() => togglePanel('player')} />
              </div>
              {!playerPanelCollapsed && (
                <div className="section-note">生存中：{aliveCount}/{game.players.length}</div>
              )}
              <div className="list" style={{ marginTop: '16px' }}>
                {game.players.map((player) => {
                  const publicHobby = hobbyCatalog.get(player.publicHobbyId);
                  const publicRole = player.publicRoleId ? roleCatalog.get(player.publicRoleId) : null;
                  const isSelf = player.id === selfPlayerId;
                  const selfRole = isSelf && game.status !== 'FINISHED' && player.roleId
                    ? roleCatalog.get(player.roleId)?.displayName ?? player.roleId
                    : null;
                  const roleLabel = selfRole ?? (game.knownMonsterPlayerId === player.id && game.status !== 'FINISHED'
                    ? '怪物'
                    : publicRole?.displayName ?? '不明');
                  const isHighlightedRole = Boolean(selfRole)
                    || (game.knownMonsterPlayerId === player.id && game.status !== 'FINISHED')
                    || Boolean(player.publicRoleId && game.status !== 'FINISHED');
                  const showPrivateDeathCause = isSelf && game.status !== 'FINISHED' && (player.deathCause === 'LINE_OF_DUTY' || player.deathCause === 'EXORCISM');
                  return (
                    <div className={`player-row player-status-row hobby-hover-target${player.status === 'DEAD' ? ' is-dead' : ''}${isSelf ? ' is-self' : ''}`} key={player.id}>
                      {playerPanelCollapsed ? (
                        <div className="player-name-with-tag">
                          <span>{player.displayName}{player.isConnected ? '' : ' (切断)'} &lt;{roleLabel}&gt;</span>
                          <ItemIcons count={player.itemCount} className="player-item-icon" />
                          {player.stateTags.map((state) => (
                            <span className={`player-state-tag ${playerStateTagClass(state)}`} key={state}>{playerStateTagLabel(state)}</span>
                          ))}
                        </div>
                      ) : (
                        <div className="player-summary">
                          <div className="player-name-with-tag">
                            <span>{player.displayName}{player.isConnected ? '' : ' (切断)'}</span>
                            {isSelf ? <span className="self-tag">あなた</span> : null}
                            {player.stateTags.map((state) => (
                              <span className={`player-state-tag ${playerStateTagClass(state)}`} key={state}>{playerStateTagLabel(state)}</span>
                            ))}
                          </div>
                          <div className="section-note player-meta-line">
                            <span className="player-meta-cell player-meta-role">
                              <span className="player-meta-label">役職:</span>
                              <span className={`player-meta-value player-role-value${isHighlightedRole ? ' is-cultist-known' : ''}`}>{roleLabel}</span>
                            </span>
                            <span className="player-meta-cell player-meta-item">
                              <span className="player-meta-label">アイテム:</span>
                              <span className="player-meta-value">{player.itemCount}個</span>
                            </span>
                            <span className="player-meta-cell player-meta-hobby">
                              <span className="player-meta-label">趣味:</span>
                              <span className="player-meta-value">{publicHobby?.displayName ?? player.publicHobbyId}</span>
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="controls-inline compact player-status-actions">
                        {!playerPanelCollapsed && (
                          <div className="section-note">{renderPlayerStatusLabel(player.status, player.deathCause, player.resultStatus, game.status === 'FINISHED', showPrivateDeathCause)}</div>
                        )}
                        {game.phase === 'VOTE' ? (
                          <button className="secondary" onClick={() => void submitVote(player.id)} disabled={player.status !== 'ALIVE' || game.isPaused || player.id === selfPlayerId || game.myVoteTargetId !== null}>投票</button>
                        ) : null}
                      </div>
                      <HobbyTooltip hobbyDefinition={publicHobby} abilityCatalog={abilityCatalog} />
                    </div>
                  );
                })}
              </div>
            </article>
          </section>

          <div
            className={`bottom-log-bar${logExpanded ? ' is-expanded' : ''}`}
            onClick={() => setLogExpanded((v) => !v)}
          >
            <div className="bottom-log-list">
              {visibleLogs.map((entry) => (
                <div
                  className={`bottom-log-entry${entry.isPrivate ? ' is-private' : ''}${flashedLogIds.includes(entry.id) ? ' is-flashing' : ''}`}
                  key={entry.id}
                >
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {!bootstrap ? <div style={{ marginTop: '24px' }}>初期化中...</div> : null}
    </main>
  );
}
