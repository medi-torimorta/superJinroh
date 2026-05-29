import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../../package.json';
const DEFAULT_PORT = 11037;
const CLIENT_ID_STORAGE_KEY = 'super-jinroh-client-id';
const CLIENT_ID_HEADER = 'x-super-jinroh-client-id';
function getApiBase() {
    const configured = import.meta.env.VITE_API_BASE?.trim();
    if (configured) {
        return configured;
    }
    if (typeof window !== 'undefined') {
        return window.location.origin;
    }
    return `http://localhost:${DEFAULT_PORT}`;
}
function createClientId() {
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
function getClientId() {
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
function getWsUrl(clientId) {
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
function mediaUrl(imagePath) {
    return imagePath ? `${API_BASE}${imagePath}` : null;
}
function phaseLabel(phase) {
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
function statusLabel(status) {
    if (status === 'ALIVE') {
        return '生存';
    }
    if (status === 'DYING') {
        return '瀕死';
    }
    return '死亡';
}
function playerStateTagLabel(state) {
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
function playerStateTagClass(state) {
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
function activationTimingLabel(timing) {
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
function deathCauseLabel(cause, revealActualCause) {
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
function playerResultLabel(status, resultStatus) {
    if (!resultStatus) {
        return statusLabel(status);
    }
    return `${resultStatus === 'WIN' ? '勝利' : '敗北'} (${statusLabel(status)})`;
}
function formatPlayerStatusLabel(status, deathCause, resultStatus, revealActualCause) {
    const baseStatus = status === 'DEAD' ? `死亡 (${deathCauseLabel(deathCause, revealActualCause)})` : statusLabel(status);
    if (!resultStatus) {
        return baseStatus;
    }
    return `${resultStatus === 'WIN' ? '勝利' : '敗北'} (${baseStatus})`;
}
function renderPlayerStatusLabel(status, deathCause, resultStatus, revealActualCause, showActualHiddenCause) {
    if (!showActualHiddenCause || status !== 'DEAD' || !deathCause || (deathCause !== 'LINE_OF_DUTY' && deathCause !== 'EXORCISM')) {
        return formatPlayerStatusLabel(status, deathCause, resultStatus, revealActualCause);
    }
    const deathLabel = (_jsxs(_Fragment, { children: ["\u6B7B\u4EA1 (", _jsx("span", { className: "player-private-death-cause", children: deathCauseLabel(deathCause, true) }), ")"] }));
    if (!resultStatus) {
        return deathLabel;
    }
    return (_jsxs(_Fragment, { children: [resultStatus === 'WIN' ? '勝利' : '敗北', " (", deathLabel, ")"] }));
}
function formatRoleCountRange(role) {
    return role.min === role.max ? String(role.min) : `${role.min}~${role.max}`;
}
function formatDisplayedRoleCount(role, showResolvedCount) {
    if (showResolvedCount && typeof role.resolvedCount === 'number') {
        return `${role.resolvedCount} (${formatRoleCountRange(role)})`;
    }
    return formatRoleCountRange(role);
}
function factionLabel(faction) {
    if (faction === 'HUMAN') {
        return '人間';
    }
    if (faction === 'MONSTER') {
        return '人外';
    }
    return '邪神';
}
function hobbyTypeLabel(hobbyType) {
    if (hobbyType === 'SKILL') {
        return '技能';
    }
    if (hobbyType === 'SPELL') {
        return '呪文';
    }
    return '特殊';
}
function abilityTypeLabel(abilityType) {
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
function buildAbilityKey(sourceType, sourceId, abilityId, itemCardId = null) {
    return [sourceType, sourceId, abilityId, itemCardId ?? ''].join('::');
}
function formatRemainingTime(targetIso) {
    if (!targetIso) {
        return '0:00';
    }
    const remainingMs = Math.max(0, new Date(targetIso).getTime() - Date.now());
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
function FactionBadge({ faction }) {
    return _jsx("span", { className: `faction-badge faction-${faction.toLowerCase()}`, children: factionLabel(faction) });
}
function HobbyTypeBadge({ hobbyType }) {
    return _jsx("span", { className: `hobby-type-badge hobby-type-${hobbyType.toLowerCase()}`, children: hobbyTypeLabel(hobbyType) });
}
function AbilityTypeBadge({ abilityType }) {
    return _jsx("span", { className: `ability-type-badge ability-type-${abilityType.toLowerCase()}`, children: abilityTypeLabel(abilityType) });
}
function isManualAbility(ability) {
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
function AbilityList({ abilityIds, abilityCatalog, sourceType, sourceId, itemCardId = null, availableAbilityKeys, reservedAbilityKeys, showReservedOverlay = true, onAbilityClick, }) {
    if (abilityIds.length === 0) {
        return null;
    }
    return (_jsx("div", { className: "ability-list", children: abilityIds.map((abilityId) => {
            const ability = abilityCatalog.get(abilityId);
            if (!ability) {
                return null;
            }
            const abilityKey = sourceType && sourceId ? buildAbilityKey(sourceType, sourceId, abilityId, itemCardId) : null;
            const isAvailable = abilityKey ? availableAbilityKeys?.has(abilityKey) ?? false : false;
            const isReserved = abilityKey ? reservedAbilityKeys?.has(abilityKey) ?? false : false;
            const showAvailableBorder = isAvailable && sourceType !== 'ITEM';
            return (_jsxs("div", { className: `ability-entry${showAvailableBorder ? ' is-available' : ''}${isReserved ? ' is-reserved' : ''}${isAvailable && onAbilityClick ? ' is-clickable' : ''}`, onClick: isAvailable && onAbilityClick ? () => onAbilityClick(ability.abilityId, itemCardId) : undefined, role: isAvailable && onAbilityClick ? 'button' : undefined, tabIndex: isAvailable && onAbilityClick ? 0 : undefined, children: [_jsxs("div", { className: "title-with-badge ability-line", children: [_jsx("strong", { children: sourceType === 'ITEM' ? '効果' : ability.displayName }), sourceType !== 'ROLE' ? _jsx(AbilityTypeBadge, { abilityType: ability.abilityType }) : null, _jsx("span", { className: "ability-description-inline", children: ability.description })] }), isReserved && showReservedOverlay ? (_jsx("div", { className: "reservation-overlay", "aria-hidden": "true", children: _jsx("span", { className: "reservation-pill", children: "\u5BA3\u8A00\u4E88\u7D04\u4E2D" }) })) : null] }, ability.abilityId));
        }) }));
}
function RoleTooltip({ roleDefinition, abilityCatalog, }) {
    if (!roleDefinition) {
        return null;
    }
    const imageUrl = mediaUrl(roleDefinition.imagePath);
    return (_jsxs("div", { className: "role-tooltip", children: [imageUrl ? (_jsx("img", { className: "role-tooltip-image", src: imageUrl, alt: roleDefinition.displayName })) : (_jsx("div", { className: "role-tooltip-image placeholder", children: "NO IMAGE" })), _jsxs("div", { className: "role-tooltip-body", children: [_jsxs("div", { className: "title-with-badge", children: [_jsx("strong", { children: roleDefinition.displayName }), _jsx(FactionBadge, { faction: roleDefinition.faction })] }), _jsx("p", { children: roleDefinition.description }), _jsx(AbilityList, { abilityIds: roleDefinition.abilityIds, abilityCatalog: abilityCatalog, sourceType: "ROLE", sourceId: roleDefinition.roleId })] })] }));
}
function HobbyTooltip({ hobbyDefinition, abilityCatalog, }) {
    if (!hobbyDefinition) {
        return null;
    }
    const imageUrl = mediaUrl(hobbyDefinition.imagePath);
    return (_jsxs("div", { className: "role-tooltip hobby-tooltip", children: [imageUrl ? (_jsx("img", { className: "role-tooltip-image", src: imageUrl, alt: hobbyDefinition.displayName })) : (_jsx("div", { className: "role-tooltip-image placeholder", children: "NO IMAGE" })), _jsxs("div", { className: "role-tooltip-body", children: [_jsxs("div", { className: "title-with-badge", children: [_jsx("strong", { children: hobbyDefinition.displayName }), _jsx(HobbyTypeBadge, { hobbyType: hobbyDefinition.hobbyType })] }), _jsx("p", { children: hobbyDefinition.description }), _jsx(AbilityList, { abilityIds: hobbyDefinition.abilityIds, abilityCatalog: abilityCatalog, sourceType: "HOBBY", sourceId: hobbyDefinition.displayName })] })] }));
}
function RoleRowTrigger({ roleDefinition, countLabel, abilityCatalog, }) {
    const [open, setOpen] = useState(false);
    if (!roleDefinition) {
        return null;
    }
    return (_jsxs("div", { className: `role-row role-row-trigger${open ? ' is-open' : ''}`, onClick: () => setOpen((value) => !value), onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false), children: [_jsxs("div", { className: "role-row-main", children: [_jsx("span", { children: roleDefinition.displayName }), _jsx("span", { children: countLabel })] }), _jsx(RoleTooltip, { roleDefinition: roleDefinition, abilityCatalog: abilityCatalog })] }));
}
function RoleSetRoleList({ roleSet, roleCatalog, interactiveRoles, abilityCatalog, showResolvedCount = false, }) {
    return (_jsx("div", { className: "list", children: roleSet?.roles.map((role) => {
            const roleDefinition = roleCatalog.get(role.roleId);
            const countLabel = formatDisplayedRoleCount(role, showResolvedCount);
            return (interactiveRoles ? (_jsx(RoleRowTrigger, { roleDefinition: roleDefinition, countLabel: countLabel, abilityCatalog: abilityCatalog }, role.roleId)) : (_jsxs("div", { className: "role-row", children: [_jsx("span", { children: roleDefinition?.displayName ?? role.roleId }), _jsx("span", { children: countLabel })] }, role.roleId)));
        }) }));
}
function RoleSetSummary({ roleSet, roleCatalog, interactiveRoles = false, abilityCatalog, showRoleSetName = true, showResolvedCount = false, }) {
    return (_jsxs("div", { className: "role-set-summary", children: [_jsxs("div", { className: "role-set-meta", children: [showRoleSetName ? (_jsxs("div", { className: "role-set-highlight", children: [_jsx("span", { className: "role-set-label", children: "\u914D\u5F79\u540D" }), _jsx("span", { className: "role-set-value", children: roleSet?.displayName ?? '未選択' })] })) : null, _jsxs("div", { className: "role-set-highlight", children: [_jsx("span", { className: "role-set-label", children: "\u898F\u5B9A\u6BBA\u5BB3\u4EBA\u6570" }), _jsx("span", { className: "role-set-value", children: roleSet?.monsterWinRequiredKills ?? '-' })] })] }), _jsx(RoleSetRoleList, { roleSet: roleSet, roleCatalog: roleCatalog, interactiveRoles: interactiveRoles, abilityCatalog: abilityCatalog, showResolvedCount: showResolvedCount })] }));
}
function RoleSetTooltip({ roleSet, roleCatalog, abilityCatalog, showResolvedCount = false, }) {
    if (!roleSet) {
        return null;
    }
    return (_jsx("div", { className: "role-tooltip role-set-tooltip", children: _jsx(RoleSetSummary, { roleSet: roleSet, roleCatalog: roleCatalog, abilityCatalog: abilityCatalog, showRoleSetName: false, showResolvedCount: showResolvedCount }) }));
}
function ResizeButton({ collapsed, onToggle }) {
    const [imgFailed, setImgFailed] = useState(false);
    return (_jsx("button", { className: "panel-resize-btn", type: "button", title: collapsed ? '拡大' : '縮小', onClick: (e) => { e.stopPropagation(); onToggle(); }, children: !imgFailed ? (_jsx("img", { src: `${API_BASE}/master-data-images/ui/resize.webp`, alt: "", className: "panel-resize-img", onError: () => setImgFailed(true) })) : (_jsx("span", { children: "\u25CF" })) }));
}
function ItemIcons({ count, className }) {
    const [imgFailed, setImgFailed] = useState(false);
    if (count === 0 || imgFailed)
        return null;
    return (_jsx(_Fragment, { children: Array.from({ length: count }, (_, i) => (_jsx("img", { src: `${API_BASE}/master-data-images/ui/item.webp`, alt: "", className: `item-icon-tiny${className ? ` ${className}` : ''}`, onError: i === 0 ? () => setImgFailed(true) : undefined }, i))) }));
}
function MasterInfoBlock({ title, displayName, description, imagePath, faction, hobbyType, abilityIds, abilityCatalog, sourceType, sourceId, availableAbilityKeys, reservedAbilityKeys, onAbilityClick, collapsed, onToggle, collapsedTitle, collapsedTitleAddon, titleHoverLabel, titleHoverContent, }) {
    const imageUrl = mediaUrl(imagePath);
    const shownTitle = collapsed && collapsedTitle ? collapsedTitle : title;
    return (_jsxs("article", { className: `card master-card${collapsed ? ' is-collapsed is-collapsed-clickable' : ''}`, onClick: collapsed ? onToggle : undefined, role: collapsed ? 'button' : undefined, tabIndex: collapsed ? 0 : undefined, onKeyDown: collapsed ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle();
            }
        } : undefined, children: [_jsxs("div", { className: "title-with-badge panel-title-row", children: [_jsxs("div", { className: "master-title-main", children: [_jsx("h2", { children: shownTitle }), collapsed && collapsedTitleAddon ? _jsx("span", { className: "master-title-addon", children: collapsedTitleAddon }) : null, !collapsed && titleHoverLabel && titleHoverContent ? (_jsxs("span", { className: "panel-hover-label-wrapper", children: [_jsx("span", { className: "panel-hover-label", children: titleHoverLabel }), _jsx("div", { className: "panel-floating-role-set", children: titleHoverContent })] })) : null] }), _jsx(ResizeButton, { collapsed: collapsed, onToggle: onToggle })] }), !collapsed && (_jsxs(_Fragment, { children: [imageUrl ? (_jsx("img", { className: "master-card-image", src: imageUrl, alt: displayName })) : (_jsx("div", { className: "master-card-image placeholder", children: "NO IMAGE" })), _jsxs("div", { className: "master-card-body", children: [_jsxs("div", { className: "title-with-badge", children: [_jsx("strong", { children: displayName }), faction ? _jsx(FactionBadge, { faction: faction }) : null, hobbyType ? _jsx(HobbyTypeBadge, { hobbyType: hobbyType }) : null] }), _jsx("p", { children: description }), _jsx(AbilityList, { abilityIds: abilityIds, abilityCatalog: abilityCatalog, sourceType: sourceType, sourceId: sourceId, itemCardId: null, availableAbilityKeys: availableAbilityKeys, reservedAbilityKeys: reservedAbilityKeys, onAbilityClick: onAbilityClick })] })] }))] }));
}
function SpectatorInfoBlock() {
    const [showImage, setShowImage] = useState(true);
    const imageUrl = `${API_BASE}/master-data-images/ui/spectator.webp`;
    return (_jsxs("article", { className: "card master-card spectator-card", children: [_jsx("div", { className: "title-with-badge panel-title-row", children: _jsx("h2", { children: "\u89B3\u6226\u4E2D" }) }), showImage ? (_jsx("img", { className: "master-card-image", src: imageUrl, alt: "\u89B3\u6226\u4E2D", onError: () => setShowImage(false) })) : (_jsx("div", { className: "master-card-image placeholder", children: "\u89B3\u6226\u4E2D" })), _jsxs("div", { className: "master-card-body", children: [_jsx("strong", { children: "\u89B3\u6226\u4E2D" }), _jsx("p", { className: "spectator-card-note", children: "\u3053\u306E\u30B2\u30FC\u30E0\u3067\u306F\u5F79\u8077\u3068\u8DA3\u5473\u306E\u60C5\u5831\u306F\u8868\u793A\u3055\u308C\u307E\u305B\u3093\u3002" })] })] }));
}
function SpectatorInfoCard({ collapsed, onToggle }) {
    const [showImage, setShowImage] = useState(true);
    const imageUrl = `${API_BASE}/master-data-images/ui/spectator.webp`;
    return (_jsxs("article", { className: `card master-card spectator-card${collapsed ? ' is-collapsed is-collapsed-clickable' : ''}`, onClick: collapsed ? onToggle : undefined, role: collapsed ? 'button' : undefined, tabIndex: collapsed ? 0 : undefined, onKeyDown: collapsed ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle();
            }
        } : undefined, children: [_jsxs("div", { className: "title-with-badge panel-title-row", children: [_jsx("h2", { children: "\u89B3\u6226\u4E2D" }), _jsx(ResizeButton, { collapsed: collapsed, onToggle: onToggle })] }), !collapsed ? (_jsxs(_Fragment, { children: [showImage ? (_jsx("img", { className: "master-card-image", src: imageUrl, alt: "\u89B3\u6226\u4E2D", onError: () => setShowImage(false) })) : (_jsx("div", { className: "master-card-image placeholder", children: "\u89B3\u6226\u4E2D" })), _jsxs("div", { className: "master-card-body", children: [_jsx("strong", { children: "\u89B3\u6226\u4E2D" }), _jsx("p", { className: "spectator-card-note", children: "\u3053\u306E\u30B2\u30FC\u30E0\u3067\u306F\u5F79\u8077\u3068\u8DA3\u5473\u306E\u60C5\u5831\u306F\u8868\u793A\u3055\u308C\u307E\u305B\u3093\u3002" })] })] })) : null] }));
}
async function fetchJson(url, init) {
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
    return response.json();
}
export function App() {
    const [bootstrap, setBootstrap] = useState(null);
    const [appState, setAppState] = useState('LOBBY');
    const [phaseSettings, setPhaseSettings] = useState({ daySeconds: 300, nightSeconds: 90 });
    const [lobby, setLobby] = useState(null);
    const [game, setGame] = useState(null);
    const [displayName, setDisplayName] = useState('');
    const [statusMessage, setStatusMessage] = useState('loading...');
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
    const [selectedPromptTargets, setSelectedPromptTargets] = useState([]);
    const [flashedLogIds, setFlashedLogIds] = useState([]);
    const [selectedOverflowCardIds, setSelectedOverflowCardIds] = useState([]);
    const [showOverflowConfirm, setShowOverflowConfirm] = useState(false);
    const [customRoleSetOpen, setCustomRoleSetOpen] = useState(false);
    const [customRoleSetName, setCustomRoleSetName] = useState('');
    const [customRequiredPlayerCount, setCustomRequiredPlayerCount] = useState('5');
    const [customMonsterWinRequiredKills, setCustomMonsterWinRequiredKills] = useState('2');
    const [customRoleRanges, setCustomRoleRanges] = useState({});
    const previousLogIdsRef = useRef([]);
    useEffect(() => {
        void (async () => {
            try {
                const data = await fetchJson(`${API_BASE}/api/bootstrap`);
                setBootstrap(data);
                setAppState(data.appState);
                setPhaseSettings(data.phaseSettings);
                setDaySeconds(String(data.phaseSettings.daySeconds));
                setNightSeconds(String(data.phaseSettings.nightSeconds));
                setLobby(data.lobby);
                setDisplayName(data.self.displayName);
                setSelectedRoleSetId(data.lobby.selectedRoleSetId ?? '');
                setStatusMessage('connected');
            }
            catch (error) {
                setStatusMessage(error instanceof Error ? error.message : 'bootstrap failed');
            }
        })();
    }, []);
    useEffect(() => {
        const socket = new WebSocket(WS_URL);
        socket.onopen = () => setStatusMessage('websocket connected');
        socket.onmessage = (event) => {
            const parsed = JSON.parse(event.data);
            if (parsed.event === 'lobby.snapshot' || parsed.event === 'lobby.updated') {
                const nextLobby = parsed.payload;
                setLobby(nextLobby);
                setSelectedRoleSetId(nextLobby.selectedRoleSetId ?? '');
            }
            if (parsed.event === 'game.snapshot') {
                const nextGame = parsed.payload;
                setGame(nextGame);
                setPhaseSettings(nextGame.phaseSettings);
                setDaySeconds(String(nextGame.phaseSettings.daySeconds));
                setNightSeconds(String(nextGame.phaseSettings.nightSeconds));
                setAppState('IN_PROGRESS');
            }
            if (parsed.event === 'game.finished') {
                const payload = parsed.payload;
                setStatusMessage(payload.reason);
            }
            if (parsed.event === 'game.cleared') {
                const payload = parsed.payload;
                setGame(null);
                setAppState('LOBBY');
                if (payload.reason) {
                    setStatusMessage(payload.reason);
                }
            }
            if (parsed.event === 'settings.updated') {
                const settings = parsed.payload;
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
    const selectedOverflowItems = useMemo(() => game?.myItemCards.filter((card) => selectedOverflowCardIds.includes(card.cardId)) ?? [], [game, selectedOverflowCardIds]);
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
        const payload = await fetchJson(`${API_BASE}/api/me/display-name`, {
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
        const payload = await fetchJson(`${API_BASE}/api/lobby/selected-role-set`, {
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
            const payload = await fetchJson(`${API_BASE}/api/role-sets/custom`, {
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
        }
        catch (error) {
            setStatusMessage(error instanceof Error ? error.message : 'カスタム配役の保存に失敗しました');
        }
    }
    async function startGame() {
        await fetchJson(`${API_BASE}/api/lobby/start`, { method: 'POST' });
        setAppState('IN_PROGRESS');
        setAdminOpen(false);
    }
    async function pauseGame() {
        await fetchJson(`${API_BASE}/api/game/pause`, { method: 'POST' });
    }
    async function resumeGame() {
        await fetchJson(`${API_BASE}/api/game/resume`, { method: 'POST' });
    }
    async function endGame() {
        if (!window.confirm('進行中ゲームを終了してロビーに戻りますか？')) {
            return;
        }
        await fetchJson(`${API_BASE}/api/game/end`, { method: 'POST' });
    }
    async function submitPhaseSettings() {
        const payload = await fetchJson(`${API_BASE}/api/settings/phase-durations`, {
            method: 'PUT',
            body: JSON.stringify({ daySeconds: Number(daySeconds), nightSeconds: Number(nightSeconds) }),
        });
        setPhaseSettings(payload);
        setDaySeconds(String(payload.daySeconds));
        setNightSeconds(String(payload.nightSeconds));
    }
    async function submitVote(targetId) {
        try {
            await fetchJson(`${API_BASE}/api/game/vote`, {
                method: 'POST',
                body: JSON.stringify({ targetId }),
            });
        }
        catch (error) {
            setStatusMessage(error instanceof Error ? error.message : '投票に失敗しました');
        }
    }
    async function toggleAbilityReservation(sourceType, abilityId, itemCardId) {
        await fetchJson(`${API_BASE}/api/game/abilities/reservation`, {
            method: 'POST',
            body: JSON.stringify({ sourceType, abilityId, itemCardId: itemCardId ?? null }),
        });
    }
    async function resolveAbilityPrompt(accept) {
        await fetchJson(`${API_BASE}/api/game/abilities/prompt`, {
            method: 'POST',
            body: JSON.stringify({ accept }),
        });
    }
    async function submitPromptTargets() {
        await fetchJson(`${API_BASE}/api/game/abilities/prompt`, {
            method: 'POST',
            body: JSON.stringify({ targetIds: selectedPromptTargets }),
        });
    }
    function togglePromptTarget(targetId) {
        setSelectedPromptTargets((current) => (current.includes(targetId) ? current.filter((entry) => entry !== targetId) : [...current, targetId]));
    }
    function handleItemClick(cardId, item, reservableAbilityId) {
        if (!reservableAbilityId) {
            setStatusMessage(`${item.displayName} は予約できません`);
            return;
        }
        void toggleAbilityReservation('ITEM', reservableAbilityId, cardId);
    }
    function toggleOverflowCard(cardId) {
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
        await fetchJson(`${API_BASE}/api/game/items/discard-overflow`, {
            method: 'POST',
            body: JSON.stringify({ cardIds: selectedOverflowCardIds }),
        });
        setSelectedOverflowCardIds([]);
        setShowOverflowConfirm(false);
    }
    function updateCustomRoleRange(roleId, key, value) {
        setCustomRoleRanges((current) => ({
            ...current,
            [roleId]: {
                ...(current[roleId] ?? { min: '0', max: '0' }),
                [key]: value,
            },
        }));
    }
    function isLocalhost() {
        if (typeof window === 'undefined')
            return false;
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
            const result = await fetchJson(`${API_BASE}/api/admin/validate-password`, {
                method: 'POST',
                body: JSON.stringify({ password: adminPasswordInput }),
            });
            if (result.ok) {
                setAdminAuthenticated(true);
                setAdminPasswordDialogOpen(false);
                setAdminPasswordInput('');
                setAdminOpen(true);
            }
            else {
                setStatusMessage('パスワードが違います');
            }
        }
        catch {
            setStatusMessage('パスワード確認に失敗しました');
        }
    }
    function togglePanel(panel) {
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
        }
        else {
            if (panel === 'role')
                setRolePanelCollapsed((v) => !v);
            if (panel === 'hobby')
                setHobbyPanelCollapsed((v) => !v);
            if (panel === 'item')
                setItemPanelCollapsed((v) => !v);
            if (panel === 'player')
                setPlayerPanelCollapsed((v) => !v);
            if (panel === 'spectator')
                setSpectatorPanelCollapsed((v) => !v);
        }
    }
    return (_jsxs("main", { className: "app-shell", children: [game ? _jsxs("div", { className: "phase-timer", children: [game.dayNumber, "\u65E5\u76EE ", phaseLabel(game.phase), " (", timerLabel, ")"] }) : null, _jsxs("div", { className: "title-row", children: [_jsx("img", { className: "title-icon", src: `${API_BASE}/master-data-images/ui/superJinroh.png`, alt: "", "aria-hidden": "true" }), _jsx("h1", { className: "title", children: "\u8D85\u7D1A\u306E\u4EBA\u72FC" }), _jsxs("span", { className: "title-version", children: ["ver. ", APP_VERSION] })] }), _jsx("p", { className: "subtitle", children: "\u80FD\u529B\u4ED8\u304D\u30A2\u30A4\u30C6\u30E0\u4EBA\u72FC\u3060\u3088\uFF01" }), _jsxs("div", { className: "controls-inline", children: [_jsx("div", { className: "badge", children: statusMessage }), _jsx("button", { className: "secondary", onClick: () => setPersonalOpen((o) => !o), children: "\u500B\u4EBA\u8A2D\u5B9A" }), _jsx("button", { className: "secondary", onClick: () => void handleAdminOpen(), children: "\u7BA1\u7406\u8A2D\u5B9A" })] }), adminPasswordDialogOpen ? (_jsx("div", { className: "ability-overlay", children: _jsxs("div", { className: "ability-dialog card", children: [_jsx("h2", { children: "\u7BA1\u7406\u8A2D\u5B9A\u306E\u30D1\u30B9\u30EF\u30FC\u30C9" }), _jsxs("div", { className: "controls", children: [_jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u30D1\u30B9\u30EF\u30FC\u30C9" }), _jsx("input", { type: "password", value: adminPasswordInput, onChange: (e) => setAdminPasswordInput(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter')
                                                void submitAdminPassword(); } })] }), _jsxs("div", { className: "controls-inline", children: [_jsx("button", { className: "secondary", onClick: () => { setAdminPasswordDialogOpen(false); setAdminPasswordInput(''); }, children: "\u30AD\u30E3\u30F3\u30BB\u30EB" }), _jsx("button", { className: "primary", onClick: () => void submitAdminPassword(), children: "\u78BA\u8A8D" })] })] })] }) })) : null, personalOpen ? (_jsx("section", { style: { marginTop: '24px' }, children: _jsxs("article", { className: "card", children: [_jsx("h2", { children: "\u500B\u4EBA\u8A2D\u5B9A" }), _jsxs("div", { className: "controls", children: [_jsxs("div", { className: "setting-row", children: [_jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u30D7\u30EC\u30A4\u30E4\u30FC\u540D" }), _jsx("input", { value: displayName, maxLength: 24, onChange: (event) => setDisplayName(event.target.value) })] }), _jsx("button", { className: "primary", onClick: () => void submitDisplayName(), children: "\u6C7A\u5B9A" })] }), _jsxs("label", { className: "setting-checkbox-row", children: [_jsx("input", { type: "checkbox", checked: collapseOthersOnExpand, onChange: (e) => setCollapseOthersOnExpand(e.target.checked) }), _jsx("span", { children: "\u9078\u629E\u3057\u305F\u30D1\u30CD\u30EB\u4EE5\u5916\u3092\u7E2E\u5C0F\u3059\u308B" })] })] })] }) })) : null, adminOpen && lobby ? (_jsx("section", { style: { marginTop: '24px' }, children: _jsxs("article", { className: "card", children: [_jsx("h2", { children: "\u7BA1\u7406\u8A2D\u5B9A" }), _jsxs("div", { className: "controls", children: [!isGameActive ? (_jsxs("div", { className: "setting-row", children: [_jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u914D\u5F79\u9078\u629E" }), _jsxs("select", { value: selectedRoleSetId, onChange: (event) => setSelectedRoleSetId(event.target.value), children: [lobby.roleSets.map((roleSet) => (_jsx("option", { value: roleSet.id, children: roleSet.displayName }, roleSet.id))), _jsx("option", { value: "__custom__", children: "\u65B0\u898F\u4F5C\u6210" })] })] }), _jsx("button", { className: "primary", onClick: () => void submitRoleSet(), children: "\u6C7A\u5B9A" })] })) : null, _jsxs("div", { className: "setting-row", children: [_jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u663C\u30D5\u30A7\u30FC\u30BA\u79D2\u6570" }), _jsx("input", { value: daySeconds, inputMode: "numeric", onChange: (event) => setDaySeconds(event.target.value) })] }), _jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u591C\u30D5\u30A7\u30FC\u30BA\u79D2\u6570" }), _jsx("input", { value: nightSeconds, inputMode: "numeric", onChange: (event) => setNightSeconds(event.target.value) })] }), _jsx("button", { className: "primary", onClick: () => void submitPhaseSettings(), children: "\u6642\u9593\u3092\u4FDD\u5B58" })] }), game ? (_jsxs("div", { className: "settings-actions", children: [_jsx("button", { className: "secondary", onClick: () => void pauseGame(), disabled: game.isPaused, children: "\u4E00\u6642\u505C\u6B62" }), _jsx("button", { className: "danger", onClick: () => void endGame(), children: "\u30B2\u30FC\u30E0\u3092\u7D42\u4E86\u3059\u308B" })] })) : null] })] }) })) : null, customRoleSetOpen ? (_jsx("div", { className: "ability-overlay", children: _jsxs("div", { className: "ability-dialog card custom-role-set-dialog", children: [_jsx("h2", { children: "\u914D\u5F79\u3092\u65B0\u898F\u4F5C\u6210" }), _jsxs("div", { className: "controls", children: [_jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u914D\u5F79\u540D" }), _jsx("input", { value: customRoleSetName, onChange: (event) => setCustomRoleSetName(event.target.value) })] }), _jsxs("div", { className: "setting-row", children: [_jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u4EBA\u6570" }), _jsx("input", { value: customRequiredPlayerCount, inputMode: "numeric", onChange: (event) => setCustomRequiredPlayerCount(event.target.value) })] }), _jsxs("label", { className: "setting-field", children: [_jsx("div", { children: "\u898F\u5B9A\u6BBA\u5BB3\u6570" }), _jsx("input", { value: customMonsterWinRequiredKills, inputMode: "numeric", onChange: (event) => setCustomMonsterWinRequiredKills(event.target.value) })] })] }), _jsx("div", { className: "list custom-role-set-list", children: bootstrap?.roles.map((role) => (_jsxs("div", { className: "role-row", children: [_jsx("span", { children: role.displayName }), _jsxs("div", { className: "controls-inline compact", children: [_jsx("input", { className: "custom-role-range-input", value: customRoleRanges[role.roleId]?.min ?? '0', inputMode: "numeric", onChange: (event) => updateCustomRoleRange(role.roleId, 'min', event.target.value) }), _jsx("span", { children: "~" }), _jsx("input", { className: "custom-role-range-input", value: customRoleRanges[role.roleId]?.max ?? '0', inputMode: "numeric", onChange: (event) => updateCustomRoleRange(role.roleId, 'max', event.target.value) })] })] }, role.roleId))) }), _jsxs("div", { className: "controls-inline", children: [_jsx("button", { className: "secondary", onClick: () => setCustomRoleSetOpen(false), children: "\u9589\u3058\u308B" }), _jsx("button", { className: "primary", onClick: () => void submitCustomRoleSet(), children: "\u4FDD\u5B58" })] })] })] }) })) : null, lobby && !isGameActive ? (_jsxs("section", { className: "grid two", style: { marginTop: '24px' }, children: [_jsxs("article", { className: "card", children: [_jsx("h2", { children: "\u30ED\u30D3\u30FC" }), _jsx("div", { className: "list", children: lobby.participants.map((participant) => (_jsxs("div", { className: `player-row${participant.isSelf ? ' is-self' : ''}`, children: [_jsxs("span", { className: "player-name-with-tag", children: [_jsx("span", { children: participant.displayName }), participant.isSelf ? _jsx("span", { className: "self-tag", children: "\u3042\u306A\u305F" }) : null] }), _jsx("span", { className: "badge", children: participant.isConnected ? '接続中' : '切断' })] }, participant.connectionId))) })] }), _jsxs("article", { className: "card", children: [_jsxs("h2", { children: ["\u914D\u5F79(", lobby.selectedRoleSet?.requiredPlayerCount ?? '-', "\u4EBA)"] }), _jsx(RoleSetSummary, { roleSet: lobby.selectedRoleSet, roleCatalog: roleCatalog, interactiveRoles: true, abilityCatalog: abilityCatalog }), _jsxs("div", { className: "controls", style: { marginTop: '20px' }, children: [_jsx("button", { className: "primary", onClick: () => void startGame(), disabled: !lobby.canStart, children: "\u30B2\u30FC\u30E0\u958B\u59CB" }), !lobby.canStart ? _jsx("div", { className: "warning", children: lobby.cannotStartReason }) : null] })] })] })) : null, game ? (_jsxs(_Fragment, { children: [game.pendingAbilityPrompt ? (_jsx("div", { className: "ability-overlay", children: _jsxs("div", { className: "ability-dialog card", children: [_jsx("h2", { children: game.pendingAbilityPrompt.displayName }), _jsx("p", { className: "section-note", children: game.pendingAbilityPrompt.description }), game.pendingAbilityPrompt.promptType === 'CONFIRM' ? (_jsxs("div", { className: "controls-inline", children: [game.pendingAbilityPrompt.canCancel ? (_jsx("button", { className: "secondary", onClick: () => void resolveAbilityPrompt(false), children: "\u4F7F\u308F\u306A\u3044" })) : null, _jsx("button", { className: "primary", onClick: () => void resolveAbilityPrompt(true), children: "\u78BA\u8A8D" })] })) : (_jsxs("div", { className: "controls", children: [game.pendingAbilityPrompt.maxTargets > 1 ? (_jsx("div", { className: "list", children: game.pendingAbilityPrompt.options.map((option) => (_jsxs("label", { className: "target-option", children: [_jsx("input", { type: "checkbox", checked: selectedPromptTargets.includes(option.id), onChange: () => togglePromptTarget(option.id) }), _jsx("span", { children: option.displayName })] }, option.id))) })) : (_jsx("select", { value: selectedPromptTargets[0] ?? '', onChange: (event) => setSelectedPromptTargets(event.target.value ? [event.target.value] : []), children: game.pendingAbilityPrompt.options.map((option) => (_jsx("option", { value: option.id, children: option.displayName }, option.id))) })), _jsx("button", { className: "primary", onClick: () => void submitPromptTargets(), disabled: selectedPromptTargets.length !== game.pendingAbilityPrompt.maxTargets, children: "\u6C7A\u5B9A" })] }))] }) })) : null, showOverflowConfirm && pendingItemOverflow ? (_jsx("div", { className: "ability-overlay", children: _jsxs("div", { className: "ability-dialog card", children: [_jsx("h2", { children: "\u30A2\u30A4\u30C6\u30E0\u7834\u68C4" }), _jsx("p", { className: "section-note", children: `${selectedOverflowItems.map((card) => card.displayName).join(', ')}を破棄します。よろしいですか？` }), _jsxs("div", { className: "controls-inline", children: [_jsx("button", { className: "secondary", onClick: () => setShowOverflowConfirm(false), children: "\u623B\u308B" }), _jsx("button", { className: "danger", onClick: () => void submitOverflowDiscard(), children: "\u7834\u68C4\u3059\u308B" })] })] }) })) : null, game.isPaused ? (_jsx("div", { className: "pause-overlay", children: _jsxs("div", { className: "pause-dialog", children: [_jsx("strong", { children: "\u4E00\u6642\u505C\u6B62\u4E2D" }), _jsx("button", { className: "primary", onClick: () => void resumeGame(), children: "\u518D\u958B" })] }) })) : null, _jsxs("section", { className: "game-dashboard", style: { marginTop: '24px' }, children: [_jsxs("aside", { className: "game-sidebar", children: [isSpectator ? _jsx(SpectatorInfoCard, { collapsed: spectatorPanelCollapsed, onToggle: () => togglePanel('spectator') }) : null, !isSpectator && myRole ? (_jsx(MasterInfoBlock, { title: "\u5F79\u8077", displayName: myRole.displayName, description: myRole.description, imagePath: myRole.imagePath, faction: myRole.faction, abilityIds: game.myRoleAbilityIds, abilityCatalog: abilityCatalog, sourceType: "ROLE", sourceId: myRole.roleId, availableAbilityKeys: availableAbilityKeySet, reservedAbilityKeys: reservedAbilityKeySet, onAbilityClick: (abilityId) => void toggleAbilityReservation('ROLE', abilityId), collapsed: rolePanelCollapsed, onToggle: () => togglePanel('role'), collapsedTitle: `役職：${myRole.displayName}`, collapsedTitleAddon: _jsx(FactionBadge, { faction: myRole.faction }), titleHoverLabel: "\uFF08\u914D\u5F79\u8868\uFF09", titleHoverContent: _jsx(RoleSetSummary, { roleSet: activeRoleSet, roleCatalog: roleCatalog, abilityCatalog: abilityCatalog, showResolvedCount: game.status === 'FINISHED' }) })) : null, !isSpectator && myHobby ? (_jsx(MasterInfoBlock, { title: "\u8DA3\u5473", displayName: myHobby.displayName, description: myHobby.description, imagePath: myHobby.imagePath, hobbyType: myHobby.hobbyType, abilityIds: game.myHobbyAbilityIds, abilityCatalog: abilityCatalog, sourceType: "HOBBY", sourceId: myHobby.hobbyId, availableAbilityKeys: availableAbilityKeySet, reservedAbilityKeys: reservedAbilityKeySet, onAbilityClick: (abilityId) => void toggleAbilityReservation('HOBBY', abilityId), collapsed: hobbyPanelCollapsed, onToggle: () => togglePanel('hobby'), collapsedTitle: `趣味：${myHobby.displayName}`, collapsedTitleAddon: _jsx(HobbyTypeBadge, { hobbyType: myHobby.hobbyType }) })) : null] }), _jsxs("div", { className: "game-content", children: [game.status === 'FINISHED' ? (_jsxs("article", { className: "card", children: [_jsx("h2", { children: "\u7D50\u679C" }), _jsx(RoleSetSummary, { roleSet: activeRoleSet, roleCatalog: roleCatalog, abilityCatalog: abilityCatalog, showRoleSetName: false, showResolvedCount: true })] })) : null, _jsxs("article", { className: `card item-section-card${pendingItemOverflow ? ' is-overflow' : ''}${itemPanelCollapsed ? ' is-collapsed is-collapsed-clickable' : ''}`, onClick: itemPanelCollapsed ? () => togglePanel('item') : undefined, role: itemPanelCollapsed ? 'button' : undefined, tabIndex: itemPanelCollapsed ? 0 : undefined, onKeyDown: itemPanelCollapsed ? (event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                togglePanel('item');
                                            }
                                        } : undefined, children: [_jsxs("div", { className: "title-with-badge panel-title-row", children: [_jsx("h2", { children: pendingItemOverflow ? 'アイテム(超過-破棄対象を選択)' : (_jsxs(_Fragment, { children: [_jsx("span", { children: "\u30A2\u30A4\u30C6\u30E0" }), _jsx(ItemIcons, { count: game.myItemCards.length })] })) }), _jsx(ResizeButton, { collapsed: itemPanelCollapsed, onToggle: () => togglePanel('item') })] }), !itemPanelCollapsed && (_jsx("div", { className: "item-grid", children: game.myItemCards.map((card) => {
                                                    const itemDefinition = itemCatalog.get(card.itemId);
                                                    const imageUrl = mediaUrl(itemDefinition?.imagePath ?? null);
                                                    const manualTimings = (itemDefinition?.abilityIds ?? [])
                                                        .map((abilityId) => abilityCatalog.get(abilityId))
                                                        .filter((ability) => Boolean(ability && isManualAbility(ability)))
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
                                                    return (_jsxs("button", { className: `item-card${reservable ? ' actionable' : ''}${card.isActivating ? ' is-activating' : ''}${isReserved ? ' is-reserved' : ''}${pendingItemOverflow ? ' is-overflow-target' : ''}${isSelectedForDiscard ? ' is-selected-for-discard' : ''}`, type: "button", disabled: pendingItemOverflow ? false : !reservable || game.isPaused || card.isActivating, onClick: () => {
                                                            if (pendingItemOverflow) {
                                                                toggleOverflowCard(card.cardId);
                                                                return;
                                                            }
                                                            if (itemDefinition) {
                                                                handleItemClick(card.cardId, itemDefinition, reservableAbilityId);
                                                            }
                                                        }, children: [imageUrl ? (_jsx("img", { className: "item-card-image", src: imageUrl, alt: itemDefinition?.displayName ?? card.displayName })) : (_jsx("div", { className: "item-card-image placeholder", children: "NO IMAGE" })), _jsxs("div", { className: "master-card-body", children: [_jsx("strong", { children: itemDefinition?.displayName ?? card.displayName }), _jsx(AbilityList, { abilityIds: itemDefinition?.abilityIds ?? [], abilityCatalog: abilityCatalog, sourceType: "ITEM", sourceId: card.itemId, itemCardId: card.cardId, availableAbilityKeys: availableAbilityKeySet, reservedAbilityKeys: reservedAbilityKeySet, showReservedOverlay: false }), itemDefinition?.description ? _jsx("p", { className: "item-description", children: itemDefinition.description }) : null, manualTimings.length > 0 ? _jsxs("div", { className: "item-activation-timing", children: ["\u5BA3\u8A00: ", manualTimings.join(' / ')] }) : null, pendingItemOverflow ? (_jsx("div", { className: "section-note", children: isSelectedForDiscard ? '破棄候補に選択中' : 'クリックで破棄候補に選択' })) : null, card.isActivating ? _jsx("div", { className: "section-note", children: "\u8D77\u52D5\u4E2D" }) : null] }), isReserved ? (_jsx("div", { className: "reservation-overlay", "aria-hidden": "true", children: _jsx("span", { className: "reservation-pill", children: "\u5BA3\u8A00\u4E88\u7D04\u4E2D" }) })) : null] }, card.cardId));
                                                }) }))] })] })] }), _jsx("section", { className: "player-area", style: { marginTop: '24px' }, children: _jsxs("article", { className: `card player-list-card${playerPanelCollapsed ? ' is-collapsed is-collapsed-clickable' : ''}`, onClick: playerPanelCollapsed ? () => togglePanel('player') : undefined, role: playerPanelCollapsed ? 'button' : undefined, tabIndex: playerPanelCollapsed ? 0 : undefined, onKeyDown: playerPanelCollapsed ? (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    togglePanel('player');
                                }
                            } : undefined, children: [_jsxs("div", { className: "title-with-badge panel-title-row", children: [_jsx("h2", { children: "\u30D7\u30EC\u30A4\u30E4\u30FC\u4E00\u89A7" }), _jsx(ResizeButton, { collapsed: playerPanelCollapsed, onToggle: () => togglePanel('player') })] }), !playerPanelCollapsed && (_jsxs("div", { className: "section-note", children: ["\u751F\u5B58\u4E2D\uFF1A", aliveCount, "/", game.players.length] })), _jsx("div", { className: "list", style: { marginTop: '16px' }, children: game.players.map((player) => {
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
                                        return (_jsxs("div", { className: `player-row player-status-row hobby-hover-target${player.status === 'DEAD' ? ' is-dead' : ''}${isSelf ? ' is-self' : ''}`, children: [playerPanelCollapsed ? (_jsxs("div", { className: "player-name-with-tag", children: [_jsxs("span", { children: [player.displayName, player.isConnected ? '' : ' (切断)', " <", roleLabel, ">"] }), _jsx(ItemIcons, { count: player.itemCount, className: "player-item-icon" }), player.stateTags.map((state) => (_jsx("span", { className: `player-state-tag ${playerStateTagClass(state)}`, children: playerStateTagLabel(state) }, state)))] })) : (_jsxs("div", { className: "player-summary", children: [_jsxs("div", { className: "player-name-with-tag", children: [_jsxs("span", { children: [player.displayName, player.isConnected ? '' : ' (切断)'] }), isSelf ? _jsx("span", { className: "self-tag", children: "\u3042\u306A\u305F" }) : null, player.stateTags.map((state) => (_jsx("span", { className: `player-state-tag ${playerStateTagClass(state)}`, children: playerStateTagLabel(state) }, state)))] }), _jsxs("div", { className: "section-note player-meta-line", children: [_jsxs("span", { className: "player-meta-cell player-meta-role", children: [_jsx("span", { className: "player-meta-label", children: "\u5F79\u8077:" }), _jsx("span", { className: `player-meta-value player-role-value${isHighlightedRole ? ' is-cultist-known' : ''}`, children: roleLabel })] }), _jsxs("span", { className: "player-meta-cell player-meta-item", children: [_jsx("span", { className: "player-meta-label", children: "\u30A2\u30A4\u30C6\u30E0:" }), _jsxs("span", { className: "player-meta-value", children: [player.itemCount, "\u500B"] })] }), _jsxs("span", { className: "player-meta-cell player-meta-hobby", children: [_jsx("span", { className: "player-meta-label", children: "\u8DA3\u5473:" }), _jsx("span", { className: "player-meta-value", children: publicHobby?.displayName ?? player.publicHobbyId })] })] })] })), _jsxs("div", { className: "controls-inline compact player-status-actions", children: [!playerPanelCollapsed && (_jsx("div", { className: "section-note", children: renderPlayerStatusLabel(player.status, player.deathCause, player.resultStatus, game.status === 'FINISHED', showPrivateDeathCause) })), game.phase === 'VOTE' ? (_jsx("button", { className: "secondary", onClick: () => void submitVote(player.id), disabled: player.status !== 'ALIVE' || game.isPaused || player.id === selfPlayerId || game.myVoteTargetId !== null, children: "\u6295\u7968" })) : null] }), _jsx(HobbyTooltip, { hobbyDefinition: publicHobby, abilityCatalog: abilityCatalog })] }, player.id));
                                    }) })] }) }), _jsx("div", { className: `bottom-log-bar${logExpanded ? ' is-expanded' : ''}`, onClick: () => setLogExpanded((v) => !v), children: _jsx("div", { className: "bottom-log-list", children: visibleLogs.map((entry) => (_jsx("div", { className: `bottom-log-entry${entry.isPrivate ? ' is-private' : ''}${flashedLogIds.includes(entry.id) ? ' is-flashing' : ''}`, children: _jsx("span", { children: entry.message }) }, entry.id))) }) })] })) : null, !bootstrap ? _jsx("div", { style: { marginTop: '24px' }, children: "\u521D\u671F\u5316\u4E2D..." }) : null] }));
}
//# sourceMappingURL=App.js.map