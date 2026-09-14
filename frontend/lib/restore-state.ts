// Pure mapping from a server `playerState` rejoin payload to the client state
// shape it should produce. Deliberately free of React, sockets, and any UI:
// the component calls this and then feeds the result to its setters, while
// tests can call it directly with a REAL payload captured from the server.
//
// The payload interfaces here are declared structurally (only the fields this
// mapping actually reads) so the function has no dependency on page.tsx.

export interface RestoredOwnedProperty {
  tileId: number;
  houses: number;
}

export interface RestoredPlayer {
  id: number;
  name?: string;
  color?: string;
  money?: number;
  position?: number;
  isCurrentPlayer?: boolean;
  mood?: "happy" | "flat";
  inJail?: boolean;
  jailTurns?: number;
  isBankrupt?: boolean;
  isResting?: boolean;
  [key: string]: unknown;
}

export interface RestoredTrade {
  id: string;
  [key: string]: unknown;
}

export interface RestoredAuction {
  id: string;
  tileId: number;
  currentBid: number;
  highestBidderId: number | null;
  [key: string]: unknown;
}

export interface RestoredChatMessage {
  id: string;
  [key: string]: unknown;
}

// Shape of the `playerState` object the server attaches on a successful rejoin
// (see serializePlayerState() in backend/server.js).
export interface PlayerRestoreState {
  me?: RestoredPlayer;
  players?: RestoredPlayer[];
  ownedProperties?: RestoredOwnedProperty[];
  ownedPropertyIds?: number[];
  propertyOwnership?: Record<string, number>;
  propertyHouses?: Record<string, number>;
  trades?: RestoredTrade[];
  activeAuction?: RestoredAuction | null;
  chatMessages?: RestoredChatMessage[];
  // The server's authoritative turn + when it times out, so a rejoin repaints
  // the correct current player and countdown from server truth.
  currentTurnPlayerId?: number | null;
  turnDeadline?: number | null;
}

// The subset of client state a rejoin should overwrite, plus the log line and
// the derived flags the component applies alongside it.
//
// TPlayer/TTrade/TChat are generic so the actual component can ask for ITS own
// rich types (Player, TradeProposal, ChatMessage) while tests can use the plain
// structural defaults — no casts needed at the call site either way.
export interface ComputedRestoredState<
  TPlayer = RestoredPlayer,
  TTrade = RestoredTrade,
  TChat = RestoredChatMessage
> {
  players: TPlayer[] | null;
  propertyOwnership: Record<string, number> | null;
  propertyHouses: Record<string, number> | null;
  trades: TTrade[] | null;
  chatMessages: TChat[] | null;
  activeAuction: RestoredAuction | null;
  myPlayerId: number | null;
  // The server's turn + deadline (null when the payload didn't carry them, i.e.
  // leave the caller's current values untouched).
  currentTurnPlayerId: number | null;
  turnDeadline: number | null;
  isGameStarted: true;
  logMessage: string;
}

// Build the state a rejoin payload maps to. Pure: same input -> same output,
// no setters, no side effects. Fields the payload omits come back as null so
// the caller knows to LEAVE that slice of state untouched rather than clobber
// it with an empty value.
export function computeRestoredState<
  TPlayer = RestoredPlayer,
  TTrade = RestoredTrade,
  TChat = RestoredChatMessage
>(payload: PlayerRestoreState): ComputedRestoredState<TPlayer, TTrade, TChat> {
  const p = payload || {};
  const ownedCount = Array.isArray(p.ownedProperties) ? p.ownedProperties.length : 0;
  const money = typeof p.me?.money === "number" ? p.me.money : 0;

  // The payload is wire data (structurally typed); the caller asks for its own
  // richer types. Route through `unknown` so TS treats it as the deliberate
  // reinterpretation it is, instead of a suspicious near-miss cast.
  return {
    players: p.players && p.players.length ? (p.players as unknown as TPlayer[]) : null,
    propertyOwnership: p.propertyOwnership ?? null,
    propertyHouses: p.propertyHouses ?? null,
    trades: p.trades ? (p.trades as unknown as TTrade[]) : null,
    chatMessages: p.chatMessages ? (p.chatMessages as unknown as TChat[]) : null,
    activeAuction: p.activeAuction ?? null,
    myPlayerId: typeof p.me?.id === "number" ? p.me.id : null,
    currentTurnPlayerId: typeof p.currentTurnPlayerId === "number" ? p.currentTurnPlayerId : null,
    turnDeadline: typeof p.turnDeadline === "number" ? p.turnDeadline : null,
    isGameStarted: true,
    logMessage: `♻️ Reconnected — restored ${ownedCount} propert${ownedCount === 1 ? "y" : "ies"}, $${money.toLocaleString()} on hand.`
  };
}
