"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import Flag from "react-world-flags";
import DiceScene from "@/app/dice";

interface Tile {
  id: number;
  name: string;
  type: string;
  countryCode?: string;
  price?: string;
  icon?: string;
  rent?: number;
  rents?: number[];
  houseCost?: number;
  hotelCost?: number;
}

interface Player {
  id: number;
  name: string;
  color: string;
  money: number;
  position: number;
  isCurrentPlayer?: boolean;
  mood?: "happy" | "flat";
  inJail?: boolean;
  jailTurns?: number;
  isBankrupt?: boolean;
  isResting?: boolean;
}

interface PlayerMovedEvent {
  playerId: number;
  position: number;
  money: number;
}

interface PropertyBoughtEvent {
  tileId: number;
  playerId: number;
}

interface HouseUpgradedEvent {
  tileId: number;
  houses: number;
}

interface TradeProposal {
  id: string;
  initiatorId: number;
  targetId: number;
  initiatorMoney: number;
  targetMoney: number;
  initiatorPropertyIds: number[];
  targetPropertyIds: number[];
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: number;
  lastModifiedBy: number;
}

interface ChatMessage {
  id: string;
  senderId: number;
  senderName: string;
  senderColor: string;
  text: string;
  timestamp: string;
}

interface AuctionState {
  id: string;
  tileId: number;
  currentBid: number;
  highestBidderId: number | null;
  passedPlayerIds: number[];
  timeLeft: number;
}

const COUNTRY_FLAG_EMOJIS: Record<string, string> = {
  BD: "🇧🇩",
  FR: "🇫🇷",
  IN: "🇮🇳",
  CN: "🇨🇳",
  US: "🇺🇸",
  GB: "🇬🇧",
  PK: "🇵🇰",
  JP: "🇯🇵",
};

const renderTileIconOrFlag = (tile: Tile, sizeClass = "w-[2.2vmin] h-[1.5vmin]") => {
  if (tile.countryCode) {
    return (
      <span className="inline-flex items-center justify-center shrink-0">
        <Flag code={tile.countryCode} className={`${sizeClass} object-cover rounded-[0.25vmin] shadow-sm`} />
      </span>
    );
  }
  return <span className="text-[1.6vmin] shrink-0">{tile.icon || "🏢"}</span>;
};

const BOARD_TILES: Tile[] = [
  { id: 0, name: "START", type: "corner", icon: "🏁" },
  { id: 1, name: "Dhaka", type: "bangladesh", countryCode: "BD", price: "$60", rent: 10, rents: [10, 30, 90, 270, 400, 550], houseCost: 50, hotelCost: 50 },
  { id: 2, name: "Normandy", type: "france", countryCode: "FR", price: "$100", rent: 20, rents: [20, 60, 180, 500, 700, 900], houseCost: 50, hotelCost: 50 },
  { id: 3, name: "TREASURE", type: "card", icon: "🎁" },
  { id: 4, name: "Bihar", type: "india", countryCode: "IN", price: "$140", rent: 30, rents: [30, 90, 270, 750, 925, 1100], houseCost: 100, hotelCost: 100 },
  { id: 5, name: "AIRPORT 1", type: "airport", icon: "✈️", price: "$160" },
  { id: 6, name: "Guangdong", type: "china", countryCode: "CN", price: "$180", rent: 40, rents: [40, 100, 300, 750, 925, 1100], houseCost: 100, hotelCost: 100 },
  { id: 7, name: "TAX", type: "tax", icon: "📉", price: "-$100" },
  { id: 8, name: "California", type: "america", countryCode: "US", price: "$220", rent: 50, rents: [50, 150, 450, 1000, 1200, 1400], houseCost: 150, hotelCost: 150 },
  { id: 9, name: "SOLAR", type: "electricity", icon: "☀️", price: "$240" },
  { id: 10, name: "JAIL", type: "corner", icon: "🔒" },
  { id: 11, name: "Scotland", type: "uk", countryCode: "GB", price: "$260", rent: 60, rents: [60, 180, 500, 1100, 1300, 1500], houseCost: 150, hotelCost: 150 },
  { id: 12, name: "Sindh", type: "pakistan", countryCode: "PK", price: "$260", rent: 60, rents: [60, 180, 500, 1100, 1300, 1500], houseCost: 150, hotelCost: 150 },
  { id: 13, name: "Osaka", type: "japan", countryCode: "JP", price: "$280", rent: 70, rents: [70, 200, 550, 1200, 1400, 1600], houseCost: 150, hotelCost: 150 },
  { id: 14, name: "SURPRISE", type: "card", icon: "❓" },
  { id: 15, name: "AIRPORT 2", type: "airport", icon: "✈️", price: "$290" },
  { id: 16, name: "UP", type: "india", countryCode: "IN", price: "$300", rent: 80, rents: [80, 220, 600, 1400, 1700, 2000], houseCost: 200, hotelCost: 200 },
  { id: 17, name: "Provence", type: "france", countryCode: "FR", price: "$300", rent: 80, rents: [80, 220, 600, 1400, 1700, 2000], houseCost: 200, hotelCost: 200 },
  { id: 18, name: "FIBER", type: "internet", icon: "🌐", price: "$310" },
  { id: 19, name: "Texas", type: "america", countryCode: "US", price: "$320", rent: 90, rents: [90, 250, 700, 1500, 1850, 2100], houseCost: 200, hotelCost: 200 },
  { id: 20, name: "REST HOUSE", type: "corner", icon: "🏨" },
  { id: 21, name: "Shanghai", type: "china", countryCode: "CN", price: "$350", rent: 100, rents: [100, 300, 750, 1700, 2000, 2300], houseCost: 200, hotelCost: 200 },
  { id: 22, name: "Wales", type: "uk", countryCode: "GB", price: "$350", rent: 100, rents: [100, 300, 750, 1700, 2000, 2300], houseCost: 200, hotelCost: 200 },
  { id: 23, name: "WIND", type: "electricity", icon: "🌪️", price: "$360" },
  { id: 24, name: "FIXED TAX", type: "tax", icon: "💰", price: "-$200" },
  { id: 25, name: "AIRPORT 3", type: "airport", icon: "✈️", price: "$370" },
  { id: 26, name: "Chittagong", type: "bangladesh", countryCode: "BD", price: "$380", rent: 120, rents: [120, 360, 850, 2000, 2200, 2400], houseCost: 200, hotelCost: 200 },
  { id: 27, name: "France", type: "france", countryCode: "FR", price: "$400", rent: 130, rents: [130, 390, 900, 2000, 2400, 2800], houseCost: 200, hotelCost: 200 },
  { id: 28, name: "SURPRISE", type: "card", icon: "❓" },
  { id: 29, name: "MP", type: "india", countryCode: "IN", price: "$400", rent: 140, rents: [140, 400, 900, 2000, 2400, 2800], houseCost: 200, hotelCost: 200 },
  { id: 30, name: "CLUB", type: "corner", icon: "🥂" },
  { id: 31, name: "Tokyo", type: "japan", countryCode: "JP", price: "$420", rent: 150, rents: [150, 450, 1000, 2200, 2600, 3000], houseCost: 300, hotelCost: 300 },
  { id: 32, name: "New York", type: "america", countryCode: "US", price: "$420", rent: 160, rents: [160, 450, 1000, 2200, 2600, 3000], houseCost: 300, hotelCost: 300 },
  { id: 33, name: "Punjab", type: "pakistan", countryCode: "PK", price: "$450", rent: 170, rents: [170, 500, 1100, 2400, 2800, 3200], houseCost: 300, hotelCost: 300 },
  { id: 34, name: "TAX", type: "tax", icon: "📉", price: "-$250" },
  { id: 35, name: "AIRPORT 4", type: "airport", icon: "✈️", price: "$460" },
  { id: 36, name: "England", type: "uk", countryCode: "GB", price: "$480", rent: 180, rents: [180, 500, 1200, 2500, 3000, 3500], houseCost: 300, hotelCost: 300 },
  { id: 37, name: "NUCLEAR", type: "electricity", icon: "☢️", price: "$490" },
  { id: 38, name: "5G NET", type: "internet", icon: "📡", price: "$495" },
  { id: 39, name: "Beijing", type: "china", countryCode: "CN", price: "$500", rent: 200, rents: [200, 600, 1400, 3000, 3500, 4000], houseCost: 300, hotelCost: 300 },
];

const STARTING_MONEY = 2000;

const DEFAULT_PLAYERS: Player[] = [
  { id: 1, name: "", color: "#8b5cf6", money: STARTING_MONEY, position: 0, isCurrentPlayer: true, mood: "happy" },
  { id: 2, name: "", color: "#22c55e", money: STARTING_MONEY, position: 0, mood: "happy" },
  { id: 3, name: "", color: "#ef4444", money: STARTING_MONEY, position: 0, mood: "happy" },
  { id: 4, name: "", color: "#f59e0b", money: STARTING_MONEY, position: 0, mood: "happy" },
  { id: 5, name: "", color: "#06b6d4", money: STARTING_MONEY, position: 0, mood: "happy" },
  { id: 6, name: "", color: "#ec4899", money: STARTING_MONEY, position: 0, mood: "happy" },
];

const INITIAL_PLAYERS: Player[] = DEFAULT_PLAYERS.slice(0, 2);

// Clean board at game start: nobody owns anything yet, no houses built.
const INITIAL_HOUSES: Record<number, number> = {};
const PROPERTY_OWNERSHIP: Record<number, number> = {};

const PROPERTY_TYPES = new Set(["bangladesh", "france", "india", "china", "america", "uk", "pakistan", "japan"]);

// Utility-style tiles (like Monopoly's railroads/utilities): no houses/hotels,
// instead rent scales purely with how many of that SAME type you own.
const UTILITY_TYPES = new Set(["electricity", "internet", "airport"]);
const OWNABLE_TYPES = new Set([...PROPERTY_TYPES, ...UTILITY_TYPES]);

// Rent tiers per type, indexed by (number owned - 1). Doubles with each
// additional tile owned - same escalation shape as classic railroad rent,
// just rescaled up to match this board's higher utility purchase prices.
const UTILITY_RENT_TABLE: Record<string, number[]> = {
  airport: [50, 100, 200, 400],
  electricity: [80, 200, 400],
  internet: [120, 300],
};

const BOARD_SIZE = BOARD_TILES.length;
const PASS_START_BONUS = 200;
const LAND_START_BONUS = 300;
const TURN_TIME_LIMIT = 120; // 120 seconds per turn

const formatTurnTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
};

const BOARD_VMIN = 96;
const BOARD_BORDER_VMIN = 0.3 * 2;
const BOARD_PADDING_VMIN = 0.4 * 2;
const BOARD_GAP_VMIN = 0.45;
const CORNER_FR = 1.35;
const INNER_FR = 1;
const RING_SIZE = 11;
const TOTAL_FR = CORNER_FR * 2 + INNER_FR * 9;
const TRACK_SPACE_VMIN = BOARD_VMIN - BOARD_BORDER_VMIN - BOARD_PADDING_VMIN - BOARD_GAP_VMIN * (RING_SIZE - 1);
const UNIT_FR_VMIN = TRACK_SPACE_VMIN / TOTAL_FR;
const TILE_NARROW_VMIN = UNIT_FR_VMIN * INNER_FR;
const TILE_DEPTH_VMIN = UNIT_FR_VMIN * CORNER_FR;
const TILE_CONTENT_PADDING_VMIN = 0.6 * 2;
const CONTENT_BLOCK_WIDTH_VMIN = TILE_NARROW_VMIN - TILE_CONTENT_PADDING_VMIN;
const CONTENT_BLOCK_HEIGHT_VMIN = TILE_DEPTH_VMIN - TILE_CONTENT_PADDING_VMIN;

const parsePrice = (price?: string) => {
  if (!price) return null;
  const value = Number(price.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(value) ? value : null;
};

const calculateRent = (tile: Tile, houses: number) => {
  if (tile.rents && tile.rents[houses] !== undefined) return tile.rents[houses];
  if (!tile.rent) return 0;
  return Math.floor(tile.rent * (1 + houses * 0.6));
};

// Cyclic forward search for the closest tile of a given type — used by the
// Treasure Chest "advance to nearest Airport" outcome.
const findNearestTileIndex = (fromPos: number, type: string) => {
  for (let offset = 1; offset <= BOARD_SIZE; offset++) {
    const idx = (fromPos + offset) % BOARD_SIZE;
    if (BOARD_TILES[idx].type === type) return idx;
  }
  return fromPos;
};

const getTokenAnchor = (orientation: string, isCorner?: boolean, tileId?: number) => {
  if (isCorner) {
    if (tileId === 20) {
      return { top: "34%", left: "50%" };
    }
    return { top: "38%", left: "50%" };
  }
  switch (orientation) {
    case "bottom":
      return { top: "34%", left: "50%" };
    case "top":
      return { top: "66%", left: "50%" };
    case "left":
      return { top: "50%", left: "66%" };
    case "right":
      return { top: "50%", left: "34%" };
    default:
      return { top: "50%", left: "50%" };
  }
};

const getNameFontSize = (name: string) => {
  const extra = Math.max(0, name.length - 8);
  return Math.max(0.78, 1.1 - extra * 0.045);
};

// Splits an action-log line on any +$ / -$ amount and highlights it: green
// bold for a gain (+$200), red bold for a loss (-$100). Everything else in
// the line stays plain white/gray text.
const renderLogMessage = (msg: string) => {
  const parts = msg.split(/([+-]\$[0-9,]+)/g);
  return parts.map((part, idx) => {
    if (/^\+\$[0-9,]+$/.test(part)) {
      return (
        <span key={idx} className="font-black text-emerald-400">
          {part}
        </span>
      );
    }
    if (/^-\$[0-9,]+$/.test(part)) {
      return (
        <span key={idx} className="font-black text-red-400">
          {part}
        </span>
      );
    }
    return <span key={idx}>{part}</span>;
  });
};

// A log line is relevant to this player's personal balance history if
// either (a) they're the one acting - the line starts with their name - or
// (b) money moved TO them as the other party, e.g. someone else paying them
// rent ("Alex paid -$100 rent to You (+$100) on Bihar."), or a creditor
// seizing a bankrupt player's properties. Only lines carrying an actual
// dollar amount count, since this box is a money history, not a full log.
const isBalanceRelevant = (msg: string, playerName: string) => {
  if (!/[+-]\$[0-9,]+/.test(msg)) return false;
  if (msg.startsWith(`${playerName} `)) return true;
  if (msg.includes(`to ${playerName} (`)) return true;
  if (msg.includes(`${playerName} seized their properties`)) return true;
  return false;
};

export default function GameBoard() {
  const socketRef = useRef<Socket | null>(null);
  const moveTimeoutRef = useRef<number | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState("Connecting...");
  const [dice, setDice] = useState<[number, number]>([1, 1]);
  const [rollTrigger, setRollTrigger] = useState(0);
  const [isRolling, setIsRolling] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [hasSkillCard, setHasSkillCard] = useState(true);
  const [showCardSelector, setShowCardSelector] = useState(false);
  const [selectedCardValue, setSelectedCardValue] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeModal, setActiveModal] = useState<Tile | null>(null);
  const [specialModal, setSpecialModal] = useState<"treasure" | "surprise" | "tax" | "resthouse" | null>(null);
  const [propertyHouses, setPropertyHouses] = useState<Record<number, number>>(INITIAL_HOUSES);
  const [propertyOwnership, setPropertyOwnership] = useState<Record<number, number>>(PROPERTY_OWNERSHIP);
  const [players, setPlayers] = useState<Player[]>(INITIAL_PLAYERS);
  const [actionLog, setActionLog] = useState<string[]>(["Game setup ready. Configure settings below or roll dice to start!"]);
  const [gamePhase, setGamePhase] = useState<"YOUR TURN" | "ROLLING..." | "MOVING..." | "ACTION" | "END TURN">("YOUR TURN");
  const [winner, setWinner] = useState<Player | null>(null);
  const [escapingIds, setEscapingIds] = useState<number[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [restHousePot, setRestHousePot] = useState(0);

  // Game Setup & Settings states (editable before game start, locked after)
  const [isGameStarted, setIsGameStarted] = useState(false);
  const [startingCash, setStartingCash] = useState(STARTING_MONEY);
  const [passStartBonus, setPassStartBonus] = useState(PASS_START_BONUS);
  const [landStartBonus, setLandStartBonus] = useState(LAND_START_BONUS);
  const [fastMode, setFastMode] = useState(false);
  const [enableRestHousePot, setEnableRestHousePot] = useState(true);
  // Rest House mode: "pot" = classic pot that pays out to whoever lands on it,
  // "rest" = no money at all, landing just makes the player skip one turn.
  const [restHouseMode, setRestHouseMode] = useState<"pot" | "rest">("pot");
  const [enableMovementCards, setEnableMovementCards] = useState(true);
  const [enableTrading, setEnableTrading] = useState(true);
  // Mortgage = selling property back to bank / selling houses off (half price)
  const [enableMortgage, setEnableMortgage] = useState(true);
  // If true, players in JAIL still collect rent when others land on their tiles
  const [jailCollectsRent, setJailCollectsRent] = useState(false);
  const [enableAuction, setEnableAuction] = useState(true);
  const [activeAuction, setActiveAuction] = useState<AuctionState | null>(null);
  const activeAuctionRef = useRef<AuctionState | null>(null);
  activeAuctionRef.current = activeAuction;
  const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);
  // Turn Timer state (120 seconds per turn)
  const [turnTimeLeft, setTurnTimeLeft] = useState(TURN_TIME_LIMIT);
  const isTurnTimedOutRef = useRef(false);

  // Vote Kick & Voluntary Bankrupt states
  const [isVoteKickOpen, setIsVoteKickOpen] = useState(false);
  const [kickVotes, setKickVotes] = useState<Record<number, number[]>>({});
  const [showBankruptModal, setShowBankruptModal] = useState(false);
  const [bankruptCandidateId, setBankruptCandidateId] = useState<number | null>(null);

  // Trading & Negotiation states
  const [trades, setTrades] = useState<TradeProposal[]>([]);
  const [activeTradeModal, setActiveTradeModal] = useState<"create" | "view" | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [tradeDraftTargetId, setTradeDraftTargetId] = useState<number | null>(null);
  const [tradeDraftOfferedMoney, setTradeDraftOfferedMoney] = useState<number>(0);
  const [tradeDraftRequestedMoney, setTradeDraftRequestedMoney] = useState<number>(0);
  const [tradeDraftOfferedPropIds, setTradeDraftOfferedPropIds] = useState<number[]>([]);
  const [tradeDraftRequestedPropIds, setTradeDraftRequestedPropIds] = useState<number[]>([]);
  const [negotiatingTradeId, setNegotiatingTradeId] = useState<string | null>(null);
  const [isTradesExpanded, setIsTradesExpanded] = useState<boolean>(true);

  // Chat system states
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const chatMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const isChatOpenRef = useRef(isChatOpen);
  isChatOpenRef.current = isChatOpen;

  useEffect(() => {
    if (isChatOpen) {
      setUnreadChatCount(0);
      chatMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isChatOpen, chatMessages]);

  const currentPlayer = useMemo(() => players.find((p) => p.isCurrentPlayer), [players]);
  const alivePlayers = useMemo(() => players.filter((p) => !p.isBankrupt), [players]);

  const normalizePlayerNames = (list: Player[]) =>
    list.map((p) => ({
      ...p,
      name: p.name.trim() ? p.name.trim() : `Player ${p.id}`,
    }));

  const handlePlayerCountChange = (count: number) => {
    if (isGameStarted) return;
    if (count < 2 || count > 6) return;

    setPlayers((prev) => {
      if (count === prev.length) return prev;
      if (count < prev.length) {
        const trimmed = prev.slice(0, count);
        if (!trimmed.some((p) => p.isCurrentPlayer)) {
          trimmed[0].isCurrentPlayer = true;
        }
        return trimmed;
      }
      const updated = [...prev];
      for (let i = prev.length; i < count; i++) {
        const template = DEFAULT_PLAYERS[i];
        updated.push({
          id: template.id,
          name: "",
          color: template.color,
          money: startingCash,
          position: 0,
          mood: "happy",
          isCurrentPlayer: false,
        });
      }
      return updated;
    });
    addLog(`⚙️ Player count updated to ${count} players.`);
  };

  const handlePlayerNameChange = (playerId: number, newName: string) => {
    if (isGameStarted) return;
    setPlayers((prev) =>
      prev.map((p) => (p.id === playerId ? { ...p, name: newName } : p))
    );
  };

  const handleStartingCashChange = (cash: number) => {
    if (isGameStarted) return;
    setStartingCash(cash);
    setPlayers((prev) => prev.map((p) => ({ ...p, money: cash })));
    addLog(`⚙️ Starting cash updated to $${cash.toLocaleString()}`);
  };

  const handleBonusPresetChange = (passBonus: number, landBonus: number) => {
    if (isGameStarted) return;
    setPassStartBonus(passBonus);
    setLandStartBonus(landBonus);
    addLog(`⚙️ START bonus updated: Pass +$${passBonus} / Land +$${landBonus}`);
  };

  const handlePassBonusChange = (value: number) => {
    if (isGameStarted) return;
    setPassStartBonus(value);
    addLog(`⚙️ Pass START bonus updated to +$${value}`);
  };

  const handleLandBonusChange = (value: number) => {
    if (isGameStarted) return;
    setLandStartBonus(value);
    addLog(`⚙️ Land START bonus updated to +$${value}`);
  };

  const handleStartGame = () => {
    if (isGameStarted) return;
    setPlayers((prev) => normalizePlayerNames(prev));
    setIsGameStarted(true);
    setTurnTimeLeft(TURN_TIME_LIMIT);
    isTurnTimedOutRef.current = false;
    addLog(`🎮 Game started! Settings are now locked in.`);
  };

  const playersRef = useRef(players);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    const newSocket = io("http://localhost:3001", { reconnectionAttempts: 8, timeout: 4000 });
    socketRef.current = newSocket;

    const handleConnect = () => {
      setIsConnected(true);
      setConnectionLabel("LIVE • Room 8c3bc");
    };
    const handleDisconnect = () => {
      setIsConnected(false);
      setConnectionLabel("Offline");
    };

    newSocket.on("player:moved", (data: PlayerMovedEvent) => {
      setPlayers((prev) => prev.map((p) => (p.id === data.playerId ? { ...p, position: data.position, money: data.money } : p)));
    });
    newSocket.on("property:bought", (data: PropertyBoughtEvent) => {
      setPropertyOwnership((prev) => ({ ...prev, [data.tileId]: data.playerId }));
    });
    newSocket.on("house:upgraded", (data: HouseUpgradedEvent) => {
      setPropertyHouses((prev) => ({ ...prev, [data.tileId]: data.houses }));
    });

    newSocket.on("trade:created", (trade: TradeProposal) => {
      setTrades((prev) => [trade, ...prev.filter((t) => t.id !== trade.id)]);
      const sender = playersRef.current.find((p) => p.id === trade.initiatorId);
      const receiver = playersRef.current.find((p) => p.id === trade.targetId);
      addLog(`🤝 Trade proposed: ${sender?.name || "Player"} ➔ ${receiver?.name || "Player"}`);
    });

    newSocket.on("trade:updated", (trade: TradeProposal) => {
      setTrades((prev) => prev.map((t) => (t.id === trade.id ? trade : t)));
      const sender = playersRef.current.find((p) => p.id === trade.lastModifiedBy);
      addLog(`🔄 Trade counter-offer from ${sender?.name || "Player"}`);
    });

    newSocket.on("trade:accepted", (data: { trade: TradeProposal }) => {
      setTrades((prev) => prev.map((t) => (t.id === data.trade.id ? { ...t, status: "accepted" } : t)));
      const p1 = playersRef.current.find((p) => p.id === data.trade.initiatorId);
      const p2 = playersRef.current.find((p) => p.id === data.trade.targetId);
      if (p1 && p2) {
        setPlayers((prev) =>
          prev.map((p) => {
            if (p.id === p1.id) return { ...p, money: p.money - data.trade.initiatorMoney + data.trade.targetMoney };
            if (p.id === p2.id) return { ...p, money: p.money - data.trade.targetMoney + data.trade.initiatorMoney };
            return p;
          })
        );
        setPropertyOwnership((prev) => {
          const next = { ...prev };
          for (const id of data.trade.initiatorPropertyIds) next[id] = p2.id;
          for (const id of data.trade.targetPropertyIds) next[id] = p1.id;
          return next;
        });
        addLog(`🎉 Trade completed between ${p1.name} and ${p2.name}!`);
      }
    });

    newSocket.on("trade:rejected", (data: { tradeId: string }) => {
      setTrades((prev) => prev.map((t) => (t.id === data.tradeId ? { ...t, status: "rejected" } : t)));
      addLog("❌ Trade was declined.");
    });

    newSocket.on("trade:cancelled", (data: { tradeId: string }) => {
      setTrades((prev) => prev.filter((t) => t.id !== data.tradeId));
      addLog("🗑️ Trade was cancelled.");
    });

    newSocket.on("chat:message", (msg: ChatMessage) => {
      setChatMessages((prev) => [...prev, msg]);
      if (!isChatOpenRef.current) {
        setUnreadChatCount((prev) => prev + 1);
      }
    });

    newSocket.on("auction:start", (data: { auction: AuctionState }) => {
      setActiveAuction(data.auction);
      setActiveModal(null);
      const tile = BOARD_TILES.find((t) => t.id === data.auction.tileId);
      addLog(`🔨 AUCTION STARTED for ${tile?.name || "property"}! Bidding starts at $2.`);
    });

    newSocket.on("auction:bid", (data: { auction: AuctionState }) => {
      setActiveAuction(data.auction);
      const bidder = playersRef.current.find((p) => p.id === data.auction.highestBidderId);
      const tile = BOARD_TILES.find((t) => t.id === data.auction.tileId);
      addLog(`🔨 ${bidder?.name || "Player"} bid $${data.auction.currentBid} on ${tile?.name || "property"}!`);
    });

    newSocket.on("auction:pass", (data: { auction: AuctionState }) => {
      setActiveAuction(data.auction);
    });

    newSocket.on("auction:end", (data: { auction: AuctionState }) => {
      if (data.auction.highestBidderId !== null) {
        const winnerP = playersRef.current.find((p) => p.id === data.auction.highestBidderId);
        const tile = BOARD_TILES.find((t) => t.id === data.auction.tileId);
        if (winnerP && tile) {
          setPropertyOwnership((prev) => ({ ...prev, [tile.id]: winnerP.id }));
        }
      }
      setActiveAuction(null);
    });

    newSocket.on("connect", handleConnect);
    newSocket.on("disconnect", handleDisconnect);
    newSocket.on("connect_error", handleDisconnect);

    return () => {
      newSocket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (moveTimeoutRef.current) window.clearTimeout(moveTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveModal(null);
        setSpecialModal(null);
        setShowCardSelector(false);
        setSelectedCardValue(null);
        setIsVoteKickOpen(false);
        setShowBankruptModal(false);
        setActiveTradeModal(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  };

  const addLog = (msg: string) => {
    setActionLog((prev) => [msg, ...prev].slice(0, 60));
  };

  const collectToRestHouse = (amount: number) => {
    if (!enableRestHousePot || amount <= 0) return;
    setRestHousePot((prev) => prev + amount);
  };

  const getPlayerHouseCount = (playerId: number) =>
    Object.entries(propertyHouses).reduce((total, [tileId, houses]) => {
      if (propertyOwnership[Number(tileId)] === playerId) return total + Number(houses || 0);
      return total;
    }, 0);

  // Briefly flags a player as "breaking out" so their token plays the
  // jailBreak pop animation instead of the idle jail-rattle, right at the
  // moment they're released (doubles, bail, or the forced 3rd-turn release).
  const triggerJailBreak = (playerId: number) => {
    setEscapingIds((prev) => (prev.includes(playerId) ? prev : [...prev, playerId]));
    window.setTimeout(() => {
      setEscapingIds((prev) => prev.filter((id) => id !== playerId));
    }, 700);
  };

  // How many tiles of this SAME utility type (e.g. all "airport" tiles) does
  // this owner currently hold? Drives the tiered rent lookup below.
  const getUtilityOwnerCount = (type: string, ownerId: number) =>
    BOARD_TILES.filter((t) => t.type === type && propertyOwnership[t.id] === ownerId).length;

  const calculateUtilityRent = (tile: Tile, ownerId: number) => {
    const table = UTILITY_RENT_TABLE[tile.type];
    if (!table) return 0;
    const count = getUtilityOwnerCount(tile.type, ownerId);
    const tierIndex = Math.min(Math.max(count, 1), table.length) - 1;
    return table[tierIndex];
  };

  const animateMovement = (steps: number) => {
    const player = playersRef.current.find((p) => p.isCurrentPlayer);
    if (!player) return;

    setIsMoving(true);
    setGamePhase("MOVING...");
    setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, mood: "flat" } : p)));

    let remaining = steps;
    let currentPos = player.position;

    const step = () => {
      if (remaining <= 0) {
        setIsMoving(false);
        setGamePhase("ACTION");
        handleLanding(BOARD_TILES[currentPos], player.id);
        return;
      }

      currentPos = (currentPos + 1) % BOARD_SIZE;
      remaining--;

      const landsOnStart = currentPos === 0 && remaining <= 0;
      const startBonus = currentPos === 0 ? (landsOnStart ? landStartBonus : passStartBonus) : 0;

      if (currentPos === 0) {
        setHasSkillCard(true);
        addLog(`${player.name} ${landsOnStart ? "landed on" : "passed"} START (+$${startBonus})`);
      }

      setPlayers((prev) =>
        prev.map((p) =>
          p.id === player.id
            ? { ...p, position: currentPos, money: p.money + startBonus }
            : p
        )
      );
      moveTimeoutRef.current = window.setTimeout(step, fastMode ? 130 : 260);
    };

    step();
  };

  const checkForWinnerAmong = (list: Player[]) => {
    const alive = list.filter((p) => !p.isBankrupt);
    if (alive.length === 1) setWinner(alive[0]);
  };

  // A player who can't cover what they owe goes bankrupt: every property
  // they own transfers to whoever they owed (or back to the bank for tax),
  // any houses on those tiles are cleared, and they're marked out of the
  // game so endTurn skips them from here on.
  const declareBankruptcy = (playerId: number, creditorId?: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player || player.isBankrupt) return;

    const ownedTileIds = Object.keys(propertyOwnership)
      .map(Number)
      .filter((tileId) => propertyOwnership[tileId] === playerId);

    setPropertyOwnership((prev) => {
      const next = { ...prev };
      ownedTileIds.forEach((tileId) => {
        if (creditorId) next[tileId] = creditorId;
        else delete next[tileId];
      });
      return next;
    });

    if (ownedTileIds.length) {
      setPropertyHouses((prev) => {
        const next = { ...prev };
        ownedTileIds.forEach((tileId) => {
          next[tileId] = 0;
        });
        return next;
      });
    }

    const wasCurrent = player.isCurrentPlayer;

    setPlayers((prev) => {
      let nextCurrentId: number | null = null;
      if (wasCurrent) {
        const currentIdx = prev.findIndex((p) => p.id === playerId);
        for (let i = 1; i <= prev.length; i++) {
          const candidate = prev[(currentIdx + i) % prev.length];
          if (!candidate.isBankrupt && candidate.id !== playerId) {
            nextCurrentId = candidate.id;
            break;
          }
        }
      }

      const updated = prev.map((p) => {
        if (p.id === playerId) {
          return { ...p, isBankrupt: true, money: 0, isCurrentPlayer: false };
        }
        if (nextCurrentId !== null && p.id === nextCurrentId) {
          return { ...p, isCurrentPlayer: true };
        }
        return p;
      });
      checkForWinnerAmong(updated);
      return updated;
    });

    // Clean up vote kick states for/by this player
    setKickVotes((prev) => {
      const next: Record<number, number[]> = {};
      for (const [key, voters] of Object.entries(prev)) {
        const tId = Number(key);
        if (tId === playerId) continue;
        const filtered = voters.filter((id) => id !== playerId);
        if (filtered.length > 0) next[tId] = filtered;
      }
      return next;
    });

    setSelectedPlayerId((prev) => (prev === playerId ? null : prev));
    setActiveModal(null);

    const creditor = creditorId ? playersRef.current.find((p) => p.id === creditorId) : undefined;
    addLog(
      `${player.name} went BANKRUPT${creditor ? ` — ${creditor.name} seized their properties` : " — properties returned to the bank"
      }.`
    );

    if (wasCurrent) {
      setGamePhase("YOUR TURN");
      setIsMoving(false);
      setIsRolling(false);
    }
  };

  const handleVoluntaryBankruptcy = (playerId: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player || player.isBankrupt) return;

    addLog(`🏳️ ${player.name} surrendered and declared bankruptcy.`);
    socketRef.current?.emit("player:bankrupt", { playerId });
    setShowBankruptModal(false);
    declareBankruptcy(playerId);
  };

  const togglePlayerKickVote = (targetId: number, voterId: number) => {
    if (winner) return;
    const target = playersRef.current.find((p) => p.id === targetId && !p.isBankrupt);
    const voter = playersRef.current.find((p) => p.id === voterId && !p.isBankrupt);
    if (!target || !voter || targetId === voterId) return;

    const otherAlive = playersRef.current.filter((p) => !p.isBankrupt && p.id !== targetId);
    const totalOthers = otherAlive.length;
    if (totalOthers <= 0) return;

    setKickVotes((prev) => {
      const currentVoters = prev[targetId] || [];
      const alreadyVoted = currentVoters.includes(voterId);

      let nextVoters: number[];
      if (alreadyVoted) {
        nextVoters = currentVoters.filter((id) => id !== voterId);
        addLog(`🗳️ ${voter.name} withdrew vote to kick ${target.name} (${nextVoters.length}/${totalOthers})`);
      } else {
        // Enforce: one player can only vote other player once!
        nextVoters = [...currentVoters, voterId];
        addLog(`🗳️ ${voter.name} voted to kick ${target.name} (${nextVoters.length}/${totalOthers})`);
      }

      if (nextVoters.length >= totalOthers) {
        setTimeout(() => {
          addLog(`🚨 ${target.name} received votes from all other players and was VOTE-KICKED out!`);
          setKickVotes((kPrev) => {
            const copy = { ...kPrev };
            delete copy[targetId];
            return copy;
          });
          socketRef.current?.emit("player:kicked", { targetId });
          declareBankruptcy(targetId);
        }, 150);
      }

      return { ...prev, [targetId]: nextVoters };
    });
  };

  // Instantly moves a player to a target tile (for card-driven jumps rather
  // than a dice roll), crediting the pass-START bonus if the jump wraps
  // around, then resolves whatever they land on exactly like a normal move.
  const teleportAndLand = (playerId: number, targetIndex: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player) return;

    const wrapped = targetIndex < player.position;
    const landsOnStart = targetIndex === 0;
    const startBonus = landsOnStart ? landStartBonus : wrapped ? passStartBonus : 0;

    setPlayers((prev) =>
      prev.map((p) =>
        p.id === playerId
          ? { ...p, position: targetIndex, money: p.money + startBonus }
          : p
      )
    );
    if (startBonus > 0) {
      addLog(`${player.name} ${landsOnStart ? "landed on" : "passed"} START (+$${startBonus})`);
    }

    moveTimeoutRef.current = window.setTimeout(() => handleLanding(BOARD_TILES[targetIndex], playerId), 300);
  };

  // Rolls and applies a Treasure/Surprise outcome. The odds and effects
  // match exactly what the rules modal for these tiles already promises.
  const resolveCard = (kind: "treasure" | "surprise", playerId: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player) return;

    const roll = Math.floor(Math.random() * 6) + 1;

    if (kind === "treasure") {
      if (roll <= 2) {
        setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, money: p.money + 100, mood: "happy" } : p)));
        addLog(`${player.name} drew Treasure (${roll}): +$100 from the bank.`);
      } else if (roll <= 4) {
        setHasSkillCard(true);
        setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, money: p.money + 200, mood: "happy" } : p)));
        addLog(`${player.name} drew Treasure (${roll}): +$200 and a free Movement Card.`);
      } else if (roll === 5) {
        const targetIdx = findNearestTileIndex(player.position, "airport");
        addLog(`${player.name} drew Treasure (${roll}): advances to the nearest Airport.`);
        teleportAndLand(playerId, targetIdx);
      } else {
        const amount = 150;
        if (player.money < amount) {
          declareBankruptcy(playerId);
        } else {
          setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, money: p.money - amount, mood: "flat" } : p)));
          collectToRestHouse(amount);
          addLog(`${player.name} drew Treasure (${roll}): pays -$150 luxury tax.`);
        }
      }
      return;
    }

    if (roll <= 2) {
      setPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, position: 10, inJail: true, jailTurns: 0, mood: "flat" } : p))
      );
      addLog(`${player.name} drew Surprise (${roll}): sent straight to JAIL.`);
    } else if (roll <= 4) {
      const targetIdx = (player.position + 8) % BOARD_SIZE;
      addLog(`${player.name} drew Surprise (${roll}): jumps forward 8 spaces.`);
      teleportAndLand(playerId, targetIdx);
    } else if (roll === 5) {
      setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, money: p.money + 250, mood: "happy" } : p)));
      addLog(`${player.name} drew Surprise (${roll}): receives a $250 dividend.`);
    } else {
      const others = playersRef.current.filter((p) => p.id !== playerId && !p.isBankrupt);
      if (others.length === 0) {
        addLog(`${player.name} drew Surprise (${roll}): no one else to swap with.`);
        return;
      }
      const target = others[Math.floor(Math.random() * others.length)];
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id === playerId) return { ...p, position: target.position };
          if (p.id === target.id) return { ...p, position: player.position };
          return p;
        })
      );
      addLog(`${player.name} drew Surprise (${roll}): swapped places with ${target.name}.`);
    }
  };

  const handleLanding = (tile: Tile, playerId: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player) return;

    if (tile.id === 20) {
      // "rest" mode: no money system at rest house — just skip one turn.
      if (restHouseMode === "rest" || !enableRestHousePot) {
        addLog(`${player.name} landed on REST HOUSE and rests for one turn (no money).`);
        setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, isResting: true } : p)));
        return;
      }
      const potPayout = restHousePot;
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId ? { ...p, money: p.money + potPayout, mood: "happy", isResting: true } : p
        )
      );
      setRestHousePot(0);
      if (potPayout > 0) {
        addLog(`${player.name} landed on REST HOUSE and collected +$${potPayout}.`);
      } else {
        addLog(`${player.name} landed on REST HOUSE and rests for one turn.`);
        setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, isResting: true } : p)));
      }
      return;
    }

    if (tile.id === 30) {
      const cardCount = hasSkillCard ? 1 : 0;
      const houseCount = getPlayerHouseCount(playerId);
      const clubFee = cardCount * 50 + houseCount * 100;

      if (clubFee <= 0) {
        addLog(`${player.name} visited CLUB — no fee.`);
        return;
      }

      if (player.money < clubFee) {
        declareBankruptcy(playerId);
        return;
      }

      setPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId ? { ...p, money: Math.max(0, p.money - clubFee), mood: "flat" } : p
        )
      );
      collectToRestHouse(clubFee);
      addLog(`${player.name} paid -$${clubFee} at CLUB (${cardCount} card + ${houseCount} houses).`);
      return;
    }

    if (tile.type === "tax") {
      const amount = Math.abs(parsePrice(tile.price) || 0);
      if (player.money < amount) {
        declareBankruptcy(playerId);
        return;
      }
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === playerId ? { ...p, money: Math.max(0, p.money - amount), mood: "flat" } : p
        )
      );
      collectToRestHouse(amount);
      addLog(`${player.name} paid -$${amount} tax.`);
      return;
    }

    if (PROPERTY_TYPES.has(tile.type) || UTILITY_TYPES.has(tile.type)) {
      const ownerId = propertyOwnership[tile.id];
      if (ownerId && ownerId !== playerId) {
        const owner = playersRef.current.find((p) => p.id === ownerId);
        // If owner is in jail and jail doesn't collect rent, no rent is paid
        if (owner?.inJail && !jailCollectsRent) {
          setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, mood: "happy" } : p)));
          addLog(`${player.name} landed on ${tile.name} (owned by ${owner?.name}) but they're in JAIL and don't collect rent.`);
          return;
        }

        const houses = propertyHouses[tile.id] || 0;
        const rent = PROPERTY_TYPES.has(tile.type)
          ? calculateRent(tile, houses)
          : calculateUtilityRent(tile, ownerId);

        if (player.money < rent) {
          declareBankruptcy(playerId, ownerId);
          return;
        }

        setPlayers((prev) =>
          prev.map((p) => {
            if (p.id === playerId) return { ...p, money: Math.max(0, p.money - rent), mood: "flat" };
            if (p.id === ownerId) return { ...p, money: p.money + rent };
            return p;
          })
        );
        addLog(`${player.name} paid -$${rent} rent to ${owner?.name} (+$${rent}) on ${tile.name}.`);
      } else {
        setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, mood: "happy" } : p)));
        if (!ownerId) setActiveModal(tile);
      }
      return;
    }

    if (tile.type === "card") {
      resolveCard(tile.name === "TREASURE" ? "treasure" : "surprise", playerId);
      return;
    }

    if (tile.id === 10 && !player.inJail) {
      setPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, inJail: true, jailTurns: 0, mood: "flat" } : p))
      );
      addLog(`${player.name} landed on JAIL and got locked up!`);
      return;
    }

    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, mood: "happy" } : p)));
  };

  const rollDice = () => {
    if (isRolling || isMoving || gamePhase !== "YOUR TURN" || winner) return;
    if (currentPlayer?.isResting) {
      addLog(`${currentPlayer.name} is resting and cannot play this turn.`);
      return;
    }

    if (!isGameStarted) {
      setPlayers((prev) => normalizePlayerNames(prev));
      setIsGameStarted(true);
      setTurnTimeLeft(TURN_TIME_LIMIT);
      isTurnTimedOutRef.current = false;
      addLog(`🎲 Game started! Settings are now locked.`);
    }

    const result: [number, number] = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
    ];

    setDice(result);
    setRollTrigger((value) => value + 1);
    setIsRolling(true);
    setGamePhase("ROLLING...");
  };

  const handleDiceSettled = () => {
    if (!isRolling) return;

    const [first, second] = dice;
    const total = first + second;
    const isDoubles = first === second;
    const player = playersRef.current.find((p) => p.isCurrentPlayer);

    setIsRolling(false);
    socketRef.current?.emit("player:rolled", { dice: [first, second], total });

    if (player?.inJail) {
      if (isDoubles) {
        addLog(`Rolled ${total} (${first} + ${second}) — doubles! ${player.name} breaks out of JAIL.`);
        setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, inJail: false, jailTurns: 0 } : p)));
        triggerJailBreak(player.id);
        animateMovement(total);
      } else {
        const nextJailTurns = (player.jailTurns || 0) + 1;
        if (nextJailTurns >= 3) {
          const bail = 100;
          addLog(`Rolled ${total} (${first} + ${second}) — no doubles. ${player.name} is forced to pay -$${bail} bail and is released.`);
          setPlayers((prev) =>
            prev.map((p) =>
              p.id === player.id ? { ...p, inJail: false, jailTurns: 0, money: Math.max(0, p.money - bail) } : p
            )
          );
          collectToRestHouse(bail);
          triggerJailBreak(player.id);
        } else {
          addLog(`Rolled ${total} (${first} + ${second}) — no doubles. ${player.name} stays in JAIL (${nextJailTurns}/3).`);
          setPlayers((prev) => prev.map((p) => (p.id === player.id ? { ...p, jailTurns: nextJailTurns } : p)));
        }
        setGamePhase("ACTION");
      }
      return;
    }

    addLog(`Rolled ${total} (${first} + ${second})`);
    animateMovement(total);
  };

  const payBail = () => {
    if (!currentPlayer || currentPlayer.isResting || !currentPlayer.inJail || gamePhase !== "YOUR TURN" || winner) return;
    const bail = 100;
    if (currentPlayer.money < bail) {
      addLog(`${currentPlayer.name} can't afford the $${bail} bail.`);
      return;
    }
    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, inJail: false, jailTurns: 0, money: p.money - bail } : p))
    );
    collectToRestHouse(bail);
    triggerJailBreak(currentPlayer.id);
    addLog(`${currentPlayer.name} paid -$${bail} bail and is released from JAIL.`);
  };

  const openSkillCard = () => {
    if (!enableMovementCards || !hasSkillCard || isRolling || isMoving || gamePhase !== "YOUR TURN" || winner || currentPlayer?.inJail || currentPlayer?.isResting) return;
    setShowCardSelector(true);
    setSelectedCardValue(null);
  };

  const confirmSkillCard = () => {
    if (!selectedCardValue || !hasSkillCard) return;
    if (!isGameStarted) {
      setPlayers((prev) => normalizePlayerNames(prev));
      setIsGameStarted(true);
      addLog(`🃏 Game started! Settings are now locked.`);
    }
    setHasSkillCard(false);
    setShowCardSelector(false);
    addLog(`Used Movement Card → ${selectedCardValue} spaces`);
    socketRef.current?.emit("player:skill-card", { movement: selectedCardValue });
    animateMovement(selectedCardValue);
  };

  const endTurn = () => {
    if (winner) return;
    if (gamePhase !== "ACTION" && gamePhase !== "END TURN") return;

    setPlayers((prev) => {
      const currentIdx = prev.findIndex((p) => p.isCurrentPlayer);
      let nextIdx = currentIdx;
      let updated = prev;

      for (let i = 0; i < updated.length; i++) {
        nextIdx = (nextIdx + 1) % updated.length;
        if (updated[nextIdx].isBankrupt) continue;

        if (updated[nextIdx].isResting) {
          updated = updated.map((p) =>
            p.id === updated[nextIdx].id ? { ...p, isResting: false } : p
          );
          addLog(`${updated[nextIdx].name} rested and skipped this turn.`);
          continue;
        }

        return updated.map((p, idx) => ({ ...p, isCurrentPlayer: idx === nextIdx }));
      }

      return updated.map((p, idx) => ({ ...p, isCurrentPlayer: idx === nextIdx }));
    });

    setGamePhase("YOUR TURN");
    addLog("Turn ended.");
    setTurnTimeLeft(TURN_TIME_LIMIT);
    isTurnTimedOutRef.current = false;
  };

  // Reset turn timer to 120s whenever active player changes or game starts
  useEffect(() => {
    setTurnTimeLeft(TURN_TIME_LIMIT);
    isTurnTimedOutRef.current = false;
  }, [currentPlayer?.id, isGameStarted]);

  // Turn timer countdown interval (120s per turn)
  useEffect(() => {
    if (!isGameStarted || winner) return;

    const interval = window.setInterval(() => {
      setTurnTimeLeft((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isGameStarted, winner, currentPlayer?.id]);

  // Handle turn timeout when 120 seconds expire
  useEffect(() => {
    if (!isGameStarted || winner || turnTimeLeft > 0) return;

    const pName = currentPlayer?.name?.trim() || `Player ${currentPlayer?.id || 1}`;

    // Eliminate player for timeout
    if (currentPlayer && !currentPlayer.isBankrupt) {
      addLog(`⏰ TIME EXPIRED! ${pName} failed to play within 120 seconds and is ELIMINATED!`);
      declareBankruptcy(currentPlayer.id);
      setTurnTimeLeft(TURN_TIME_LIMIT);
      isTurnTimedOutRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnTimeLeft, isGameStarted, winner, currentPlayer?.id]);

  // This effect is no longer needed since we handle timeout by eliminating the player

  const buyProperty = (tile: Tile) => {
    if (winner || !currentPlayer || !OWNABLE_TYPES.has(tile.type) || propertyOwnership[tile.id]) return;
    const cost = parsePrice(tile.price);
    if (cost === null || cost <= 0 || currentPlayer.money < cost) return;

    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, money: p.money - cost } : p))
    );
    setPropertyOwnership((prev) => ({ ...prev, [tile.id]: currentPlayer.id }));
    addLog(`${currentPlayer.name} bought ${tile.name} for -${tile.price}`);
    socketRef.current?.emit("property:bought", { tileId: tile.id, playerId: currentPlayer.id });
    setActiveModal(null);
  };

  // ================= TRADE & NEGOTIATION HANDLERS =================
  const openCreateTradeModal = (targetPlayerId?: number) => {
    if (!currentPlayer || alivePlayers.length <= 1) return;
    const defaultTarget =
      targetPlayerId && targetPlayerId !== currentPlayer.id
        ? targetPlayerId
        : alivePlayers.find((p) => p.id !== currentPlayer.id)?.id || null;

    setTradeDraftTargetId(defaultTarget);
    setTradeDraftOfferedMoney(0);
    setTradeDraftRequestedMoney(0);
    setTradeDraftOfferedPropIds([]);
    setTradeDraftRequestedPropIds([]);
    setNegotiatingTradeId(null);
    setActiveTradeModal("create");
  };

  const handleSendTrade = () => {
    if (!currentPlayer || !tradeDraftTargetId) return;
    const targetPlayer = players.find((p) => p.id === tradeDraftTargetId);
    if (!targetPlayer) return;

    if (
      tradeDraftOfferedMoney === 0 &&
      tradeDraftRequestedMoney === 0 &&
      tradeDraftOfferedPropIds.length === 0 &&
      tradeDraftRequestedPropIds.length === 0
    ) {
      addLog("⚠️ Trade offer cannot be completely empty.");
      return;
    }

    if (currentPlayer.money < tradeDraftOfferedMoney) {
      addLog(`⚠️ You don't have $${tradeDraftOfferedMoney.toLocaleString()} to offer.`);
      return;
    }

    if (targetPlayer.money < tradeDraftRequestedMoney) {
      addLog(`⚠️ ${targetPlayer.name} doesn't have $${tradeDraftRequestedMoney.toLocaleString()}.`);
      return;
    }

    if (negotiatingTradeId) {
      const updatedTrade: TradeProposal = {
        id: negotiatingTradeId,
        initiatorId: currentPlayer.id,
        targetId: tradeDraftTargetId,
        initiatorMoney: tradeDraftOfferedMoney,
        targetMoney: tradeDraftRequestedMoney,
        initiatorPropertyIds: tradeDraftOfferedPropIds,
        targetPropertyIds: tradeDraftRequestedPropIds,
        status: "pending",
        createdAt: Date.now(),
        lastModifiedBy: currentPlayer.id,
      };

      setTrades((prev) => prev.map((t) => (t.id === negotiatingTradeId ? updatedTrade : t)));
      socketRef.current?.emit("trade:updated", updatedTrade);
      addLog(`🔄 ${currentPlayer.name} sent a counter-offer to ${targetPlayer.name}!`);
    } else {
      const newTrade: TradeProposal = {
        id: `trade-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        initiatorId: currentPlayer.id,
        targetId: tradeDraftTargetId,
        initiatorMoney: tradeDraftOfferedMoney,
        targetMoney: tradeDraftRequestedMoney,
        initiatorPropertyIds: tradeDraftOfferedPropIds,
        targetPropertyIds: tradeDraftRequestedPropIds,
        status: "pending",
        createdAt: Date.now(),
        lastModifiedBy: currentPlayer.id,
      };

      setTrades((prev) => [newTrade, ...prev]);
      socketRef.current?.emit("trade:created", newTrade);
      addLog(`🤝 ${currentPlayer.name} proposed a trade to ${targetPlayer.name}!`);
    }

    setActiveTradeModal(null);
    setNegotiatingTradeId(null);
  };

  const handleAcceptTrade = (tradeId: string) => {
    const trade = trades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== "pending") return;

    const p1 = players.find((p) => p.id === trade.initiatorId);
    const p2 = players.find((p) => p.id === trade.targetId);
    if (!p1 || !p2) return;

    if (p1.money < trade.initiatorMoney) {
      addLog(`⚠️ Trade failed: ${p1.name} doesn't have enough cash.`);
      return;
    }
    if (p2.money < trade.targetMoney) {
      addLog(`⚠️ Trade failed: ${p2.name} doesn't have enough cash.`);
      return;
    }

    for (const propId of trade.initiatorPropertyIds) {
      if (propertyOwnership[propId] !== p1.id) {
        addLog("⚠️ Trade failed: property ownership changed.");
        return;
      }
    }
    for (const propId of trade.targetPropertyIds) {
      if (propertyOwnership[propId] !== p2.id) {
        addLog("⚠️ Trade failed: property ownership changed.");
        return;
      }
    }

    // Execute atomic exchange
    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id === p1.id) {
          return { ...p, money: p.money - trade.initiatorMoney + trade.targetMoney };
        }
        if (p.id === p2.id) {
          return { ...p, money: p.money - trade.targetMoney + trade.initiatorMoney };
        }
        return p;
      })
    );

    setPropertyOwnership((prev) => {
      const next = { ...prev };
      for (const id of trade.initiatorPropertyIds) next[id] = p2.id;
      for (const id of trade.targetPropertyIds) next[id] = p1.id;
      return next;
    });

    const acceptedTrade: TradeProposal = { ...trade, status: "accepted" };
    setTrades((prev) => prev.map((t) => (t.id === tradeId ? acceptedTrade : t)));
    socketRef.current?.emit("trade:accepted", { trade: acceptedTrade });
    addLog(`🎉 Trade completed between ${p1.name} and ${p2.name}!`);
    setActiveTradeModal(null);
  };

  const handleDeclineTrade = (tradeId: string) => {
    const trade = trades.find((t) => t.id === tradeId);
    if (!trade) return;
    const target = players.find((p) => p.id === trade.targetId);
    const initiator = players.find((p) => p.id === trade.initiatorId);

    setTrades((prev) => prev.map((t) => (t.id === tradeId ? { ...t, status: "rejected" } : t)));
    socketRef.current?.emit("trade:rejected", { tradeId });
    addLog(`❌ ${target?.name || "Player"} declined the trade from ${initiator?.name || "Player"}.`);
    setActiveTradeModal(null);
  };

  const handleCancelTrade = (tradeId: string) => {
    const trade = trades.find((t) => t.id === tradeId);
    if (!trade) return;
    const initiator = players.find((p) => p.id === trade.initiatorId);

    setTrades((prev) => prev.filter((t) => t.id !== tradeId));
    socketRef.current?.emit("trade:cancelled", { tradeId });
    addLog(`🗑️ ${initiator?.name || "Player"} cancelled their trade proposal.`);
    setActiveTradeModal(null);
  };

  const handleStartNegotiation = (trade: TradeProposal) => {
    const isViewerTarget = currentPlayer?.id === trade.targetId;
    const otherPartnerId = isViewerTarget ? trade.initiatorId : trade.targetId;

    setTradeDraftTargetId(otherPartnerId);
    if (isViewerTarget) {
      setTradeDraftOfferedMoney(trade.targetMoney);
      setTradeDraftRequestedMoney(trade.initiatorMoney);
      setTradeDraftOfferedPropIds([...trade.targetPropertyIds]);
      setTradeDraftRequestedPropIds([...trade.initiatorPropertyIds]);
    } else {
      setTradeDraftOfferedMoney(trade.initiatorMoney);
      setTradeDraftRequestedMoney(trade.targetMoney);
      setTradeDraftOfferedPropIds([...trade.initiatorPropertyIds]);
      setTradeDraftRequestedPropIds([...trade.targetPropertyIds]);
    }

    setNegotiatingTradeId(trade.id);
    setActiveTradeModal("create");
  };

  const handleSendChatMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim()) return;

    const sender = currentPlayer || players[0];
    const newMsg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      senderId: sender?.id || 1,
      senderName: sender?.name || `Player ${sender?.id || 1}`,
      senderColor: sender?.color || "#a855f7",
      text: chatInput.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setChatMessages((prev) => [...prev, newMsg]);
    setChatInput("");

    if (socketRef.current) {
      socketRef.current.emit("chat:message", newMsg);
    }
  };

  // ================= AUCTION SYSTEM HANDLERS =================
  const startAuction = (tile: Tile) => {
    if (!enableAuction) return;

    const newAuction: AuctionState = {
      id: `auc-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      tileId: tile.id,
      currentBid: 2, // Starts at $2 per requirements
      highestBidderId: null,
      passedPlayerIds: [],
      timeLeft: 15,
    };

    setActiveAuction(newAuction);
    setActiveModal(null);
    socketRef.current?.emit("auction:start", { auction: newAuction });
    addLog(`🔨 AUCTION STARTED for ${tile.name}! Bidding starts at $2.`);
  };

  const handlePlaceBid = (increment: number) => {
    if (!activeAuction || !currentPlayer) return;

    const newBidAmount = activeAuction.currentBid + increment;

    if (currentPlayer.money < newBidAmount) {
      addLog(`⚠️ You don't have $${newBidAmount.toLocaleString()} to bid.`);
      return;
    }

    if (activeAuction.highestBidderId === currentPlayer.id) {
      addLog("⚠️ You are already the highest bidder!");
      return;
    }

    const updatedAuction: AuctionState = {
      ...activeAuction,
      currentBid: newBidAmount,
      highestBidderId: currentPlayer.id,
      timeLeft: 15, // Reset timer to 15s on new bid
    };

    setActiveAuction(updatedAuction);
    socketRef.current?.emit("auction:bid", { auction: updatedAuction });
    addLog(`🔨 ${currentPlayer.name} bid $${newBidAmount} on ${BOARD_TILES.find((t) => t.id === activeAuction.tileId)?.name || "property"}!`);
  };

  const handlePassAuction = () => {
    if (!activeAuction || !currentPlayer) return;
    if (activeAuction.passedPlayerIds.includes(currentPlayer.id)) return;

    const updatedPassed = [...activeAuction.passedPlayerIds, currentPlayer.id];
    const updatedAuction: AuctionState = {
      ...activeAuction,
      passedPlayerIds: updatedPassed,
    };

    setActiveAuction(updatedAuction);
    socketRef.current?.emit("auction:pass", { auction: updatedAuction });
    addLog(`❌ ${currentPlayer.name} passed on the auction.`);

    const remainingActive = alivePlayers.filter((p) => !updatedPassed.includes(p.id));
    if (
      remainingActive.length === 0 ||
      (remainingActive.length === 1 && activeAuction.highestBidderId === remainingActive[0].id)
    ) {
      handleEndAuction(updatedAuction);
    }
  };

  const handleEndAuction = (auctionToEnd: AuctionState) => {
    const tile = BOARD_TILES.find((t) => t.id === auctionToEnd.tileId);
    if (!tile) {
      setActiveAuction(null);
      return;
    }

    if (auctionToEnd.highestBidderId !== null) {
      const winnerPlayer = players.find((p) => p.id === auctionToEnd.highestBidderId);
      if (winnerPlayer) {
        setPlayers((prev) =>
          prev.map((p) => (p.id === winnerPlayer.id ? { ...p, money: p.money - auctionToEnd.currentBid } : p))
        );
        setPropertyOwnership((prev) => ({ ...prev, [tile.id]: winnerPlayer.id }));
        addLog(`🎉 AUCTION WON! ${winnerPlayer.name} won ${tile.name} for $${auctionToEnd.currentBid}!`);
        socketRef.current?.emit("property:bought", { tileId: tile.id, playerId: winnerPlayer.id });
        socketRef.current?.emit("auction:end", { auction: auctionToEnd });
      }
    } else {
      addLog(`🔨 Auction for ${tile.name} ended with no bids. Property remains unowned.`);
      socketRef.current?.emit("auction:end", { auction: auctionToEnd });
    }

    setActiveAuction(null);
  };

  // Auction countdown timer
  useEffect(() => {
    if (!activeAuction) return;

    const interval = window.setInterval(() => {
      setActiveAuction((prev) => {
        if (!prev) return null;
        if (prev.timeLeft <= 1) {
          handleEndAuction(prev);
          return null;
        }
        return { ...prev, timeLeft: prev.timeLeft - 1 };
      });
    }, 1000);

    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAuction?.id, activeAuction?.currentBid]);

  const upgradeHouse = (tileId: number) => {
    if (!currentPlayer) return;
    const tile = BOARD_TILES.find((t) => t.id === tileId);
    if (!tile || !PROPERTY_TYPES.has(tile.type) || propertyOwnership[tileId] !== currentPlayer.id) return;

    const currentHouses = propertyHouses[tileId] || 0;
    if (currentHouses >= 5) return;

    const cost = currentHouses === 4 ? tile.hotelCost || 200 : tile.houseCost || 100;
    if (currentPlayer.money < cost) {
      addLog("Not enough money.");
      return;
    }

    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, money: p.money - cost } : p))
    );
    setPropertyHouses((prev) => ({ ...prev, [tileId]: currentHouses + 1 }));
    addLog(`${currentPlayer.name} built on ${tile.name} (-$${cost})`);
    socketRef.current?.emit("house:upgraded", { tileId, houses: currentHouses + 1 });
  };

  // Sells the WHOLE tile (property or utility) back to the bank for half its
  // original purchase price - distinct from downgradeHouse, which only sells
  // a single house/hotel level off a property that stays owned.
  const sellPropertyEntirely = (tileId: number) => {
    if (!currentPlayer) return;
    const tile = BOARD_TILES.find((t) => t.id === tileId);
    if (!tile || propertyOwnership[tileId] !== currentPlayer.id) return;

    const price = Math.abs(parsePrice(tile.price) || 0);
    const refund = Math.floor(price / 2);

    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, money: p.money + refund } : p))
    );
    setPropertyOwnership((prev) => {
      const next = { ...prev };
      delete next[tileId];
      return next;
    });
    setPropertyHouses((prev) => ({ ...prev, [tileId]: 0 }));
    addLog(`${currentPlayer.name} sold ${tile.name} back to the bank (+$${refund})`);
    setActiveModal(null);
  };

  const downgradeHouse = (tileId: number) => {
    if (!currentPlayer) return;
    const tile = BOARD_TILES.find((t) => t.id === tileId);
    if (!tile || propertyOwnership[tileId] !== currentPlayer.id) return;

    const currentHouses = propertyHouses[tileId] || 0;
    if (currentHouses <= 0) return;

    // Refund 50% of whatever it actually cost to build the level being
    // removed - a hotel (level 5) was built with hotelCost, everything
    // below that with houseCost.
    const costOfCurrentLevel = currentHouses === 5 ? tile.hotelCost || 200 : tile.houseCost || 100;
    const refund = Math.floor(costOfCurrentLevel / 2);
    setPropertyHouses((prev) => ({ ...prev, [tileId]: currentHouses - 1 }));
    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, money: p.money + refund } : p))
    );
    addLog(`${currentPlayer.name} sold a house on ${tile.name} (+$${refund})`);
  };

  const getTilePosition = (index: number) => {
    if (index <= 10) return { gridRow: 11, gridColumn: 11 - index, orientation: "bottom" };
    if (index <= 19) return { gridRow: 21 - index, gridColumn: 1, orientation: "left" };
    if (index <= 30) return { gridRow: 1, gridColumn: index - 19, orientation: "top" };
    if (index <= 39) return { gridRow: index - 29, gridColumn: 11, orientation: "right" };
    return { gridRow: 1, gridColumn: 1, orientation: "none" };
  };

  const getTileOwner = (tileId: number) => {
    const ownerId = propertyOwnership[tileId];
    return ownerId ? players.find((p) => p.id === ownerId) : undefined;
  };

  const getTransparentColor = (hex: string, alpha: string) => `${hex}${alpha}`;

  const handleTileClick = (tile: Tile) => {
    if (tile.type === "card") {
      setSpecialModal(tile.name === "TREASURE" ? "treasure" : "surprise");
      return;
    }
    if (tile.type === "tax") {
      setSpecialModal("tax");
      return;
    }
    if (tile.id === 20) {
      setSpecialModal("resthouse");
      return;
    }
    if (tile.type !== "corner") setActiveModal(tile);
  };

  // Small reusable rendering of a player's board token face, sized down
  // for use in the sidebars - mirrors the same happy/flat expression logic
  // used on the actual board tokens, so a mood change updates everywhere
  // this player's face appears at once.
  const renderPlayerFace = (player: Player, size: string) => (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-full"
      style={{
        height: size,
        width: size,
        background: `radial-gradient(circle at 30% 24%, ${player.color}ff, ${player.color}ee 42%, ${player.color} 68%, #00000066 100%)`,
        border: `0.09vmin solid ${player.color}`,
        boxShadow: player.isCurrentPlayer
          ? `0 0 1.8vmin ${player.color}cc, 0 0 0.5vmin ${player.color}, 0 0.7vmin 1.3vmin rgba(0,0,0,0.75), inset 0 0.25vmin 0.35vmin rgba(255,255,255,0.45), inset 0 -0.3vmin 0.4vmin rgba(0,0,0,0.35)`
          : `0 0 0.6vmin ${player.color}aa, 0 0.5vmin 1vmin rgba(0,0,0,0.65), inset 0 0.22vmin 0.3vmin rgba(255,255,255,0.35), inset 0 -0.25vmin 0.35vmin rgba(0,0,0,0.3)`,
        animation: player.isCurrentPlayer ? `tokenGlow 1.4s ease-in-out infinite ${(player.id % 4) * 0.15}s` : undefined,
      }}
    >
      <div
        className="pointer-events-none absolute left-[16%] top-[12%] h-[38%] w-[38%] rounded-full opacity-80"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%)" }}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {player.mood === "flat" ? (
          <>
            <div className="flex gap-[0.4vmin]">
              <div className="h-[0.22vmin] w-[0.6vmin] rounded-full bg-white/95" />
              <div className="h-[0.22vmin] w-[0.6vmin] rounded-full bg-white/95" />
            </div>
            <div className="mt-[0.22vmin] h-[0.22vmin] w-[0.9vmin] rounded-full bg-white/85" />
          </>
        ) : (
          <>
            <div className="flex gap-[0.4vmin]">
              <div className="h-[0.44vmin] w-[0.44vmin] rounded-full bg-white/95" />
              <div className="h-[0.44vmin] w-[0.44vmin] rounded-full bg-white/95" />
            </div>
            <div className="mt-[0.08vmin] h-[0.36vmin] w-[0.68vmin] rounded-b-full border-b-[0.14vmin] border-l-[0.14vmin] border-r-[0.14vmin] border-white/85 bg-transparent" />
          </>
        )}
      </div>
    </div>
  );

  return (
    <main className="flex h-screen w-screen items-center justify-start overflow-hidden bg-[#050508] bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#110d1c] to-[#050508] p-[1vmin] font-sans">
      <style jsx global>{`
        @keyframes tokenBounce {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-18%) scale(1.06); }
        }
        @keyframes tokenGlow {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.3); }
        }
        @keyframes tokenIdle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8%); }
        }
        @keyframes nameDodge {
          0% { transform: translateY(0); }
          35% { transform: translateY(160%); }
          100% { transform: translateY(0); }
        }
        @keyframes jailRattle {
          0%, 100% { transform: translateX(0) rotate(0deg); }
          20% { transform: translateX(-6%) rotate(-4deg); }
          40% { transform: translateX(5%) rotate(3deg); }
          60% { transform: translateX(-4%) rotate(-3deg); }
          80% { transform: translateX(3%) rotate(2deg); }
        }
        @keyframes jailBreak {
          0% { transform: scale(1) rotate(0deg); }
          35% { transform: scale(1.45) rotate(-12deg); }
          60% { transform: scale(1.2) rotate(10deg); }
          80% { transform: scale(1.08) rotate(-5deg); }
          100% { transform: scale(1) rotate(0deg); }
        }
      `}</style>

      <div className="flex h-[96vmin] w-full items-center gap-[1.6vmin]">
        {/* ================= LEFT SIDEBAR - PROPERTIES YOU OWN ================= */}
        <div className="flex max-h-[96vmin] w-[32vmin] flex-col self-start rounded-[1.4vmin] border border-white/10 bg-[#0f0c16]/90 p-[1.1vmin] shadow-[0_0_2vmin_rgba(139,92,246,0.12)]">
          {/* Balance card - total cash on hand plus the player's own recent
              gains/losses (green for +, red for -), pulled straight out of
              the shared action log so it never drifts out of sync with it.
              Includes BOTH directions of money movement: things this player
              did themselves (bought/sold/paid tax) AND things other players
              did that affected them directly, like someone else paying them
              rent, so a payment received never fails to show up here. */}
          <div className="mb-[1vmin] rounded-[1vmin] border border-white/10 bg-white/[0.05] p-[1vmin]">
            <div className="flex items-center justify-between px-[0.2vmin]">
              <span className="text-[1.15vmin] font-black uppercase tracking-widest text-gray-300">Balance</span>
              <span className="text-[1.9vmin] font-black tracking-tight text-emerald-400">
                ${players[0].money.toLocaleString()}
              </span>
            </div>
            {(() => {
              const myRecent = actionLog.filter((msg) => isBalanceRelevant(msg, players[0].name)).slice(0, 5);
              if (myRecent.length === 0) return null;
              return (
                <div className="mt-[0.7vmin] flex flex-col gap-[0.35vmin] border-t border-white/10 pt-[0.6vmin]">
                  {myRecent.map((msg, i) => (
                    <p key={i} className="truncate px-[0.2vmin] text-[1.15vmin] font-semibold leading-snug text-gray-200">
                      {renderLogMessage(msg)}
                    </p>
                  ))}
                </div>
              );
            })()}
          </div>

          <div className="mb-[0.8vmin] flex items-center gap-[0.5vmin] px-[0.3vmin]">
            <span className="h-[1vmin] w-[1vmin] rounded-full" style={{ backgroundColor: players[0].color }} />
            <h2 className="text-[1.4vmin] font-black uppercase tracking-widest text-white">My Properties</h2>
          </div>

          {(() => {
            const myProperties = BOARD_TILES.filter((t) => propertyOwnership[t.id] === players[0].id);
            if (myProperties.length === 0) {
              return (
                <p className="mt-[1vmin] px-[0.3vmin] text-[1vmin] leading-snug text-gray-500">
                  You don't own any properties yet. Buy one when you land on it!
                </p>
              );
            }
            return (
              <div className="flex flex-col gap-[0.8vmin]">
                {myProperties.map((tile) => {
                  const houses = propertyHouses[tile.id] || 0;
                  const isHotel = houses >= 5;
                  return (
                    <button
                      key={tile.id}
                      onClick={() => setActiveModal(tile)}
                      className="group flex w-full items-center gap-[0.9vmin] rounded-[0.9vmin] border border-white/10 bg-white/[0.05] px-[0.9vmin] py-[0.9vmin] text-left transition-all duration-200 hover:scale-[1.04] hover:border-white/40 hover:bg-white/[0.1] hover:shadow-[0_0_1.4vmin_rgba(255,255,255,0.2)]"
                    >
                      {tile.countryCode ? (
                        <div className="h-[2.4vmin] w-[3.6vmin] shrink-0 overflow-hidden rounded-[0.35vmin] border border-white/25 shadow-md transition-transform duration-200 group-hover:scale-105">
                          <Flag code={tile.countryCode} className="h-full w-full object-cover" />
                        </div>
                      ) : (
                        <span className="shrink-0 text-[2.2vmin] leading-none transition-transform duration-200 group-hover:scale-110">
                          {tile.icon}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[1.25vmin] font-black uppercase leading-tight text-white">
                          {tile.name}
                        </div>
                        <div className="mt-[0.3vmin] flex items-center gap-[0.5vmin]">
                          <span className="text-[1.4vmin] font-black leading-none text-emerald-400">{tile.price}</span>
                          {PROPERTY_TYPES.has(tile.type) && houses > 0 && (
                            <span className="flex items-center text-[1.05vmin] leading-none" title={isHotel ? "Hotel" : `${houses} house(s)`}>
                              {isHotel ? "🏨" : "🏠"}
                              {!isHotel && houses > 1 ? <span className="ml-[0.15vmin] text-[0.95vmin] text-gray-400">×{houses}</span> : null}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>

        <div
          className="relative grid aspect-square h-[96vmin] w-[96vmin] shrink-0 rounded-[2vmin] border-[0.3vmin] border-indigo-400/30 bg-[#0f0c16] p-[0.4vmin] shadow-[0_0_5vmin_rgba(139,92,246,0.15),inset_0_0_0_0.15vmin_rgba(255,255,255,0.06)]"
          style={{
            gridTemplateColumns: `${CORNER_FR}fr repeat(9, 1fr) ${CORNER_FR}fr`,
            gridTemplateRows: `${CORNER_FR}fr repeat(9, 1fr) ${CORNER_FR}fr`,
            gap: `${BOARD_GAP_VMIN}vmin`,
          }}
        >
          {/* BOARD TILES */}
          {BOARD_TILES.map((tile, i) => {
            const { gridRow, gridColumn, orientation } = getTilePosition(i);
            const isCorner = [0, 10, 20, 30].includes(i);
            const isProperty = PROPERTY_TYPES.has(tile.type);
            const isUtility = UTILITY_TYPES.has(tile.type);
            const owner = isProperty || isUtility ? getTileOwner(tile.id) : undefined;
            const playersHere = players.filter((p) => p.position === tile.id);
            const isOccupied = playersHere.length > 0;
            const occupantsKey = playersHere.map((p) => p.id).join("-");
            const tokenAnchor = getTokenAnchor(orientation, isCorner, tile.id);

            const ownerStripClass =
              orientation === "top"
                ? "absolute left-0 right-0 top-0 z-30 h-[0.55vmin]"
                : orientation === "left"
                  ? "absolute bottom-0 left-0 top-0 z-30 w-[0.55vmin]"
                  : orientation === "right"
                    ? "absolute bottom-0 right-0 top-0 z-30 w-[0.55vmin]"
                    : "absolute bottom-0 left-0 right-0 z-30 h-[0.55vmin]";

            const ownedBackground = owner ? getTransparentColor(owner.color, "25") : undefined;
            const ownedBorder = owner ? getTransparentColor(owner.color, "90") : undefined;
            const houses = propertyHouses[tile.id] || 0;
            const isHotel = houses >= 5;
            const isSelectedOwner = selectedPlayerId != null && owner?.id === selectedPlayerId;
            const isDimmedBySelection = selectedPlayerId != null && !isSelectedOwner;

            return (
              <div
                key={tile.id}
                onClick={() => handleTileClick(tile)}
                className={`relative flex cursor-pointer items-center justify-center rounded-[0.9vmin] transition-all duration-300 hover:z-30 hover:scale-[1.04] ${owner ? "" : "shadow-lg hover:shadow-[0_0_2vmin_rgba(255,255,255,0.35)]"
                  } ${isCorner
                    ? "border-[0.25vmin] border-indigo-400/60 bg-gradient-to-br from-[#1e143c] to-[#120b24]"
                    : "border border-[#34404d] bg-[#171e26]/80"
                  } ${isDimmedBySelection ? "opacity-30 saturate-50" : ""} ${isSelectedOwner ? "scale-[1.05]" : ""}`}
                style={{
                  gridRow,
                  gridColumn,
                  // Once a house/hotel badge is built, it deliberately pokes
                  // outside this tile's own box (like the flag does on the
                  // opposite edge). Without a raised z-index here, the NEXT
                  // tile in the grid (a DOM sibling) paints on top of that
                  // overflow regardless of the badge's own z-index, since
                  // z-index only resolves within the same stacking parent -
                  // that's what was cutting a line through the badge.
                  zIndex: houses > 0 || isSelectedOwner ? 25 : undefined,
                  ...(owner
                    ? {
                      backgroundColor: ownedBackground,
                      borderColor: isSelectedOwner ? "#ffffff" : ownedBorder,
                      boxShadow: isSelectedOwner
                        ? `0 0 0 0.25vmin #ffffff, 0 0 2.4vmin ${owner.color}, 0 0 1vmin ${owner.color}`
                        : `0 0 1.8vmin ${owner.color}99, 0 0 0.5vmin ${owner.color}, inset 0 0 0.8vmin ${owner.color}33`,
                    }
                    : {}),
                }}
              >
                {isSelectedOwner && (
                  <div className="pointer-events-none absolute inset-0 z-40 animate-pulse rounded-[0.9vmin] ring-[0.3vmin] ring-white" />
                )}

                {!isCorner && tile.countryCode && (
                  <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[0.9vmin]">
                    <div className="absolute inset-0 flex scale-150 items-center justify-center opacity-25">
                      <Flag code={tile.countryCode} className="h-full w-full object-cover" />
                    </div>
                  </div>
                )}

                {owner && (
                  <div
                    className={ownerStripClass}
                    style={{ backgroundColor: owner.color, boxShadow: `0 0 0.8vmin ${owner.color}` }}
                  />
                )}

                {isOccupied && (
                  <div
                    className="pointer-events-none absolute z-50 flex items-center justify-center"
                    style={{
                      top: tokenAnchor.top,
                      left: tokenAnchor.left,
                      transform: "translate(-50%, -50%)",
                      width: isCorner ? "8.8vmin" : "6.6vmin",
                      maxHeight: isCorner ? "6.8vmin" : "5vmin",
                    }}
                  >
                    {(() => {
                      const count = playersHere.length;
                      // Token sizing: perfectly scaled so 1, 2, 3, 4, 5, or 6 tokens fit cleanly inside the tile box!
                      const tokenSizeVmin =
                        count === 1
                          ? 2.9
                          : count === 2
                            ? 2.35
                            : count <= 4
                              ? 2.05
                              : 1.8;
                      const sizeStr = `${tokenSizeVmin}vmin`;

                      // Grid arrangement for maximum symmetry and balance inside tile boundaries
                      const gridColsClass =
                        count === 1
                          ? "grid-cols-1"
                          : count === 2
                            ? "grid-cols-2 gap-[0.3vmin]"
                            : count <= 4
                              ? "grid-cols-2 gap-[0.25vmin]"
                              : "grid-cols-3 gap-[0.2vmin]";

                      return (
                        <div className={`grid items-center justify-items-center ${gridColsClass}`}>
                          {playersHere.map((player, idx) => {
                            const isEscaping = escapingIds.includes(player.id);
                            const colSpanClass =
                              count === 3 && idx === 2
                                ? "col-span-2 justify-self-center"
                                : count === 5 && idx === 4
                                  ? "col-span-3 justify-self-center"
                                  : "";

                            return (
                              <div
                                key={player.id}
                                className={`pointer-events-auto relative ${colSpanClass}`}
                                style={{
                                  height: sizeStr,
                                  width: sizeStr,
                                  zIndex: player.isCurrentPlayer ? 10 : idx,
                                  animation: player.inJail
                                    ? isEscaping
                                      ? "jailBreak 0.7s ease-out"
                                      : "jailRattle 1.8s ease-in-out infinite"
                                    : undefined,
                                }}
                              >
                                <div
                                  title={player.name || `Player ${player.id}`}
                                  className="relative flex h-full w-full items-center justify-center rounded-full transition-transform duration-300 hover:z-20 hover:scale-115"
                                  style={{
                                    background: `radial-gradient(circle at 30% 24%, ${player.color}ff, ${player.color}ee 42%, ${player.color} 68%, #00000066 100%)`,
                                    border: `0.09vmin solid ${player.color}`,
                                    boxShadow: player.isCurrentPlayer
                                      ? `0 0 1.6vmin ${player.color}cc, 0 0 0.5vmin ${player.color}, 0 0.5vmin 1vmin rgba(0,0,0,0.75), inset 0 0.2vmin 0.3vmin rgba(255,255,255,0.45), inset 0 -0.2vmin 0.3vmin rgba(0,0,0,0.35)`
                                      : `0 0 0.5vmin ${player.color}aa, 0 0.4vmin 0.8vmin rgba(0,0,0,0.65), inset 0 0.18vmin 0.25vmin rgba(255,255,255,0.35), inset 0 -0.2vmin 0.25vmin rgba(0,0,0,0.3)`,
                                    animation: player.isCurrentPlayer
                                      ? `tokenGlow 1.4s ease-in-out infinite ${(player.id % 4) * 0.15}s`
                                      : undefined,
                                  }}
                                >
                                  {/* Specular highlight */}
                                  <div
                                    className="pointer-events-none absolute left-[16%] top-[12%] h-[36%] w-[36%] rounded-full opacity-80"
                                    style={{
                                      background:
                                        "radial-gradient(circle, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%)",
                                    }}
                                  />

                                  {/* Face with Eyes & Mouth scaled proportionally to token size */}
                                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                                    {player.mood === "flat" ? (
                                      <>
                                        <div className="flex" style={{ gap: `${tokenSizeVmin * 0.12}vmin` }}>
                                          <div
                                            className="rounded-full bg-white/95"
                                            style={{
                                              height: `${tokenSizeVmin * 0.08}vmin`,
                                              width: `${tokenSizeVmin * 0.18}vmin`,
                                            }}
                                          />
                                          <div
                                            className="rounded-full bg-white/95"
                                            style={{
                                              height: `${tokenSizeVmin * 0.08}vmin`,
                                              width: `${tokenSizeVmin * 0.18}vmin`,
                                            }}
                                          />
                                        </div>
                                        <div
                                          className="rounded-full bg-white/85"
                                          style={{
                                            marginTop: `${tokenSizeVmin * 0.08}vmin`,
                                            height: `${tokenSizeVmin * 0.08}vmin`,
                                            width: `${tokenSizeVmin * 0.28}vmin`,
                                          }}
                                        />
                                      </>
                                    ) : (
                                      <>
                                        <div className="flex" style={{ gap: `${tokenSizeVmin * 0.14}vmin` }}>
                                          <div
                                            className="rounded-full bg-white/95"
                                            style={{
                                              height: `${tokenSizeVmin * 0.15}vmin`,
                                              width: `${tokenSizeVmin * 0.15}vmin`,
                                            }}
                                          />
                                          <div
                                            className="rounded-full bg-white/95"
                                            style={{
                                              height: `${tokenSizeVmin * 0.15}vmin`,
                                              width: `${tokenSizeVmin * 0.15}vmin`,
                                            }}
                                          />
                                        </div>
                                        <div
                                          className="rounded-b-full border-white/85 bg-transparent"
                                          style={{
                                            marginTop: `${tokenSizeVmin * 0.04}vmin`,
                                            height: `${tokenSizeVmin * 0.12}vmin`,
                                            width: `${tokenSizeVmin * 0.24}vmin`,
                                            borderBottomWidth: `${tokenSizeVmin * 0.04}vmin`,
                                            borderLeftWidth: `${tokenSizeVmin * 0.04}vmin`,
                                            borderRightWidth: `${tokenSizeVmin * 0.04}vmin`,
                                          }}
                                        />
                                      </>
                                    )}
                                  </div>
                                </div>

                                {/* Jail bars overlay */}
                                {player.inJail && !isEscaping && (
                                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-[0.1vmin] overflow-hidden rounded-full bg-black/15">
                                    <div className="h-[85%] w-[0.14vmin] rounded-full bg-white/85 shadow-[0_0_0.2vmin_rgba(0,0,0,0.6)]" />
                                    <div className="h-[85%] w-[0.14vmin] rounded-full bg-white/85 shadow-[0_0_0.2vmin_rgba(0,0,0,0.6)]" />
                                    <div className="h-[85%] w-[0.14vmin] rounded-full bg-white/85 shadow-[0_0_0.2vmin_rgba(0,0,0,0.6)]" />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {isCorner ? (
                  <div className="z-10 flex flex-col items-center justify-center gap-[0.3vmin]">
                    <span
                      className={`${tile.id === 20 ? "text-[3.2vmin]" : "text-[3.8vmin]"
                        } ${isOccupied ? "opacity-20 scale-80" : ""} drop-shadow-[0_0_1vmin_rgba(255,255,255,0.4)] transition-all`}
                    >
                      {tile.icon}
                    </span>
                    <div className="text-center text-[1.3vmin] font-black uppercase leading-tight tracking-wider text-white drop-shadow-md">
                      {tile.name}
                    </div>
                    {tile.id === 20 && restHouseMode === "pot" && (
                      <div
                        className={`mt-[0.3vmin] flex items-center gap-[0.35vmin] rounded-full border px-[0.9vmin] py-[0.2vmin] shadow-md transition-all ${restHousePot > 0
                            ? "border-emerald-400 bg-[#072518] shadow-[0_0_1.4vmin_rgba(16,185,129,0.65)] animate-pulse"
                            : "border-white/20 bg-white/10"
                          }`}
                      >
                        <span className="text-[1.1vmin] leading-none">💰</span>
                        <span
                          className={`text-[1.35vmin] font-black leading-none ${restHousePot > 0 ? "text-emerald-300" : "text-gray-300"
                            }`}
                        >
                          ${restHousePot.toLocaleString()}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="relative z-40 flex h-full w-full items-center justify-center p-[0.6vmin]">
                    <div
                      className={`absolute left-1/2 top-1/2 flex items-center justify-start ${orientation === "top" ? "flex-col-reverse" : "flex-col"
                        }`}
                      style={{
                        width: `${CONTENT_BLOCK_WIDTH_VMIN}vmin`,
                        height: `${CONTENT_BLOCK_HEIGHT_VMIN}vmin`,
                        transform:
                          orientation === "left"
                            ? "translate(-50%, -50%) rotate(90deg)"
                            : orientation === "right"
                              ? "translate(-50%, -50%) rotate(-90deg)"
                              : "translate(-50%, -50%)",
                      }}
                    >
                      <div
                        className={`absolute left-1/2 z-40 flex -translate-x-1/2 items-center justify-center ${orientation === "top" ? "bottom-0 translate-y-1/2" : "top-0 -translate-y-1/2"
                          }`}
                      >
                        {tile.countryCode ? (
                          <div
                            className={`h-[3vmin] w-[4.6vmin] overflow-hidden rounded-[0.5vmin] border-[0.22vmin] shadow-lg transition-all duration-300 ${isOccupied ? "scale-110 border-white shadow-[0_0_1.4vmin_rgba(255,255,255,0.5)]" : "border-white/80"
                              }`}
                          >
                            <Flag code={tile.countryCode} className="h-full w-full object-cover" />
                          </div>
                        ) : (
                          <span className={`text-[3.4vmin] drop-shadow-xl transition-transform duration-300 ${isOccupied ? "scale-110" : ""}`}>
                            {tile.icon}
                          </span>
                        )}
                      </div>

                      <div className="h-[18%] w-full" />

                      <div className="flex-1" />

                      <div
                        key={`name-${tile.id}-${occupantsKey}`}
                        className="relative flex min-w-0 flex-col items-center justify-center overflow-visible text-center"
                        style={{ animation: isOccupied ? "nameDodge 0.7s ease-in-out" : "none" }}
                      >
                        <span
                          className={`relative z-[60] whitespace-nowrap font-bold uppercase leading-tight tracking-wide text-gray-100 ${isOccupied ? "rounded-[0.4vmin] bg-[#0f0c16]/90 px-[0.5vmin] py-[0.1vmin] shadow-md" : ""
                            }`}
                          style={{ fontSize: `${getNameFontSize(tile.name)}vmin` }}
                        >
                          {tile.name}
                        </span>
                      </div>

                      {!owner && tile.price ? (
                        <div
                          className={`m-[0.2vmin] flex h-[2.6vmin] w-[85%] max-w-[7vmin] items-center justify-center rounded-[0.35vmin] text-center font-black ${tile.price.includes("-")
                              ? "bg-red-500/80 text-white"
                              : "border border-[#526171] bg-[#293541] text-[#e7eef5]"
                            }`}
                        >
                          <span className="whitespace-nowrap text-[1.15vmin]">{tile.price}</span>
                        </div>
                      ) : owner ? (
                        <div
                          className={`m-[0.2vmin] flex h-[2.6vmin] w-[85%] max-w-[7vmin] items-center justify-center rounded-[0.3vmin] text-center font-black uppercase tracking-wide ${isProperty && houses > 0 ? "invisible" : ""
                            }`}
                          style={{ color: owner.color, backgroundColor: `${owner.color}18` }}
                        >
                          <span className="whitespace-nowrap text-[0.9vmin]">Owned</span>
                        </div>
                      ) : null}

                      {/* House/hotel indicator - mirrors how the flag pokes
                        half outside the tile's top edge, but sits on the
                        OPPOSITE edge (same side as price/Owned), half
                        outside the border and half inside. Only shown for
                        property-type tiles (utilities don't have houses)
                        once at least one house has been built. */}
                      {owner && isProperty && houses > 0 && (
                        <div
                          className={`absolute left-1/2 z-[70] flex -translate-x-1/2 items-center justify-center gap-[0.35vmin] rounded-[0.5vmin] border-[0.2vmin] px-[0.6vmin] shadow-lg ${orientation === "top" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2"
                            }`}
                          style={{
                            height: "2.7vmin",
                            borderColor: "rgba(255,255,255,0.85)",
                            backgroundColor: owner.color,
                            boxShadow: `0 0 1vmin ${owner.color}aa, 0 0.3vmin 0.7vmin rgba(0,0,0,0.55)`,
                          }}
                        >
                          {isHotel ? (
                            <span className="text-[1.6vmin] leading-none drop-shadow-[0_0_0.3vmin_rgba(0,0,0,0.7)]">🏨</span>
                          ) : (
                            <>
                              <span className="text-[1.3vmin] leading-none drop-shadow-[0_0_0.3vmin_rgba(0,0,0,0.7)]">🏠</span>
                              <span className="text-[1.05vmin] font-black text-white drop-shadow-[0_0_0.3vmin_rgba(0,0,0,0.7)]">
                                x{houses}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* ================= CENTER CONSOLE ================= */}
          <div
            className="relative z-0 flex flex-col items-center justify-between overflow-y-auto rounded-[1.8vmin] border border-white/5 bg-[#0a0812] p-[1.6vmin] text-center shadow-2xl"
            style={{ gridRow: "2 / 11", gridColumn: "2 / 11", margin: "1.3vmin" }}
          >
            <div className="relative flex w-full items-center justify-between px-[0.4vmin]">
              {/* Leftmost: Fullscreen button */}
              <button
                onClick={toggleFullscreen}
                className="flex shrink-0 items-center gap-[0.5vmin] rounded-full border border-white/20 bg-white/[0.08] px-[1.6vmin] py-[0.7vmin] text-[1.35vmin] font-black text-white shadow-md transition-all hover:scale-[1.03] hover:border-white/40 hover:bg-white/[0.15] active:scale-95 cursor-pointer"
                title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
              >
                <span className="text-[1.4vmin]">{isFullscreen ? "⤢" : "⛶"}</span>
                <span className="whitespace-nowrap tracking-wide">{isFullscreen ? "Exit" : "Fullscreen"}</span>
              </button>

              {/* Center: Turn Timer (aligned exactly with YOUR TURN badge below) */}
              <div
                className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center select-none pointer-events-none"
                title={
                  !isGameStarted
                    ? "Turn Timer: 120s per turn"
                    : `${turnTimeLeft}s remaining for ${currentPlayer?.name?.trim() || `Player ${currentPlayer?.id || 1}`}'s turn`
                }
              >
                <span
                  className={`pointer-events-auto font-mono text-[2.7vmin] font-black tracking-wider tabular-nums transition-all ${isGameStarted && turnTimeLeft <= 10
                      ? "text-red-400 drop-shadow-[0_0_1.8vmin_rgba(239,68,68,0.85)] animate-pulse scale-105"
                      : isGameStarted && turnTimeLeft <= 30
                        ? "text-amber-400 drop-shadow-[0_0_1.5vmin_rgba(251,191,36,0.7)]"
                        : "text-yellow-400 drop-shadow-[0_0_1.4vmin_rgba(250,204,21,0.6)]"
                    }`}
                >
                  {formatTurnTime(turnTimeLeft)}
                </span>
              </div>

              {/* Rightmost: Room and LIVE connection indicator */}
              <div className="flex shrink-0 items-center gap-[0.7vmin] rounded-full border border-white/20 bg-white/[0.08] px-[1.6vmin] py-[0.7vmin] shadow-md">
                <div
                  className={`h-[1vmin] w-[1vmin] shrink-0 rounded-full ${isConnected
                      ? "animate-pulse bg-emerald-400 shadow-[0_0_1vmin_rgba(52,211,153,0.9)]"
                      : "bg-red-500 shadow-[0_0_1vmin_rgba(239,68,68,0.9)]"
                    }`}
                />
                <span className="whitespace-nowrap text-[1.35vmin] font-extrabold tracking-wide text-white">
                  {connectionLabel}
                </span>
              </div>
            </div>

            <div>
              <div
                className={`mx-auto w-fit rounded-full border px-[1.8vmin] py-[0.4vmin] text-[1.1vmin] font-black uppercase tracking-widest ${gamePhase === "YOUR TURN"
                    ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
                    : gamePhase === "MOVING..." || gamePhase === "ROLLING..."
                      ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-400"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  }`}
              >
                {gamePhase}
              </div>
            </div>

            {/* 3D Dice - back to its original size */}
            <div className="-mt-2 mb-2 flex justify-center">
              <DiceScene dice={dice} rollTrigger={rollTrigger} onSettled={handleDiceSettled} />
            </div>

            {/* Action Log - money amounts highlighted: +$ gains green, -$ losses red */}
            <div className="flex h-[8.5vmin] w-full max-w-[42vmin] flex-col items-center justify-start overflow-hidden rounded-[1vmin] border border-white/5 bg-black/40 px-[1.5vmin] pb-[0.3vmin] pt-[0.3vmin] text-center -translate-y-[3.5vmin]">
              <div>
                {actionLog.slice(0, 3).map((msg, i) => (
                  <p key={i} className={`text-[1.55vmin] leading-snug ${i === 0 ? "text-gray-100" : "text-gray-500"}`}>
                    {renderLogMessage(msg)}
                  </p>
                ))}
              </div>
            </div>

            <div className="flex w-full max-w-[44vmin] gap-[1.2vmin] -translate-y-[3.5vmin]">
              {gamePhase === "YOUR TURN" ? (
                <>
                  {currentPlayer?.inJail && (
                    <button
                      onClick={payBail}
                      disabled={(currentPlayer.money ?? 0) < 100}
                      className="flex-1 rounded-[1.1vmin] border border-white/20 bg-gradient-to-r from-amber-600 to-orange-600 py-[1.6vmin] text-[1.6vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      🔓 Pay Bail $100
                    </button>
                  )}

                  <button
                    onClick={rollDice}
                    disabled={isRolling || isMoving}
                    className="flex-1 rounded-[1.1vmin] border border-white/20 bg-gradient-to-r from-indigo-600 to-purple-600 py-[1.6vmin] text-[1.6vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isRolling ? "Rolling..." : currentPlayer?.inJail ? "🎲 Roll for Doubles" : "🎲 Roll Dice"}
                  </button>

                  {!currentPlayer?.inJail && enableMovementCards && (
                    <button
                      onClick={openSkillCard}
                      disabled={!hasSkillCard || isRolling || isMoving}
                      className="relative flex-1 rounded-[1.1vmin] border border-white/20 bg-gradient-to-r from-emerald-600 to-teal-600 py-[1.6vmin] text-[1.6vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {hasSkillCard ? "🃏 Card" : "Exhausted"}
                    </button>
                  )}
                </>
              ) : (
                <button
                  onClick={endTurn}
                  disabled={gamePhase !== "ACTION" && gamePhase !== "END TURN"}
                  className="flex-1 rounded-[1.1vmin] border border-white/15 bg-white/10 py-[1.6vmin] text-[1.6vmin] font-black uppercase text-gray-300 transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  End Turn
                </button>
              )}
            </div>
          </div>

          {/* ================= PROPERTY MODAL ================= */}
          {activeModal && (
            <div
              className="absolute inset-0 z-[100] flex items-center justify-center rounded-[2vmin] bg-black/70 p-[4vmin] backdrop-blur-md"
              onClick={() => setActiveModal(null)}
            >
              <div className="relative w-[42vmin]" onClick={(e) => e.stopPropagation()}>
                {/* Flag / icon badge - centered on the card's top edge, half
                  poking out above the header, half sitting inside it. */}
                <div className="absolute left-1/2 top-0 z-20 -translate-x-1/2 -translate-y-1/2">
                  {activeModal.countryCode ? (
                    <div className="h-[5vmin] w-[7.6vmin] overflow-hidden rounded-[0.8vmin] border-[0.28vmin] border-white shadow-[0_0.4vmin_1vmin_rgba(0,0,0,0.6)]">
                      <Flag code={activeModal.countryCode} className="h-full w-full object-cover" />
                    </div>
                  ) : (
                    <div className="flex h-[5.4vmin] w-[5.4vmin] items-center justify-center rounded-full border-[0.28vmin] border-white bg-[#1c1730] text-[2.6vmin] shadow-[0_0.4vmin_1vmin_rgba(0,0,0,0.6)]">
                      {activeModal.icon}
                    </div>
                  )}
                </div>

                <div
                  className="overflow-hidden rounded-[1.8vmin] border bg-[#161224] shadow-2xl"
                  style={{
                    borderColor: getTileOwner(activeModal.id)
                      ? `${getTileOwner(activeModal.id)!.color}66`
                      : "rgba(255,255,255,0.08)",
                  }}
                >
                  <div className="bg-gradient-to-r from-indigo-900/80 to-purple-900/60 px-[2.5vmin] pb-[1.8vmin] pt-[3.2vmin] text-center">
                    <h2 className="text-[2.6vmin] font-black uppercase tracking-wider text-white">
                      {activeModal.name}
                    </h2>
                    {getTileOwner(activeModal.id) && (
                      <div
                        className="mt-[0.6vmin] text-[1.1vmin] font-bold uppercase tracking-widest"
                        style={{ color: getTileOwner(activeModal.id)!.color }}
                      >
                        {getTileOwner(activeModal.id)!.id === currentPlayer?.id
                          ? "Your Property"
                          : `${getTileOwner(activeModal.id)!.name}'s Property`}
                      </div>
                    )}
                  </div>

                  <div className="p-[2.5vmin]">
                    {PROPERTY_TYPES.has(activeModal.type) &&
                      activeModal.rents &&
                      (() => {
                        const owner = getTileOwner(activeModal.id);
                        // No owner → nothing is "current" yet, so every row stays
                        // plain white. Owned → whichever tier (0 = base rent,
                        // 1-4 = houses, 5 = hotel) matches the actual house count
                        // lights up green; everything else stays white/gray.
                        const activeTier = owner ? Math.min(propertyHouses[activeModal.id] || 0, 5) : -1;
                        const rows = [
                          { label: "with rent", value: activeModal.rents[0] },
                          { label: "with one house", value: activeModal.rents[1] },
                          { label: "with two houses", value: activeModal.rents[2] },
                          { label: "with three houses", value: activeModal.rents[3] },
                          { label: "with four houses", value: activeModal.rents[4] },
                          { label: "with a hotel", value: activeModal.rents[5] },
                        ];

                        return (
                          <div className="mb-[2vmin] space-y-[0.7vmin] text-[1.35vmin]">
                            {rows.map((row, idx) => {
                              const isActive = idx === activeTier;
                              return (
                                <div
                                  key={row.label}
                                  className={`flex justify-between ${isActive ? "text-emerald-400" : "text-gray-400"}`}
                                >
                                  <span>{row.label}</span>
                                  <span className={`font-black ${isActive ? "text-emerald-400" : "font-bold text-white"}`}>
                                    ${row.value}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                    {/* Utility-style tiles (airports / electricity / internet): rent
                    scales with how many of that same type the owner holds,
                    not with houses - shown here as a simple tier list. */}
                    {UTILITY_TYPES.has(activeModal.type) && UTILITY_RENT_TABLE[activeModal.type] && (
                      <div className="mb-[2vmin] space-y-[0.7vmin] text-[1.35vmin]">
                        {UTILITY_RENT_TABLE[activeModal.type].map((amount, idx) => (
                          <div key={idx} className="flex justify-between text-gray-400">
                            <span>if owner holds {idx + 1}</span>
                            <span className="font-bold text-white">${amount}</span>
                          </div>
                        ))}
                        {getTileOwner(activeModal.id) && (
                          <div className="flex justify-between border-t border-white/10 pt-[0.7vmin] text-emerald-400">
                            <span>currently owns</span>
                            <span className="font-black">
                              {getUtilityOwnerCount(activeModal.type, getTileOwner(activeModal.id)!.id)} of this type
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between border-t border-white/10 pt-[1.5vmin] text-[1.4vmin]">
                      <div className="text-center">
                        <div className="text-gray-500">Price</div>
                        <div className="font-black text-white">{activeModal.price}</div>
                      </div>
                      {PROPERTY_TYPES.has(activeModal.type) && (
                        <>
                          <div className="text-center">
                            <div className="text-gray-500">🏠</div>
                            <div className="font-black text-white">${activeModal.houseCost ?? 100}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-gray-500">🏨</div>
                            <div className="font-black text-white">${activeModal.hotelCost ?? 100}</div>
                          </div>
                        </>
                      )}
                    </div>

                    {getTileOwner(activeModal.id)?.id === currentPlayer?.id &&
                      (() => {
                        const isUpgradable = PROPERTY_TYPES.has(activeModal.type);
                        const sellRefund = Math.floor(Math.abs(parsePrice(activeModal.price) || 0) / 2);
                        const currentHouses = propertyHouses[activeModal.id] || 0;
                        const maxedOut = currentHouses >= 5;
                        const upgradeCost = currentHouses === 4 ? activeModal.hotelCost ?? 200 : activeModal.houseCost ?? 100;
                        // Degrading always refunds 50% of the SAME cost that was
                        // paid to build the level currently being removed - e.g.
                        // upgrade to a hotel for $100, degrade it and get $50
                        // back (downgradeHouse already implements this refund).
                        const degradeCost = currentHouses === 5 ? activeModal.hotelCost ?? 200 : activeModal.houseCost ?? 100;
                        const degradeRefund = Math.floor(degradeCost / 2);
                        const canDegrade = currentHouses > 0;

                        return (
                          <div
                            className={`mt-[2vmin] grid gap-[1.2vmin] ${isUpgradable ? "grid-cols-3" : "grid-cols-1"
                              }`}
                          >
                            {enableMortgage && (
                            <button
                              onClick={() => sellPropertyEntirely(activeModal.id)}
                              className="rounded-[0.9vmin] border-[0.18vmin] border-red-500 bg-red-950/60 py-[1.2vmin] text-[1.1vmin] font-black uppercase text-red-100 shadow-[inset_0_0_1.4vmin_rgba(239,68,68,0.55),0_0_0.8vmin_rgba(239,68,68,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-red-400 hover:bg-red-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(239,68,68,0.85),0_0_1.6vmin_rgba(239,68,68,0.65)]"
                            >
                              Sell (+${sellRefund})
                            </button>
                            )}
                            {isUpgradable && (
                              <>
                                <button
                                  onClick={() => upgradeHouse(activeModal.id)}
                                  disabled={maxedOut}
                                  className="rounded-[0.9vmin] border-[0.18vmin] border-green-500 bg-green-950/60 py-[1.2vmin] text-[1.1vmin] font-black uppercase text-green-100 shadow-[inset_0_0_1.4vmin_rgba(34,197,94,0.55),0_0_0.8vmin_rgba(34,197,94,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-green-400 hover:bg-green-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(34,197,94,0.85),0_0_1.6vmin_rgba(34,197,94,0.65)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
                                >
                                  {maxedOut ? "Maxed" : `Upgrade (-$${upgradeCost})`}
                                </button>
                                <button
                                  onClick={() => downgradeHouse(activeModal.id)}
                                  disabled={!canDegrade}
                                  className="rounded-[0.9vmin] border-[0.18vmin] border-orange-500 bg-orange-950/60 py-[1.2vmin] text-[1.1vmin] font-black uppercase text-orange-100 shadow-[inset_0_0_1.4vmin_rgba(249,115,22,0.55),0_0_0.8vmin_rgba(249,115,22,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-orange-400 hover:bg-orange-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(249,115,22,0.85),0_0_1.6vmin_rgba(249,115,22,0.65)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
                                >
                                  {canDegrade ? `Degrade (+$${degradeRefund})` : "None Built"}
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })()}

                    {!getTileOwner(activeModal.id) && OWNABLE_TYPES.has(activeModal.type) && (
                      <div className="mt-[2vmin] flex gap-[1vmin]">
                        <button
                          onClick={() => buyProperty(activeModal)}
                          disabled={(currentPlayer?.money ?? 0) < (parsePrice(activeModal.price) || 0)}
                          className="flex-1 rounded-[0.9vmin] border-[0.18vmin] border-green-500 bg-green-950/60 py-[1.4vmin] text-[1.3vmin] font-black uppercase text-green-100 shadow-[inset_0_0_1.4vmin_rgba(34,197,94,0.55),0_0_0.8vmin_rgba(34,197,94,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-green-400 hover:bg-green-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(34,197,94,0.85),0_0_1.6vmin_rgba(34,197,94,0.65)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100 cursor-pointer"
                        >
                          Buy for {activeModal.price}
                        </button>
                        {enableAuction && (
                          <button
                            onClick={() => {
                              const tileToAuction = activeModal;
                              setActiveModal(null);
                              startAuction(tileToAuction);
                            }}
                            className="flex-1 rounded-[0.9vmin] border-[0.18vmin] border-amber-500 bg-amber-950/60 py-[1.4vmin] text-[1.3vmin] font-black uppercase text-amber-100 shadow-[inset_0_0_1.4vmin_rgba(245,158,11,0.55),0_0_0.8vmin_rgba(245,158,11,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-amber-400 hover:bg-amber-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(245,158,11,0.85),0_0_1.6vmin_rgba(245,158,11,0.65)] cursor-pointer"
                          >
                            🔨 Pass & Auction
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => setActiveModal(null)}
                  className="absolute right-[1.4vmin] top-[1.4vmin] z-30 text-[2vmin] text-white/50 hover:text-white"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* ================= SPECIAL RULE MODALS ================= */}
          {specialModal && (
            <div
              className="absolute inset-0 z-[110] flex items-center justify-center rounded-[2vmin] bg-black/75 p-[4vmin] backdrop-blur-md"
              onClick={() => setSpecialModal(null)}
            >
              <div
                className="w-[48vmin] rounded-[1.8vmin] border border-white/10 bg-[#111018] p-[3vmin] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {specialModal === "treasure" && (
                  <>
                    <div className="mb-[1.5vmin] text-center text-[3.5vmin]">🎁</div>
                    <h3 className="mb-[1.5vmin] text-center text-[2.4vmin] font-black uppercase tracking-widest text-yellow-300">
                      Treasure Chest
                    </h3>
                    <div className="space-y-[1vmin] text-[1.35vmin] text-gray-300">
                      <p className="font-bold text-white">Roll outcome:</p>
                      <p>• <span className="text-emerald-400">1–2</span> → Collect $100 from bank</p>
                      <p>• <span className="text-emerald-400">3–4</span> → Collect $200 + free Movement Card</p>
                      <p>• <span className="text-yellow-400">5</span> → Advance to nearest Airport</p>
                      <p>• <span className="text-red-400">6</span> → Pay $150 luxury tax</p>
                    </div>
                  </>
                )}

                {specialModal === "surprise" && (
                  <>
                    <div className="mb-[1.5vmin] text-center text-[3.5vmin]">❓</div>
                    <h3 className="mb-[1.5vmin] text-center text-[2.4vmin] font-black uppercase tracking-widest text-purple-300">
                      Surprise Card
                    </h3>
                    <div className="space-y-[1vmin] text-[1.35vmin] text-gray-300">
                      <p className="font-bold text-white">Roll outcome:</p>
                      <p>• <span className="text-red-400">1–2</span> → Go directly to JAIL</p>
                      <p>• <span className="text-yellow-400">3–4</span> → Jump forward 8 spaces</p>
                      <p>• <span className="text-emerald-400">5</span> → Receive $250 dividend</p>
                      <p>• <span className="text-blue-400">6</span> → Swap position with any player</p>
                    </div>
                  </>
                )}

                {specialModal === "tax" && (
                  <>
                    <div className="mb-[1.5vmin] text-center text-[3.5vmin]">📉</div>
                    <h3 className="mb-[1.5vmin] text-center text-[2.4vmin] font-black uppercase tracking-widest text-red-300">
                      Tax Office
                    </h3>
                    <div className="space-y-[1vmin] text-[1.35vmin] text-gray-300">
                      <p className="font-bold text-white">Fixed amounts:</p>
                      <p>• Income Tax → Pay <span className="text-red-400">$100</span></p>
                      <p>• Fixed Tax → Pay <span className="text-red-400">$200</span></p>
                      <p>• Luxury Tax → Pay <span className="text-red-400">$250</span></p>
                      <p className="mt-[1vmin] text-gray-500">Tax is mandatory when you land here.</p>
                    </div>
                  </>
                )}

                {specialModal === "resthouse" && (
                  <>
                    <div className="mb-[1.5vmin] text-center text-[3.8vmin]">🏨</div>
                    <h3 className="mb-[1vmin] text-center text-[2.4vmin] font-black uppercase tracking-widest text-emerald-400">
                      Rest House Pot
                    </h3>
                    <div className="mb-[1.8vmin] flex flex-col items-center justify-center rounded-[1.2vmin] border-2 border-emerald-400/40 bg-emerald-950/40 p-[1.6vmin] text-center">
                      <span className="text-[1.2vmin] font-bold uppercase tracking-wider text-gray-300">Current JackPot:</span>
                      <span className="text-[3.2vmin] font-black text-emerald-300 drop-shadow-lg">
                        ${restHousePot.toLocaleString()}
                      </span>
                    </div>
                    <div className="space-y-[0.8vmin] text-[1.3vmin] text-gray-300">
                      <p>• All luxury taxes, fines, bail, and club fees accumulate in this pot.</p>
                      <p>• Whoever lands directly on <span className="font-bold text-white">REST HOUSE</span> collects all stored money!</p>
                      <p>• You also take a relaxing rest for one turn.</p>
                    </div>
                  </>
                )}

                <button
                  onClick={() => setSpecialModal(null)}
                  className="mt-[2.5vmin] w-full rounded-[1vmin] bg-white/10 py-[1.3vmin] text-[1.3vmin] font-bold text-white hover:bg-white/20"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ================= MOVEMENT CARD SELECTOR ================= */}
          {showCardSelector && (
            <div
              className="absolute inset-0 z-[110] flex items-center justify-center rounded-[2vmin] bg-black/75 p-[4vmin] backdrop-blur-md"
              onClick={() => {
                setShowCardSelector(false);
                setSelectedCardValue(null);
              }}
            >
              <div
                className="w-[48vmin] rounded-[1.8vmin] border border-emerald-500/30 bg-[#111018] p-[2.8vmin] shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-[0.6vmin] text-center text-[2.6vmin] font-black uppercase tracking-widest text-white">
                  Movement Card
                </div>
                <p className="mb-[2vmin] text-center text-[1.2vmin] text-gray-400">
                  Choose how many spaces to move. Card recharges when you pass START.
                </p>

                <div className="grid grid-cols-3 gap-[1vmin]">
                  {[1, 2, 3, 4, 5, 6].map((value) => (
                    <button
                      key={value}
                      onClick={() => setSelectedCardValue(value)}
                      className={`rounded-[1vmin] border py-[1.8vmin] text-[2.6vmin] font-black transition-all ${selectedCardValue === value
                          ? "scale-105 border-emerald-400 bg-emerald-500/20 text-emerald-300"
                          : "border-white/10 bg-white/[0.03] text-white hover:border-white/30"
                        }`}
                    >
                      {value}
                    </button>
                  ))}
                </div>

                <div className="mt-[2vmin] flex gap-[1vmin]">
                  <button
                    onClick={() => {
                      setShowCardSelector(false);
                      setSelectedCardValue(null);
                    }}
                    className="flex-1 rounded-[0.9vmin] bg-white/5 py-[1.2vmin] text-[1.2vmin] font-bold text-gray-400 hover:bg-white/10"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmSkillCard}
                    disabled={!selectedCardValue}
                    className="flex-1 rounded-[0.9vmin] bg-gradient-to-r from-emerald-600 to-teal-600 py-[1.2vmin] text-[1.2vmin] font-black uppercase text-white disabled:opacity-30"
                  >
                    Confirm {selectedCardValue ? `→ ${selectedCardValue}` : ""}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ================= GAME OVER ================= */}
          {winner && (
            <div className="absolute inset-0 z-[130] flex items-center justify-center rounded-[2vmin] bg-black/85 p-[4vmin] backdrop-blur-md">
              <div
                className="w-[46vmin] rounded-[1.8vmin] border-2 p-[3vmin] text-center shadow-2xl"
                style={{ borderColor: winner.color, backgroundColor: "#111018" }}
              >
                <div className="mb-[1vmin] text-[4vmin]">🏆</div>
                <h2 className="mb-[0.5vmin] text-[2.6vmin] font-black uppercase tracking-widest text-white">
                  Game Over
                </h2>
                <p className="mb-[2vmin] text-[1.6vmin] font-bold" style={{ color: winner.color }}>
                  {winner.name} wins!
                </p>
                <p className="mb-[2vmin] text-[1.2vmin] text-gray-400">Every other player has gone bankrupt.</p>
                <button
                  onClick={() => window.location.reload()}
                  className="w-full rounded-[1vmin] bg-gradient-to-r from-indigo-600 to-purple-600 py-[1.4vmin] text-[1.3vmin] font-black uppercase text-white hover:scale-[1.02]"
                >
                  New Game
                </button>
              </div>
            </div>
          )}

          {/* ================= BANKRUPT CONFIRMATION MODAL ================= */}
          {showBankruptModal && bankruptCandidateId !== null && (
            <div
              className="absolute inset-0 z-[120] flex items-center justify-center rounded-[2vmin] bg-black/80 p-[4vmin] backdrop-blur-md"
              onClick={() => setShowBankruptModal(false)}
            >
              <div
                className="w-[44vmin] rounded-[1.8vmin] border border-red-500/40 bg-[#120f1d] p-[2.6vmin] text-center shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-[0.8vmin] text-[3.8vmin]">🏳️</div>
                <h3 className="mb-[0.5vmin] text-[2.2vmin] font-black uppercase tracking-wider text-red-400">
                  Declare Bankruptcy
                </h3>
                {(() => {
                  const targetPlayer = players.find((p) => p.id === bankruptCandidateId);
                  if (!targetPlayer) return null;
                  const ownedProps = BOARD_TILES.filter((t) => propertyOwnership[t.id] === targetPlayer.id);

                  return (
                    <>
                      <p className="text-[1.25vmin] text-gray-200">
                        Are you sure{" "}
                        <span className="font-bold" style={{ color: targetPlayer.color }}>
                          {targetPlayer.name}
                        </span>{" "}
                        wants to surrender and declare bankruptcy?
                      </p>
                      <p className="mt-[0.8vmin] text-[1.05vmin] text-gray-400">
                        Whoever clicks this gets out immediately. All {ownedProps.length} propert{ownedProps.length === 1 ? "y" : "ies"} will be returned to the bank.
                      </p>
                      <div className="mt-[2.2vmin] flex gap-[1vmin]">
                        <button
                          onClick={() => setShowBankruptModal(false)}
                          className="flex-1 rounded-[0.9vmin] bg-white/10 py-[1.1vmin] text-[1.2vmin] font-bold text-gray-300 hover:bg-white/20"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleVoluntaryBankruptcy(targetPlayer.id)}
                          className="flex-1 rounded-[0.9vmin] bg-gradient-to-r from-red-600 to-rose-600 py-[1.1vmin] text-[1.2vmin] font-black uppercase text-white shadow-lg shadow-red-600/30 hover:brightness-110 active:scale-95"
                        >
                          Yes, Bankrupt
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          {/* ================= CREATE / NEGOTIATE TRADE MODAL ================= */}
          {activeTradeModal === "create" && currentPlayer && (
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-[2vmin] backdrop-blur-md"
              onClick={() => setActiveTradeModal(null)}
            >
              <div
                className="relative flex max-h-[92vh] w-[88vmin] flex-col overflow-hidden rounded-[2vmin] border-2 border-purple-500/50 bg-[#120c24] text-white shadow-[0_0_5vmin_rgba(139,92,246,0.45)]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="relative border-b border-purple-500/30 bg-[#181133] py-[1.8vmin] text-center">
                  <h3 className="text-[2.3vmin] font-black uppercase tracking-wider text-white flex items-center justify-center gap-[0.8vmin]">
                    <span>🤝</span>
                    <span>{negotiatingTradeId ? "Negotiate Trade Offer" : "Create Trade Offer"}</span>
                  </h3>
                  <p className="mt-[0.2vmin] text-[1.1vmin] font-medium text-gray-300">
                    Exchange cash and property ownership with any active player
                  </p>
                  <button
                    onClick={() => setActiveTradeModal(null)}
                    className="absolute right-[1.8vmin] top-[1.6vmin] flex h-[3.4vmin] w-[3.4vmin] items-center justify-center rounded-full bg-white/10 text-[1.5vmin] text-gray-300 transition hover:bg-white/20 hover:text-white cursor-pointer"
                    title="Close Modal"
                  >
                    ✕
                  </button>
                </div>

                {/* Target Player Selector (Tabs) */}
                {alivePlayers.filter((p) => p.id !== currentPlayer.id).length > 0 && (
                  <div className="flex items-center gap-[1vmin] border-b border-white/10 bg-[#160e2e] px-[2.4vmin] py-[1.2vmin]">
                    <span className="text-[1.2vmin] font-black uppercase tracking-wider text-purple-300 shrink-0">
                      Trade Partner:
                    </span>
                    <div className="flex flex-wrap gap-[0.8vmin]">
                      {alivePlayers
                        .filter((p) => p.id !== currentPlayer.id)
                        .map((partner) => {
                          const isSelected = tradeDraftTargetId === partner.id;
                          return (
                            <button
                              key={partner.id}
                              onClick={() => {
                                setTradeDraftTargetId(partner.id);
                                setTradeDraftRequestedMoney(0);
                                setTradeDraftRequestedPropIds([]);
                              }}
                              className={`flex items-center gap-[0.7vmin] rounded-[0.9vmin] px-[1.5vmin] py-[0.65vmin] text-[1.25vmin] font-black transition-all cursor-pointer ${isSelected
                                  ? "border-2 border-cyan-300 bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-600 text-white shadow-[0_0_1.5vmin_rgba(6,182,212,0.5)] scale-[1.03]"
                                  : "border border-white/15 bg-white/5 text-gray-200 hover:border-purple-400/60 hover:bg-white/10"
                                }`}
                            >
                              <span className="h-[1.2vmin] w-[1.2vmin] rounded-full shadow" style={{ backgroundColor: partner.color }} />
                              <span>{partner.name || `Player ${partner.id}`}</span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}

                {/* Dual-Column Trade Content */}
                {(() => {
                  const targetPlayer = players.find((p) => p.id === tradeDraftTargetId);
                  const initiatorProps = BOARD_TILES.filter((t) => propertyOwnership[t.id] === currentPlayer.id);
                  const targetProps = targetPlayer
                    ? BOARD_TILES.filter((t) => propertyOwnership[t.id] === targetPlayer.id)
                    : [];

                  return (
                    <div className="flex flex-1 overflow-y-auto p-[2.4vmin] gap-[1vmin]">
                      {/* Left Column: Initiator (Your Offer) */}
                      <div className="flex flex-1 flex-col gap-[1.5vmin] pr-[1.4vmin]">
                        <div className="flex items-center justify-between border-b border-purple-500/20 pb-[0.8vmin]">
                          <div className="flex items-center gap-[0.8vmin]">
                            <span className="h-[1.8vmin] w-[1.8vmin] rounded-full shadow-md" style={{ backgroundColor: currentPlayer.color }} />
                            <span className="text-[1.75vmin] font-black text-white">
                              {currentPlayer.name || `Player ${currentPlayer.id}`}
                            </span>
                            <span className="rounded-full bg-purple-500/25 border border-purple-400/50 px-[0.8vmin] py-[0.15vmin] text-[0.9vmin] font-black uppercase text-purple-200">
                              You
                            </span>
                          </div>
                          <span className="text-[1.25vmin] font-bold text-gray-300">
                            Balance: <span className="font-mono text-[1.45vmin] font-black text-emerald-400">${currentPlayer.money.toLocaleString()}</span>
                          </span>
                        </div>

                        {/* Cash Slider */}
                        <div className="flex flex-col gap-[0.8vmin] rounded-[1.2vmin] border border-purple-500/30 bg-[#181133] p-[1.4vmin]">
                          <div className="flex items-center justify-between text-[1.2vmin] font-black text-purple-200 uppercase tracking-wide">
                            <span>💵 Offer Cash:</span>
                            <span className="rounded-full border border-purple-400/80 bg-purple-900/80 px-[1.6vmin] py-[0.3vmin] font-mono text-[1.55vmin] font-black text-purple-100 shadow-[0_0_1vmin_rgba(168,85,247,0.4)]">
                              ${tradeDraftOfferedMoney.toLocaleString()}
                            </span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max={Math.max(0, currentPlayer.money)}
                            value={tradeDraftOfferedMoney}
                            onChange={(e) => setTradeDraftOfferedMoney(Math.min(currentPlayer.money, Math.max(0, Number(e.target.value))))}
                            className="h-[0.9vmin] w-full cursor-pointer accent-purple-500"
                          />
                          <div className="flex items-center justify-between text-[1.15vmin] font-mono font-bold text-gray-400">
                            <span>$0</span>
                            <span>${currentPlayer.money.toLocaleString()}</span>
                          </div>
                        </div>

                        {/* Properties Offered */}
                        <div className="flex flex-1 flex-col gap-[0.8vmin]">
                          <div className="flex items-center justify-between">
                            <span className="text-[1.25vmin] font-black uppercase tracking-wider text-purple-300">
                              Properties to Give:
                            </span>
                            <span className="text-[1.1vmin] font-bold text-gray-400">
                              {tradeDraftOfferedPropIds.length} selected
                            </span>
                          </div>
                          <div className="flex max-h-[30vmin] min-h-[14vmin] flex-col gap-[0.7vmin] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pr-[0.2vmin]">
                            {initiatorProps.length === 0 ? (
                              <div className="flex flex-1 flex-col items-center justify-center gap-[0.6vmin] rounded-[1.2vmin] border border-white/10 bg-black/40 py-[3.5vmin] text-center shadow-inner">
                                <span className="text-[2.4vmin] opacity-70">🏚️</span>
                                <span className="text-[1.35vmin] font-black text-gray-200">No Properties Owned</span>
                                <span className="text-[1.1vmin] text-gray-400">You don't own any properties to give in this trade</span>
                              </div>
                            ) : (
                              initiatorProps.map((tile) => {
                                const isSelected = tradeDraftOfferedPropIds.includes(tile.id);
                                return (
                                  <button
                                    key={tile.id}
                                    type="button"
                                    onClick={() =>
                                      setTradeDraftOfferedPropIds((prev) =>
                                        prev.includes(tile.id) ? prev.filter((id) => id !== tile.id) : [...prev, tile.id]
                                      )
                                    }
                                    className={`flex items-center justify-between rounded-[1vmin] px-[1.4vmin] py-[1vmin] transition-all cursor-pointer ${isSelected
                                        ? "border-2 border-purple-300 bg-gradient-to-r from-purple-700 via-indigo-700 to-purple-800 text-white shadow-[0_0_1.6vmin_rgba(168,85,247,0.6)] scale-[1.01]"
                                        : "border border-white/15 bg-[#1b1438] text-gray-200 hover:border-purple-400/60 hover:bg-[#231b47] hover:text-white"
                                      }`}
                                  >
                                    <div className="flex items-center gap-[0.9vmin]">
                                      {renderTileIconOrFlag(tile, "w-[2.6vmin] h-[1.8vmin]")}
                                      <span className="text-[1.4vmin] font-black tracking-wide text-white">{tile.name}</span>
                                      {isSelected && <span className="text-[1.2vmin] font-black text-purple-200">✓</span>}
                                    </div>
                                    <span className="font-mono text-[1.45vmin] font-black text-emerald-400 drop-shadow">
                                      {tile.price}
                                    </span>
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Center Divider with ↔ */}
                      <div className="relative flex flex-col items-center justify-center px-[0.8vmin]">
                        <div className="h-full w-[0.25vmin] bg-purple-500/30" />
                        <div className="absolute flex h-[3.8vmin] w-[3.8vmin] items-center justify-center rounded-full border-2 border-purple-300 bg-[#211642] text-[1.6vmin] text-purple-200 shadow-[0_0_1.6vmin_rgba(168,85,247,0.5)]">
                          ↔
                        </div>
                      </div>

                      {/* Right Column: Target Player (Requested from them) */}
                      <div className="flex flex-1 flex-col gap-[1.5vmin] pl-[1.4vmin]">
                        {targetPlayer ? (
                          <>
                            <div className="flex items-center justify-between border-b border-cyan-500/20 pb-[0.8vmin]">
                              <div className="flex items-center gap-[0.8vmin]">
                                <span className="h-[1.8vmin] w-[1.8vmin] rounded-full shadow-md" style={{ backgroundColor: targetPlayer.color }} />
                                <span className="text-[1.75vmin] font-black text-white">
                                  {targetPlayer.name || `Player ${targetPlayer.id}`}
                                </span>
                              </div>
                              <span className="text-[1.25vmin] font-bold text-gray-300">
                                Balance: <span className="font-mono text-[1.45vmin] font-black text-emerald-400">${targetPlayer.money.toLocaleString()}</span>
                              </span>
                            </div>

                            {/* Cash Slider for Target */}
                            <div className="flex flex-col gap-[0.8vmin] rounded-[1.2vmin] border border-cyan-500/30 bg-[#111933] p-[1.4vmin]">
                              <div className="flex items-center justify-between text-[1.2vmin] font-black text-cyan-200 uppercase tracking-wide">
                                <span>💵 Ask Cash:</span>
                                <span className="rounded-full border border-cyan-400/80 bg-cyan-950/80 px-[1.6vmin] py-[0.3vmin] font-mono text-[1.55vmin] font-black text-cyan-100 shadow-[0_0_1vmin_rgba(6,182,212,0.4)]">
                                  ${tradeDraftRequestedMoney.toLocaleString()}
                                </span>
                              </div>
                              <input
                                type="range"
                                min="0"
                                max={Math.max(0, targetPlayer.money)}
                                value={tradeDraftRequestedMoney}
                                onChange={(e) => setTradeDraftRequestedMoney(Math.min(targetPlayer.money, Math.max(0, Number(e.target.value))))}
                                className="h-[0.9vmin] w-full cursor-pointer accent-cyan-500"
                              />
                              <div className="flex items-center justify-between text-[1.15vmin] font-mono font-bold text-gray-400">
                                <span>$0</span>
                                <span>${targetPlayer.money.toLocaleString()}</span>
                              </div>
                            </div>

                            {/* Properties Requested from Target */}
                            <div className="flex flex-1 flex-col gap-[0.8vmin]">
                              <div className="flex items-center justify-between">
                                <span className="text-[1.25vmin] font-black uppercase tracking-wider text-cyan-300">
                                  Properties to Receive:
                                </span>
                                <span className="text-[1.1vmin] font-bold text-gray-400">
                                  {tradeDraftRequestedPropIds.length} selected
                                </span>
                              </div>
                              <div className="flex max-h-[30vmin] min-h-[14vmin] flex-col gap-[0.7vmin] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pr-[0.2vmin]">
                                {targetProps.length === 0 ? (
                                  <div className="flex flex-1 flex-col items-center justify-center gap-[0.6vmin] rounded-[1.2vmin] border border-white/10 bg-black/40 py-[3.5vmin] text-center shadow-inner">
                                    <span className="text-[2.4vmin] opacity-70">🏚️</span>
                                    <span className="text-[1.35vmin] font-black text-gray-200">No Properties Owned</span>
                                    <span className="text-[1.1vmin] text-gray-400">{targetPlayer.name} doesn't own any properties to give</span>
                                  </div>
                                ) : (
                                  targetProps.map((tile) => {
                                    const isSelected = tradeDraftRequestedPropIds.includes(tile.id);
                                    return (
                                      <button
                                        key={tile.id}
                                        type="button"
                                        onClick={() =>
                                          setTradeDraftRequestedPropIds((prev) =>
                                            prev.includes(tile.id) ? prev.filter((id) => id !== tile.id) : [...prev, tile.id]
                                          )
                                        }
                                        className={`flex items-center justify-between rounded-[1vmin] px-[1.4vmin] py-[1vmin] transition-all cursor-pointer ${isSelected
                                            ? "border-2 border-cyan-300 bg-gradient-to-r from-indigo-700 via-cyan-700 to-indigo-800 text-white shadow-[0_0_1.6vmin_rgba(6,182,212,0.6)] scale-[1.01]"
                                            : "border border-white/15 bg-[#141b38] text-gray-200 hover:border-cyan-400/60 hover:bg-[#1a2347] hover:text-white"
                                          }`}
                                      >
                                        <div className="flex items-center gap-[0.9vmin]">
                                          {renderTileIconOrFlag(tile, "w-[2.6vmin] h-[1.8vmin]")}
                                          <span className="text-[1.4vmin] font-black tracking-wide text-white">{tile.name}</span>
                                          {isSelected && <span className="text-[1.2vmin] font-black text-cyan-200">✓</span>}
                                        </div>
                                        <span className="font-mono text-[1.45vmin] font-black text-emerald-400 drop-shadow">
                                          {tile.price}
                                        </span>
                                      </button>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="flex h-full items-center justify-center text-gray-300 font-bold text-[1.3vmin]">
                            Select a player to start trading
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Modal Footer */}
                <div className="flex items-center justify-between border-t border-purple-500/30 bg-[#181133] px-[2.4vmin] py-[1.5vmin]">
                  <button
                    onClick={() => setActiveTradeModal(null)}
                    className="rounded-[1vmin] border border-white/20 bg-white/5 px-[2.2vmin] py-[1vmin] text-[1.25vmin] font-bold text-gray-300 transition hover:bg-white/15 hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSendTrade}
                    disabled={!tradeDraftTargetId}
                    className="flex items-center gap-[0.8vmin] rounded-[1vmin] bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-600 px-[3.5vmin] py-[1.2vmin] text-[1.45vmin] font-black uppercase tracking-wider text-white shadow-[0_0_2.5vmin_rgba(139,92,246,0.55)] transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  >
                    <span className="text-[1.6vmin]">✈️</span>
                    <span>{negotiatingTradeId ? "Send Counter-Offer" : "Send Trade Offer"}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ================= VIEW TRADE MODAL ================= */}
          {activeTradeModal === "view" && selectedTradeId && (
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-[2vmin] backdrop-blur-md"
              onClick={() => setActiveTradeModal(null)}
            >
              {(() => {
                const trade = trades.find((t) => t.id === selectedTradeId);
                if (!trade) {
                  return (
                    <div className="rounded-[1.4vmin] bg-[#120d24] p-[3vmin] text-center text-white" onClick={(e) => e.stopPropagation()}>
                      <p className="text-[1.3vmin]">Trade not found or already completed.</p>
                      <button onClick={() => setActiveTradeModal(null)} className="mt-[1vmin] rounded-[0.8vmin] bg-white/10 px-[2vmin] py-[0.8vmin] text-[1.1vmin]">
                        Close
                      </button>
                    </div>
                  );
                }

                const initiator = players.find((p) => p.id === trade.initiatorId);
                const target = players.find((p) => p.id === trade.targetId);
                const isViewerSender = currentPlayer?.id === trade.initiatorId;
                const isViewerRecipient = currentPlayer?.id === trade.targetId;
                const initiatorOfferedTiles = BOARD_TILES.filter((t) => trade.initiatorPropertyIds.includes(t.id));
                const targetRequestedTiles = BOARD_TILES.filter((t) => trade.targetPropertyIds.includes(t.id));

                return (
                  <div
                    className="relative flex max-h-[90vh] w-[86vmin] flex-col overflow-hidden rounded-[2vmin] border-2 border-purple-500/40 bg-[#120d24] text-white shadow-[0_0_4.5vmin_rgba(139,92,246,0.35)]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Header */}
                    <div className="relative border-b border-purple-500/25 bg-[#17112e] py-[1.5vmin] text-center">
                      <h3 className="text-[2.2vmin] font-black uppercase tracking-wider text-white">
                        View Trade
                      </h3>
                      <button
                        onClick={() => setActiveTradeModal(null)}
                        className="absolute right-[1.6vmin] top-[1.4vmin] flex h-[3.2vmin] w-[3.2vmin] items-center justify-center rounded-full bg-white/10 text-[1.4vmin] text-gray-300 transition hover:bg-white/20 hover:text-white cursor-pointer"
                        title="Close"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Body: Two Columns */}
                    <div className="flex flex-1 overflow-y-auto p-[2.4vmin]">
                      {/* Left: Initiator terms */}
                      <div className="flex flex-1 flex-col gap-[1.4vmin] pr-[1.8vmin]">
                        <div className="flex items-center gap-[0.8vmin]">
                          <span className="h-[1.6vmin] w-[1.6vmin] rounded-full" style={{ backgroundColor: initiator?.color }} />
                          <span className="text-[1.6vmin] font-black text-white">
                            {initiator?.name || `Player ${trade.initiatorId}`}
                          </span>
                          {isViewerSender && (
                            <span className="rounded-full bg-purple-500/20 px-[0.7vmin] py-[0.1vmin] text-[0.85vmin] font-black uppercase text-purple-300">
                              You
                            </span>
                          )}
                        </div>

                        {/* Cash Offered Badge */}
                        <div className="flex items-center justify-between rounded-[1.2vmin] border border-purple-500/30 bg-[#191336] p-[1.2vmin]">
                          <span className="text-[1.15vmin] font-bold text-gray-400 uppercase tracking-wide">
                            Offered Cash:
                          </span>
                          <span className="rounded-full border border-purple-400/80 bg-purple-900/60 px-[1.8vmin] py-[0.4vmin] font-mono text-[1.6vmin] font-black text-purple-200 shadow">
                            ${trade.initiatorMoney.toLocaleString()}
                          </span>
                        </div>

                        {/* Offered Properties */}
                        <div className="flex flex-col gap-[0.8vmin]">
                          <span className="text-[1.15vmin] font-black uppercase tracking-wider text-gray-300">
                            Properties Offered ({initiatorOfferedTiles.length}):
                          </span>
                          <div className="flex max-h-[32vmin] flex-col gap-[0.7vmin] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pr-[0.4vmin]">
                            {initiatorOfferedTiles.length === 0 ? (
                              <div className="rounded-[1vmin] border border-white/5 bg-black/20 py-[2.4vmin] text-center text-[1.15vmin] italic text-gray-500">
                                No properties offered ($ cash only)
                              </div>
                            ) : (
                              initiatorOfferedTiles.map((tile) => (
                                <div
                                  key={tile.id}
                                  className="flex items-center justify-between rounded-[0.9vmin] border border-purple-400/40 bg-[#1f173d] px-[1.2vmin] py-[0.9vmin]"
                                >
                                  <div className="flex items-center gap-[0.8vmin]">
                                    {renderTileIconOrFlag(tile)}
                                    <span className="text-[1.35vmin] font-black text-white">{tile.name}</span>
                                  </div>
                                  <span className="font-mono text-[1.4vmin] font-black text-emerald-400 drop-shadow">
                                    {tile.price}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Center ↔ */}
                      <div className="relative flex flex-col items-center justify-center px-[1vmin]">
                        <div className="h-full w-[0.2vmin] bg-purple-500/25" />
                        <div className="absolute flex h-[3.4vmin] w-[3.4vmin] items-center justify-center rounded-full border-2 border-purple-400 bg-[#1f163d] text-[1.5vmin] text-purple-200 shadow-[0_0_1.2vmin_rgba(168,85,247,0.4)]">
                          ↔
                        </div>
                      </div>

                      {/* Right: Target terms */}
                      <div className="flex flex-1 flex-col gap-[1.4vmin] pl-[1.8vmin]">
                        <div className="flex items-center gap-[0.8vmin]">
                          <span className="h-[1.6vmin] w-[1.6vmin] rounded-full" style={{ backgroundColor: target?.color }} />
                          <span className="text-[1.6vmin] font-black text-white">
                            {target?.name || `Player ${trade.targetId}`}
                          </span>
                          {isViewerRecipient && (
                            <span className="rounded-full bg-emerald-500/20 px-[0.7vmin] py-[0.1vmin] text-[0.85vmin] font-black uppercase text-emerald-300">
                              You
                            </span>
                          )}
                        </div>

                        {/* Cash Requested Badge */}
                        <div className="flex items-center justify-between rounded-[1.2vmin] border border-cyan-500/30 bg-[#141b33] p-[1.2vmin]">
                          <span className="text-[1.15vmin] font-bold text-gray-400 uppercase tracking-wide">
                            Requested Cash:
                          </span>
                          <span className="rounded-full border border-cyan-400/80 bg-cyan-950/60 px-[1.8vmin] py-[0.4vmin] font-mono text-[1.6vmin] font-black text-cyan-200 shadow">
                            ${trade.targetMoney.toLocaleString()}
                          </span>
                        </div>

                        {/* Requested Properties */}
                        <div className="flex flex-col gap-[0.8vmin]">
                          <span className="text-[1.15vmin] font-black uppercase tracking-wider text-gray-300">
                            Properties Requested ({targetRequestedTiles.length}):
                          </span>
                          <div className="flex max-h-[32vmin] flex-col gap-[0.7vmin] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden pr-[0.4vmin]">
                            {targetRequestedTiles.length === 0 ? (
                              <div className="rounded-[1vmin] border border-white/5 bg-black/20 py-[2.4vmin] text-center text-[1.15vmin] italic text-gray-500">
                                No properties requested ($ cash only)
                              </div>
                            ) : (
                              targetRequestedTiles.map((tile) => (
                                <div
                                  key={tile.id}
                                  className="flex items-center justify-between rounded-[0.9vmin] border border-cyan-400/40 bg-[#16213d] px-[1.2vmin] py-[0.9vmin]"
                                >
                                  <div className="flex items-center gap-[0.8vmin]">
                                    {renderTileIconOrFlag(tile)}
                                    <span className="text-[1.35vmin] font-black text-white">{tile.name}</span>
                                  </div>
                                  <span className="font-mono text-[1.4vmin] font-black text-emerald-400 drop-shadow">
                                    {tile.price}
                                  </span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Footer Actions */}
                    <div className="flex items-center justify-between border-t border-purple-500/25 bg-[#17112e] px-[2.4vmin] py-[1.4vmin]">
                      {isViewerSender ? (
                        <div className="flex w-full items-center justify-center">
                          <button
                            onClick={() => handleCancelTrade(trade.id)}
                            className="flex items-center gap-[0.8vmin] rounded-[1vmin] bg-gradient-to-r from-red-600 via-rose-600 to-red-700 px-[3.5vmin] py-[1.2vmin] text-[1.4vmin] font-black uppercase tracking-wider text-white shadow-lg shadow-red-600/40 transition hover:brightness-110 active:scale-95 cursor-pointer"
                          >
                            <span>✕</span>
                            <span>Delete Trade</span>
                          </button>
                        </div>
                      ) : isViewerRecipient ? (
                        <div className="flex w-full items-center justify-between gap-[1.2vmin]">
                          <button
                            onClick={() => handleDeclineTrade(trade.id)}
                            className="rounded-[1vmin] border border-red-500/40 bg-red-950/40 px-[2.2vmin] py-[1.1vmin] text-[1.25vmin] font-black uppercase text-red-300 transition hover:bg-red-900/60 active:scale-95 cursor-pointer"
                          >
                            ✕ Decline
                          </button>
                          <div className="flex items-center gap-[1.2vmin]">
                            <button
                              onClick={() => handleStartNegotiation(trade)}
                              className="flex items-center gap-[0.6vmin] rounded-[1vmin] bg-gradient-to-r from-amber-500 to-orange-600 px-[2.5vmin] py-[1.1vmin] text-[1.35vmin] font-black uppercase tracking-wide text-white shadow-lg shadow-amber-500/30 transition hover:brightness-110 active:scale-95 cursor-pointer"
                            >
                              <span>🔄</span>
                              <span>Negotiate</span>
                            </button>
                            <button
                              onClick={() => handleAcceptTrade(trade.id)}
                              className="flex items-center gap-[0.6vmin] rounded-[1vmin] bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 px-[3vmin] py-[1.1vmin] text-[1.4vmin] font-black uppercase tracking-wide text-white shadow-[0_0_2vmin_rgba(16,185,129,0.5)] transition hover:brightness-110 active:scale-95 cursor-pointer"
                            >
                              <span>✓</span>
                              <span>Accept Trade</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex w-full items-center justify-between">
                          <span className="text-[1.15vmin] text-gray-400 font-medium">
                            Spectating active trade between {initiator?.name || `Player ${trade.initiatorId}`} and {target?.name || `Player ${trade.targetId}`}
                          </span>
                          <button
                            onClick={() => setActiveTradeModal(null)}
                            className="rounded-[0.9vmin] bg-white/10 px-[2.4vmin] py-[0.9vmin] text-[1.2vmin] font-bold text-white hover:bg-white/20 cursor-pointer"
                          >
                            Close
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* ================= RIGHT SIDEBAR - ALL PLAYERS & THEIR CARDS ================= */}
        <div className="flex h-[96vmin] w-full min-w-[36vmin] flex-1 flex-col self-start overflow-y-auto rounded-[1.4vmin] border border-white/10 bg-[#0f0c16]/90 p-[1.3vmin] shadow-[0_0_2vmin_rgba(139,92,246,0.12)]">
          <div className="mb-[0.8vmin] flex items-center justify-between px-[0.3vmin]">
            <h2 className="text-[1.4vmin] font-black uppercase tracking-widest text-white">
              Players
            </h2>
            {isVoteKickOpen && (
              <span className="rounded-full border border-purple-500/40 bg-purple-500/20 px-[0.6vmin] py-[0.15vmin] text-[0.85vmin] font-bold text-purple-300 animate-pulse">
                Vote Kick Mode
              </span>
            )}
          </div>

          <div className="flex flex-col gap-[0.7vmin]">
            {players.map((player) => {
              const isSelected = selectedPlayerId === player.id;
              const isSelf = player.id === currentPlayer?.id;
              const isTarget = isVoteKickOpen && !player.isBankrupt && !isSelf;

              const voters = kickVotes[player.id] || [];
              const otherEligibleVoters = alivePlayers.filter((p) => p.id !== player.id);
              const totalOthers = otherEligibleVoters.length;
              const votes = voters.length;
              const hasCurrentVoted = currentPlayer ? voters.includes(currentPlayer.id) : false;

              return (
                <div
                  key={player.id}
                  onClick={() => {
                    if (isVoteKickOpen) {
                      if (isTarget && currentPlayer) {
                        togglePlayerKickVote(player.id, currentPlayer.id);
                      }
                    } else {
                      setSelectedPlayerId((prev) => (prev === player.id ? null : player.id));
                    }
                  }}
                  className={`flex items-center justify-between rounded-[1vmin] border-[0.18vmin] px-[1.1vmin] py-[0.9vmin] text-left transition-all duration-200 ${player.isBankrupt
                      ? "opacity-30 grayscale cursor-not-allowed"
                      : isVoteKickOpen && isSelf
                        ? "opacity-30 grayscale-[30%] cursor-not-allowed border-white/5 bg-white/[0.02]"
                        : isVoteKickOpen && isTarget
                          ? hasCurrentVoted
                            ? "border-emerald-500/60 bg-emerald-500/10 cursor-pointer hover:bg-emerald-500/15"
                            : "border-purple-500/40 bg-purple-500/5 cursor-pointer hover:border-purple-400/60 hover:bg-purple-500/15"
                          : isSelected && !player.isCurrentPlayer
                            ? "ring-[0.14vmin] ring-white/40 cursor-pointer"
                            : "cursor-pointer"
                    }`}
                  style={{
                    borderColor:
                      isVoteKickOpen && isSelf
                        ? "rgba(255,255,255,0.05)"
                        : isVoteKickOpen && isTarget
                          ? hasCurrentVoted
                            ? "#10b981aa"
                            : "rgba(168,85,247,0.4)"
                          : player.isCurrentPlayer
                            ? `${player.color}cc`
                            : "rgba(255,255,255,0.1)",
                    backgroundColor:
                      isVoteKickOpen && isSelf
                        ? "rgba(255,255,255,0.02)"
                        : isVoteKickOpen && isTarget
                          ? hasCurrentVoted
                            ? "rgba(16,185,129,0.08)"
                            : "rgba(168,85,247,0.08)"
                          : player.isCurrentPlayer
                            ? `${player.color}2e`
                            : "rgba(255,255,255,0.04)",
                    boxShadow:
                      !isVoteKickOpen && player.isCurrentPlayer
                        ? `0 0 1.6vmin ${player.color}88, inset 0 0 0.7vmin ${player.color}33`
                        : undefined,
                  }}
                >
                  <div className="flex items-center gap-[1vmin]">
                    <div className="shrink-0">{renderPlayerFace(player, "4vmin")}</div>
                    <div className="flex flex-col leading-tight">
                      {!isGameStarted ? (
                        <div
                          className="flex items-center gap-[0.6vmin]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="text"
                            value={player.name}
                            onChange={(e) => handlePlayerNameChange(player.id, e.target.value)}
                            placeholder={`Player ${player.id}`}
                            maxLength={12}
                            className="w-[16.5vmin] rounded-[0.9vmin] border-[0.25vmin] border-purple-400/50 bg-[#160f26] px-[1.1vmin] py-[0.5vmin] text-[1.75vmin] font-black text-white placeholder:text-gray-400/90 placeholder:font-black placeholder:text-[1.65vmin] shadow-inner shadow-black/60 transition-all focus:border-purple-300 focus:bg-[#231540] focus:shadow-[0_0_1.4vmin_rgba(168,85,247,0.6)] focus:outline-none"
                            title="Click to edit player name"
                          />
                          <span className="text-[1.4vmin] text-purple-300 drop-shadow" title="Editable before game start">
                            ✏️
                          </span>
                        </div>
                      ) : (
                        <span
                          className={`text-[1.8vmin] font-black tracking-wide drop-shadow-[0_0.2vmin_0.4vmin_rgba(0,0,0,0.9)] ${isVoteKickOpen && isSelf
                              ? "text-gray-400"
                              : player.isCurrentPlayer
                                ? "text-white"
                                : "text-gray-100"
                            }`}
                        >
                          {player.name || `Player ${player.id}`}
                        </span>
                      )}

                      {player.isBankrupt ? (
                        <span className="text-[0.9vmin] text-red-400">BANKRUPT</span>
                      ) : isVoteKickOpen && isSelf ? (
                        <span className="text-[0.8vmin] font-medium text-gray-500">(Yourself)</span>
                      ) : isVoteKickOpen && isTarget ? (
                        <div className="mt-[0.15vmin] flex items-center gap-[0.3vmin]">
                          {otherEligibleVoters.map((voter) => {
                            const thisVoted = voters.includes(voter.id);
                            return (
                              <span
                                key={voter.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePlayerKickVote(player.id, voter.id);
                                }}
                                className={`flex cursor-pointer items-center gap-[0.2vmin] rounded-full border px-[0.45vmin] py-[0.05vmin] text-[0.7vmin] font-bold transition-all ${thisVoted
                                    ? "border-emerald-500/50 bg-emerald-500/25 text-emerald-300"
                                    : "border-white/10 bg-white/[0.03] text-gray-400 hover:border-white/30 hover:text-white"
                                  }`}
                                title={`${voter.name}: ${thisVoted ? "Voted (click to remove)" : "Click to vote"} (1 vote per player)`}
                              >
                                <span
                                  className="h-[0.45vmin] w-[0.45vmin] rounded-full"
                                  style={{ backgroundColor: voter.color }}
                                />
                                <span>{voter.name}</span>
                                <span>{thisVoted ? "✓" : "+"}</span>
                              </span>
                            );
                          })}
                        </div>
                      ) : player.inJail ? (
                        <span className="text-[0.9vmin] text-amber-400">🔒 JAIL</span>
                      ) : null}
                    </div>
                  </div>

                  {/* Right side: In Vote Kick mode, show vote count & button; otherwise show money */}
                  {isVoteKickOpen && isTarget ? (
                    <div className="flex items-center gap-[0.7vmin]">
                      <span
                        className={`text-[1.35vmin] font-black ${votes > 0 ? "text-purple-300" : "text-gray-400"
                          }`}
                      >
                        {votes}/{totalOthers}
                      </span>

                      {currentPlayer && currentPlayer.id !== player.id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePlayerKickVote(player.id, currentPlayer.id);
                          }}
                          className={`rounded-[0.65vmin] px-[0.85vmin] py-[0.35vmin] text-[0.9vmin] font-black uppercase transition-all hover:scale-105 active:scale-95 ${hasCurrentVoted
                              ? "border border-emerald-500/60 bg-emerald-500/25 text-emerald-300 hover:border-red-500/50 hover:bg-red-500/20 hover:text-red-300"
                              : "border border-white/20 bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-md"
                            }`}
                          title={hasCurrentVoted ? "Click to remove your vote" : `Vote to kick ${player.name}`}
                        >
                          {hasCurrentVoted ? "✓ Voted" : "+ Vote"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div
                      className={`flex items-center gap-[0.4vmin] rounded-[0.9vmin] border-[0.2vmin] px-[1.1vmin] py-[0.45vmin] shadow-md transition-all ${isVoteKickOpen && isSelf
                          ? "border-white/10 bg-white/[0.02] text-gray-500"
                          : player.isCurrentPlayer
                            ? "border-emerald-400/70 bg-[#062418] text-emerald-300 shadow-[0_0_1.4vmin_rgba(16,185,129,0.45)]"
                            : "border-emerald-500/40 bg-[#091b14] text-emerald-300"
                        }`}
                    >
                      <span className="text-[1.35vmin] leading-none">💵</span>
                      <span className="text-[1.85vmin] font-black tracking-tight drop-shadow">
                        ${player.money.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selectedPlayerId &&
            (() => {
              const selectedPlayer = players.find((p) => p.id === selectedPlayerId);
              if (!selectedPlayer) return null;
              const ownedCount = BOARD_TILES.filter((t) => propertyOwnership[t.id] === selectedPlayer.id).length;

              return (
                <div className="mt-[1.3vmin] flex items-center justify-between rounded-[1vmin] border border-white/10 bg-white/[0.05] px-[1vmin] py-[0.9vmin]">
                  <div className="flex min-w-0 items-center gap-[0.6vmin]">
                    <span className="h-[1vmin] w-[1vmin] shrink-0 rounded-full" style={{ backgroundColor: selectedPlayer.color }} />
                    <span className="truncate text-[1.1vmin] font-semibold text-gray-200">
                      {ownedCount > 0
                        ? `Highlighting ${selectedPlayer.name || `Player ${selectedPlayer.id}`}'s ${ownedCount} propert${ownedCount === 1 ? "y" : "ies"} on the board`
                        : `${selectedPlayer.name || `Player ${selectedPlayer.id}`} doesn't own any properties yet`}
                    </span>
                  </div>
                  <button
                    onClick={() => setSelectedPlayerId(null)}
                    title="Clear selection"
                    className="ml-[0.6vmin] flex h-[1.8vmin] w-[1.8vmin] shrink-0 items-center justify-center rounded-full text-[1.3vmin] leading-none text-gray-400 hover:bg-white/10 hover:text-white"
                  >
                    ✕
                  </button>
                </div>
              );
            })()}

          {/* ================= SMALL BOX: PLAYER ACTIONS (VOTE KICK & BANKRUPT) ================= */}
          {isGameStarted && (
            <div className="mt-[1.2vmin] rounded-[1vmin] border border-white/10 bg-white/[0.03] p-[0.9vmin] shadow-sm">
              <div className="mb-[0.7vmin] flex items-center justify-between px-[0.2vmin]">
                <span className="text-[1.05vmin] font-bold uppercase tracking-wider text-gray-400">
                  Player Actions
                </span>
                <span className="text-[0.9vmin] font-medium text-gray-400">
                  Turn:{" "}
                  <span className="font-bold" style={{ color: currentPlayer?.color }}>
                    {currentPlayer?.name || `Player ${currentPlayer?.id}`}
                  </span>
                </span>
              </div>

              <div className="flex items-center justify-between px-[0.3vmin]">
                {/* Left Button: Vote Kick (same design and color as Roll Dice) */}
                <button
                  onClick={() => setIsVoteKickOpen((prev) => !prev)}
                  disabled={alivePlayers.length < 3}
                  className={`flex items-center justify-center gap-[0.4vmin] rounded-[0.9vmin] border border-white/20 bg-gradient-to-r from-indigo-600 to-purple-600 px-[1.2vmin] py-[0.75vmin] text-[1.1vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${isVoteKickOpen ? "ring-2 ring-purple-300 shadow-[0_0_1.2vmin_rgba(168,85,247,0.4)]" : ""
                    }`}
                  title={alivePlayers.length < 3 ? "Vote kick needs at least 3 active players" : isVoteKickOpen ? "Click to close Vote Kick mode" : "Click to vote kick players in the panel above"}
                >
                  <span className="text-[1.2vmin]">🗳️</span>
                  <span>Vote Kick</span>
                </button>

                {/* Right Button: Bankrupt (red, but same design as Roll Dice) */}
                <button
                  onClick={() => {
                    if (currentPlayer && !currentPlayer.isBankrupt) {
                      setBankruptCandidateId(currentPlayer.id);
                      setShowBankruptModal(true);
                    }
                  }}
                  disabled={!currentPlayer || currentPlayer.isBankrupt || alivePlayers.length <= 1}
                  className="flex items-center justify-center gap-[0.4vmin] rounded-[0.9vmin] border border-white/20 bg-gradient-to-r from-red-600 to-rose-600 px-[1.2vmin] py-[0.75vmin] text-[1.1vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Whoever clicks this gets out (surrender/bankrupt)"
                >
                  <span className="text-[1.2vmin]">🏳️</span>
                  <span>Bankrupt</span>
                </button>
              </div>
            </div>
          )}

          {/* ================= TRADE PANEL (BETWEEN PLAYER ACTIONS & SETTINGS) ================= */}
          {isGameStarted && enableTrading && (
            <div className="mt-[1.2vmin] rounded-[1.2vmin] border-2 border-indigo-500/35 bg-[#141024] p-[1.1vmin] shadow-[0_0_2vmin_rgba(99,102,241,0.15)] transition-all">
              <div className="mb-[0.7vmin] flex items-center justify-between px-[0.2vmin]">
                <div className="flex items-center gap-[0.6vmin]">
                  <span className="text-[1.15vmin] font-black uppercase tracking-wider text-white flex items-center gap-[0.4vmin]">
                    <span>🤝</span>
                    <span>Active Trades</span>
                  </span>
                  {trades.filter((t) => t.status === "pending").length > 0 && (
                    <span className="rounded-full border border-emerald-400/60 bg-emerald-500/20 px-[0.6vmin] py-[0.1vmin] text-[0.8vmin] font-black uppercase text-emerald-300 animate-pulse">
                      {trades.filter((t) => t.status === "pending").length} active
                    </span>
                  )}
                </div>
                <button
                  onClick={() => openCreateTradeModal()}
                  disabled={alivePlayers.length <= 1 || !enableTrading}
                  className="flex items-center gap-[0.4vmin] rounded-[0.8vmin] border border-purple-400/40 bg-gradient-to-r from-purple-600 to-indigo-600 px-[1vmin] py-[0.5vmin] text-[1.05vmin] font-black uppercase tracking-wide text-white shadow transition hover:scale-[1.03] hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  title={enableTrading ? "Propose a new trade offer" : "Trading is disabled in this game"}
                >
                  <span>+ Propose</span>
                </button>
              </div>

              {/* Active Trades List */}
              {(() => {
                const pendingTrades = trades.filter((t) => t.status === "pending");
                if (pendingTrades.length === 0) {
                  return (
                    <div className="rounded-[0.9vmin] border border-white/5 bg-black/25 py-[1vmin] px-[0.8vmin] text-center">
                      <p className="text-[1.05vmin] text-gray-400 font-medium">No active trade offers.</p>
                      <button
                        onClick={() => openCreateTradeModal()}
                        disabled={alivePlayers.length <= 1 || !enableTrading}
                        className="mt-[0.4vmin] text-[1vmin] font-black text-purple-300 hover:text-purple-200 underline decoration-purple-400/50 cursor-pointer disabled:opacity-40"
                      >
                        {enableTrading ? "Start a trade offer" : "Trading is disabled"}
                      </button>
                    </div>
                  );
                }

                return (
                  <div className="flex flex-col gap-[0.7vmin] max-h-[18vmin] overflow-y-auto pr-[0.3vmin]">
                    {pendingTrades.map((trade) => {
                      const initiator = players.find((p) => p.id === trade.initiatorId);
                      const target = players.find((p) => p.id === trade.targetId);
                      const isRecipient = currentPlayer?.id === trade.targetId;
                      const isSender = currentPlayer?.id === trade.initiatorId;

                      return (
                        <div
                          key={trade.id}
                          className={`rounded-[0.9vmin] border p-[0.8vmin] transition-all flex flex-col gap-[0.5vmin] ${isRecipient
                              ? "border-emerald-500/50 bg-[#0c1f17] shadow-[0_0_1.2vmin_rgba(16,185,129,0.2)]"
                              : isSender
                                ? "border-amber-500/40 bg-[#1c1810]"
                                : "border-purple-500/30 bg-[#141026]"
                            }`}
                        >
                          <div className="flex items-center justify-between text-[1vmin]">
                            <div className="flex items-center gap-[0.5vmin] truncate">
                              <span className="font-black truncate max-w-[8vmin]" style={{ color: initiator?.color }}>
                                {initiator?.name || `P${trade.initiatorId}`}
                              </span>
                              <span className="text-gray-400 text-[0.9vmin]">⇄</span>
                              <span className="font-black truncate max-w-[8vmin]" style={{ color: target?.color }}>
                                {target?.name || `P${trade.targetId}`}
                              </span>
                            </div>
                            <span
                              className={`rounded-full px-[0.7vmin] py-[0.15vmin] text-[0.8vmin] font-black uppercase tracking-wider ${isRecipient
                                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/60 animate-pulse"
                                  : isSender
                                    ? "bg-amber-500/20 text-amber-300 border border-amber-400/50"
                                    : "bg-purple-500/20 text-purple-300 border border-purple-400/40"
                                }`}
                            >
                              {isRecipient ? "📩 Action Needed" : isSender ? "⏳ Sent" : "👀 Public"}
                            </span>
                          </div>

                          <div className="flex items-center justify-between text-[0.95vmin] text-gray-300 bg-black/30 rounded-[0.6vmin] px-[0.7vmin] py-[0.35vmin]">
                            <span>
                              Gives: <span className="font-black text-white">${trade.initiatorMoney}</span>
                              {trade.initiatorPropertyIds.length > 0 && ` +${trade.initiatorPropertyIds.length} prop`}
                            </span>
                            <span>
                              Asks: <span className="font-black text-white">${trade.targetMoney}</span>
                              {trade.targetPropertyIds.length > 0 && ` +${trade.targetPropertyIds.length} prop`}
                            </span>
                          </div>

                          <button
                            onClick={() => {
                              setSelectedTradeId(trade.id);
                              setActiveTradeModal("view");
                            }}
                            className={`w-full rounded-[0.6vmin] py-[0.5vmin] text-[1vmin] font-black uppercase tracking-wider transition hover:brightness-110 active:scale-95 cursor-pointer ${isRecipient
                                ? "bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-[0_0_1vmin_rgba(16,185,129,0.3)]"
                                : isSender
                                  ? "bg-gradient-to-r from-amber-600 to-orange-600 text-white"
                                  : "bg-white/10 hover:bg-white/20 text-gray-200"
                              }`}
                          >
                            {isRecipient ? "Review & Negotiate ➔" : isSender ? "View / Cancel ➔" : "View Details ➔"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ================= SETTINGS PANEL (ONLY IN SIDEBAR BEFORE GAME START) ================= */}
          {!isGameStarted && (
            <div className="mt-[1.4vmin] flex flex-1 flex-col justify-between rounded-[1.4vmin] border-2 border-purple-500/35 bg-[#141024] p-[1.6vmin] shadow-[0_0_2.5vmin_rgba(139,92,246,0.18)]">
              <div className="flex flex-col gap-[1.6vmin]">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-purple-500/25 pb-[1.1vmin]">
                  <div className="flex items-center gap-[0.8vmin]">
                    <span className="text-[2.2vmin]">⚙️</span>
                    <span className="text-[1.8vmin] font-black uppercase tracking-wider text-white">
                      GAME SETTINGS
                    </span>
                  </div>
                  <span className="rounded-full border-2 border-emerald-400/80 bg-emerald-500/25 px-[1.2vmin] py-[0.4vmin] text-[1.2vmin] font-black uppercase tracking-wider text-emerald-300 shadow-[0_0_1.2vmin_rgba(52,211,153,0.4)] animate-pulse">
                    🟢 SETUP (EDITABLE)
                  </span>
                </div>

                {/* Setting: Number of Players (2 to 6) */}
                <div className="flex flex-col gap-[0.8vmin]">
                  <div className="flex items-center justify-between">
                    <span className="text-[1.4vmin] font-black uppercase tracking-wide text-gray-200">
                      👥 Number of Players:
                    </span>
                    <span className="text-[1.6vmin] font-black text-purple-400">
                      {players.length} Players
                    </span>
                  </div>
                  <div className="grid grid-cols-5 gap-[0.6vmin]">
                    {[2, 3, 4, 5, 6].map((count) => {
                      const isActive = players.length === count;
                      return (
                        <button
                          key={count}
                          onClick={() => handlePlayerCountChange(count)}
                          className={`rounded-[0.9vmin] py-[0.85vmin] text-[1.35vmin] font-black transition-all cursor-pointer ${isActive
                              ? "border-[0.25vmin] border-purple-300 bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-[0_0_1.4vmin_rgba(168,85,247,0.6)] scale-[1.03]"
                              : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400 hover:bg-[#30264e] hover:text-white"
                            }`}
                          title={`Set player count to ${count}`}
                        >
                          {count}P
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Setting 1: Starting Cash */}
                <div className="flex flex-col gap-[0.8vmin]">
                  <div className="flex items-center justify-between">
                    <span className="text-[1.4vmin] font-black uppercase tracking-wide text-gray-200">
                      💵 Starting Cash:
                    </span>
                    <span className="text-[1.7vmin] font-black text-emerald-400">
                      ${startingCash.toLocaleString()}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-[0.6vmin]">
                    {[1500, 2000, 2500, 3000].map((cash) => (
                      <button
                        key={cash}
                        onClick={() => handleStartingCashChange(cash)}
                        className={`rounded-[0.9vmin] py-[0.95vmin] text-[1.35vmin] font-black transition-all cursor-pointer ${startingCash === cash
                            ? "border-[0.25vmin] border-emerald-300 bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-[0_0_1.4vmin_rgba(16,185,129,0.55)] scale-[1.03]"
                            : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400 hover:bg-[#30264e] hover:text-white"
                          }`}
                        title={`Set starting cash to $${cash.toLocaleString()}`}
                      >
                        ${cash >= 1000 ? `${cash / 1000}k` : cash}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Setting 2: START Bonus (Pass / Land) */}
                <div className="flex flex-col gap-[0.8vmin]">
                  <div className="flex items-center justify-between">
                    <span className="text-[1.4vmin] font-black uppercase tracking-wide text-gray-200">
                      🚩 START Bonus:
                    </span>
                    <span className="text-[1.5vmin] font-bold text-gray-100">
                      Pass <span className="text-[1.8vmin] font-black text-emerald-300 drop-shadow-[0_0_0.6vmin_rgba(52,211,153,0.9)]">+${passStartBonus}</span> / Land{" "}
                      <span className="text-[1.8vmin] font-black text-emerald-300 drop-shadow-[0_0_0.6vmin_rgba(52,211,153,0.9)]">+${landStartBonus}</span>
                    </span>
                  </div>
                  <div className="flex flex-col gap-[0.8vmin]">
                    {/* Pass Bonus */}
                    <div className="flex flex-col gap-[0.4vmin]">
                      <label className="text-[1.1vmin] font-bold text-gray-300">Pass Bonus:</label>
                      <div className="flex items-center justify-center gap-[0.8vmin]">
                        <button
                          onClick={() => handlePassBonusChange(Math.max(0, passStartBonus - 50))}
                          disabled={isGameStarted || passStartBonus === 0}
                          className="flex items-center justify-center w-[3.5vmin] h-[3.5vmin] rounded-[0.6vmin] border-2 border-emerald-500/60 bg-[#2a1f4a] hover:bg-[#3a2f5a] text-emerald-400 font-black text-[1.4vmin] transition disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_1vmin_rgba(16,185,129,0.4)] hover:border-emerald-400"
                          title="Decrease by $50"
                        >
                          ◀
                        </button>
                        <div className="flex-1 text-center rounded-[0.6vmin] border-2 border-emerald-500/40 bg-[#221c38] py-[0.6vmin] px-[1vmin]">
                          <span className="text-[1.9vmin] font-black text-emerald-300 drop-shadow-[0_0_0.7vmin_rgba(52,211,153,0.9)]">+${passStartBonus}</span>
                        </div>
                        <button
                          onClick={() => handlePassBonusChange(passStartBonus + 50)}
                          disabled={isGameStarted}
                          className="flex items-center justify-center w-[3.5vmin] h-[3.5vmin] rounded-[0.6vmin] border-2 border-emerald-500/60 bg-[#2a1f4a] hover:bg-[#3a2f5a] text-emerald-400 font-black text-[1.4vmin] transition disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_1vmin_rgba(16,185,129,0.4)] hover:border-emerald-400"
                          title="Increase by $50"
                        >
                          ▶
                        </button>
                      </div>
                    </div>

                    {/* Land Bonus */}
                    <div className="flex flex-col gap-[0.4vmin]">
                      <label className="text-[1.1vmin] font-bold text-gray-300">Land Bonus:</label>
                      <div className="flex items-center justify-center gap-[0.8vmin]">
                        <button
                          onClick={() => handleLandBonusChange(Math.max(0, landStartBonus - 50))}
                          disabled={isGameStarted || landStartBonus === 0}
                          className="flex items-center justify-center w-[3.5vmin] h-[3.5vmin] rounded-[0.6vmin] border-2 border-emerald-500/60 bg-[#2a1f4a] hover:bg-[#3a2f5a] text-emerald-400 font-black text-[1.4vmin] transition disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_1vmin_rgba(16,185,129,0.4)] hover:border-emerald-400"
                          title="Decrease by $50"
                        >
                          ◀
                        </button>
                        <div className="flex-1 text-center rounded-[0.6vmin] border-2 border-emerald-500/40 bg-[#221c38] py-[0.6vmin] px-[1vmin]">
                          <span className="text-[1.9vmin] font-black text-emerald-300 drop-shadow-[0_0_0.7vmin_rgba(52,211,153,0.9)]">+${landStartBonus}</span>
                        </div>
                        <button
                          onClick={() => handleLandBonusChange(landStartBonus + 50)}
                          disabled={isGameStarted}
                          className="flex items-center justify-center w-[3.5vmin] h-[3.5vmin] rounded-[0.6vmin] border-2 border-emerald-500/60 bg-[#2a1f4a] hover:bg-[#3a2f5a] text-emerald-400 font-black text-[1.4vmin] transition disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_1vmin_rgba(16,185,129,0.4)] hover:border-emerald-400"
                          title="Increase by $50"
                        >
                          ▶
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Quick Presets */}
                  <div className="grid grid-cols-3 gap-[0.6vmin] mt-[0.4vmin]">
                    {[
                      { label: "Standard", pass: 200, land: 300 },
                      { label: "Boosted", pass: 300, land: 450 },
                      { label: "High", pass: 400, land: 600 },
                    ].map((preset) => {
                      const isActive = passStartBonus === preset.pass && landStartBonus === preset.land;
                      return (
                        <button
                          key={preset.label}
                          onClick={() => handleBonusPresetChange(preset.pass, preset.land)}
                          disabled={isGameStarted}
                          className={`rounded-[0.7vmin] py-[0.6vmin] text-[1.1vmin] font-black transition-all cursor-pointer ${isActive
                              ? "border-[0.2vmin] border-indigo-300 bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-[0_0_1.2vmin_rgba(99,102,241,0.55)] scale-[1.02]"
                              : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400 hover:bg-[#30264e] hover:text-white"
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                          title={`${preset.label} (Pass: +$${preset.pass}, Land: +$${preset.land})`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Setting 3: Movement Speed */}
                <div className="flex flex-col gap-[0.6vmin]">
                  <span className="text-[1.35vmin] font-black uppercase tracking-wide text-gray-200">
                    ⚡ Game Speed:
                  </span>
                  <div className="flex gap-[0.5vmin]">
                    <button
                      onClick={() => setFastMode(false)}
                      className={`flex-1 rounded-[0.9vmin] py-[0.9vmin] text-[1.25vmin] font-black transition-all cursor-pointer active:scale-95 ${!fastMode
                          ? "border-[0.25vmin] border-purple-300 bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-[0_0_1.2vmin_rgba(168,85,247,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      1x Normal
                    </button>
                    <button
                      onClick={() => setFastMode(true)}
                      className={`flex-1 rounded-[0.9vmin] py-[0.9vmin] text-[1.25vmin] font-black transition-all cursor-pointer active:scale-95 ${fastMode
                          ? "border-[0.25vmin] border-amber-300 bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-[0_0_1.2vmin_rgba(245,158,11,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      ⚡ Fast
                    </button>
                  </div>
                </div>

                {/* Setting 4: Rest House Mode */}
                <div className="flex flex-col gap-[0.6vmin]">
                  <span className="text-[1.35vmin] font-black uppercase tracking-wide text-gray-200">
                    🏨 Rest House Money:
                  </span>
                  <div className="grid grid-cols-2 gap-[0.6vmin]">
                    <button
                      onClick={() => setRestHouseMode("pot")}
                      className={`rounded-[0.9vmin] py-[0.9vmin] text-[1.2vmin] font-black transition-all cursor-pointer active:scale-95 ${restHouseMode === "pot"
                          ? "border-[0.25vmin] border-emerald-300 bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-[0_0_1.2vmin_rgba(16,185,129,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      🎁 Collect Pot
                    </button>
                    <button
                      onClick={() => setRestHouseMode("rest")}
                      className={`rounded-[0.9vmin] py-[0.9vmin] text-[1.2vmin] font-black transition-all cursor-pointer active:scale-95 ${restHouseMode === "rest"
                          ? "border-[0.25vmin] border-orange-300 bg-gradient-to-r from-orange-500 to-red-600 text-white shadow-[0_0_1.2vmin_rgba(249,115,22,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      😴 Skip Turn
                    </button>
                  </div>
                  <span className="text-[1.15vmin] text-gray-400 italic">
                    {restHouseMode === "pot" ? "Money accumulates & pays out on landing" : "Player skips one turn, no money gained"}
                  </span>
                </div>

                {/* Setting 5: Game Rules Toggle */}
                <div className="flex flex-col gap-[0.8vmin]">
                  <span className="text-[1.4vmin] font-black uppercase tracking-wide text-gray-200">
                    📋 Game Rules:
                  </span>
                  <div className="grid grid-cols-2 gap-[0.6vmin]">
                    {/* Movement Cards */}
                    <button
                      onClick={() => setEnableMovementCards((prev) => !prev)}
                      className={`rounded-[0.9vmin] py-[0.85vmin] px-[0.8vmin] text-[1.15vmin] font-black transition-all cursor-pointer active:scale-95 ${enableMovementCards
                          ? "border-[0.25vmin] border-blue-300 bg-gradient-to-r from-blue-600 to-cyan-600 text-white shadow-[0_0_1.2vmin_rgba(59,130,246,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      {enableMovementCards ? "🎴 Cards" : "❌ No Cards"}
                    </button>

                    {/* Trading */}
                    <button
                      onClick={() => setEnableTrading((prev) => !prev)}
                      className={`rounded-[0.9vmin] py-[0.85vmin] px-[0.8vmin] text-[1.15vmin] font-black transition-all cursor-pointer active:scale-95 ${enableTrading
                          ? "border-[0.25vmin] border-pink-300 bg-gradient-to-r from-pink-600 to-rose-600 text-white shadow-[0_0_1.2vmin_rgba(219,39,119,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      {enableTrading ? "🤝 Trading" : "❌ No Trade"}
                    </button>

                    {/* Mortgage */}
                    <button
                      onClick={() => setEnableMortgage((prev) => !prev)}
                      className={`rounded-[0.9vmin] py-[0.85vmin] px-[0.8vmin] text-[1.15vmin] font-black transition-all cursor-pointer active:scale-95 ${enableMortgage
                          ? "border-[0.25vmin] border-yellow-300 bg-gradient-to-r from-yellow-600 to-amber-600 text-white shadow-[0_0_1.2vmin_rgba(217,119,6,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      {enableMortgage ? "💳 Mortgage" : "❌ No Mort"}
                    </button>

                    {/* Jail Rent */}
                    <button
                      onClick={() => setJailCollectsRent((prev) => !prev)}
                      className={`rounded-[0.9vmin] py-[0.85vmin] px-[0.8vmin] text-[1.15vmin] font-black transition-all cursor-pointer active:scale-95 ${jailCollectsRent
                          ? "border-[0.25vmin] border-red-300 bg-gradient-to-r from-red-600 to-pink-600 text-white shadow-[0_0_1.2vmin_rgba(220,38,38,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      {jailCollectsRent ? "🔒 Rent Ok" : "❌ No Rent"}
                    </button>

                    {/* Auctions */}
                    <button
                      onClick={() => setEnableAuction((prev) => !prev)}
                      className={`rounded-[0.9vmin] py-[0.85vmin] px-[0.8vmin] text-[1.15vmin] font-black transition-all cursor-pointer active:scale-95 ${enableAuction
                          ? "border-[0.25vmin] border-amber-300 bg-gradient-to-r from-amber-600 to-orange-600 text-white shadow-[0_0_1.2vmin_rgba(217,119,6,0.45)]"
                          : "border-2 border-white/20 bg-[#221c38] text-gray-100 hover:border-purple-400"
                        }`}
                    >
                      {enableAuction ? "🔨 Auctions" : "❌ No Auction"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Start Game Button */}
              <div className="mt-[1.4vmin] border-t-2 border-white/10 pt-[1.1vmin]">
                <button
                  onClick={handleStartGame}
                  className="flex w-full items-center justify-center gap-[0.8vmin] rounded-[1.1vmin] border-2 border-emerald-300/70 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 py-[1.4vmin] text-[1.55vmin] font-black uppercase tracking-widest text-white shadow-[0_0_2.5vmin_rgba(16,185,129,0.5)] transition-all hover:scale-[1.02] hover:brightness-110 active:scale-95 cursor-pointer"
                >
                  <span className="text-[1.8vmin]">▶</span>
                  <span>Start Game & Lock Settings</span>
                </button>
              </div>
            </div>
          )}

          {/* ================= FLOATING SETTINGS ICON (WHEN GAME IS STARTED) ================= */}
          {isGameStarted && (
            <>
              <button
                onClick={() => setIsSettingsExpanded(true)}
                className="fixed bottom-[2.5vmin] left-[2.5vmin] z-[150] flex h-[5.5vmin] w-[5.5vmin] items-center justify-center rounded-full border-2 border-purple-400/80 bg-gradient-to-br from-[#241a45] to-[#120b24] text-[2.6vmin] shadow-[0_0_2.5vmin_rgba(168,85,247,0.5)] transition-all hover:scale-110 hover:border-purple-300 hover:shadow-[0_0_3.5vmin_rgba(168,85,247,0.8)] active:scale-95 cursor-pointer"
                title="Open Locked Game Settings"
              >
                ⚙️
                <span className="absolute -top-[0.3vmin] -right-[0.3vmin] flex h-[2vmin] w-[2vmin] items-center justify-center rounded-full bg-amber-500 text-[1.1vmin] font-black text-black shadow">
                  🔒
                </span>
              </button>

              {/* Settings Overlay Popover */}
              {isSettingsExpanded && (
                <div
                  className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-[2vmin] backdrop-blur-sm"
                  onClick={() => setIsSettingsExpanded(false)}
                >
                  <div
                    className="relative flex max-h-[85vh] w-[50vmin] flex-col overflow-hidden rounded-[2vmin] border-2 border-purple-500/50 bg-[#141024] p-[2.4vmin] text-white shadow-[0_0_4vmin_rgba(139,92,246,0.45)]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between border-b border-purple-500/30 pb-[1.4vmin] mb-[1.8vmin]">
                      <div className="flex items-center gap-[0.8vmin]">
                        <span className="text-[2.4vmin]">⚙️</span>
                        <span className="text-[2vmin] font-black uppercase tracking-wider text-white">Game Settings</span>
                        <span className="ml-[0.6vmin] rounded-full border border-amber-400/80 bg-amber-500/20 px-[1.2vmin] py-[0.3vmin] text-[1.1vmin] font-black text-amber-300">
                          🔒 LOCKED
                        </span>
                      </div>
                      <button
                        onClick={() => setIsSettingsExpanded(false)}
                        className="flex h-[3.2vmin] w-[3.2vmin] items-center justify-center rounded-full bg-white/10 text-[1.4vmin] text-gray-300 transition hover:bg-white/20 hover:text-white cursor-pointer"
                        title="Close"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Settings list (Read Only) */}
                    <div className="flex flex-col gap-[1.4vmin] overflow-y-auto max-h-[50vh] pr-[1vmin]">
                      <div className="flex items-center justify-between rounded-[1vmin] border border-white/10 bg-white/5 p-[1.2vmin]">
                        <span className="text-[1.35vmin] font-bold text-gray-300">👥 Number of Players</span>
                        <span className="text-[1.45vmin] font-black text-purple-300">{players.length} Players</span>
                      </div>
                      <div className="flex items-center justify-between rounded-[1vmin] border border-white/10 bg-white/5 p-[1.2vmin]">
                        <span className="text-[1.35vmin] font-bold text-gray-300">💵 Starting Cash</span>
                        <span className="text-[1.45vmin] font-black text-emerald-400">${startingCash.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-[1vmin] border border-white/10 bg-white/5 p-[1.2vmin]">
                        <span className="text-[1.35vmin] font-bold text-gray-300">🚩 START Pass / Land Bonus</span>
                        <span className="text-[1.8vmin] font-black text-cyan-200 drop-shadow-[0_0_0.7vmin_rgba(103,232,249,0.9)]">+${passStartBonus} / +${landStartBonus}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-[1vmin] border border-white/10 bg-white/5 p-[1.2vmin]">
                        <span className="text-[1.35vmin] font-bold text-gray-300">⚡ Game Speed</span>
                        <span className="text-[1.4vmin] font-black text-amber-300">{fastMode ? "⚡ Fast Speed" : "🐢 Normal Speed"}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-[1vmin] border border-white/10 bg-white/5 p-[1.2vmin]">
                        <span className="text-[1.35vmin] font-bold text-gray-300">🏨 Rest House</span>
                        <span className="text-[1.4vmin] font-black text-green-300">{restHouseMode === "pot" ? "🎁 Collect Pot" : "😴 Skip Turn"}</span>
                      </div>
                      <div className="border-t border-white/10 pt-[1vmin] mt-[0.6vmin]">
                        <span className="text-[1.3vmin] font-bold text-gray-400 mb-[0.8vmin] block">📋 Game Rules:</span>
                        <div className="grid grid-cols-2 gap-[0.8vmin]">
                          <div className="flex items-center gap-[0.6vmin] rounded-[0.9vmin] border border-white/10 bg-white/5 p-[1vmin]">
                            <span className="text-[1.35vmin]">{enableMovementCards ? "✅" : "❌"}</span>
                            <span className="text-[1.2vmin] font-bold text-gray-300">Movement Cards</span>
                          </div>
                          <div className="flex items-center gap-[0.6vmin] rounded-[0.9vmin] border border-white/10 bg-white/5 p-[1vmin]">
                            <span className="text-[1.35vmin]">{enableTrading ? "✅" : "❌"}</span>
                            <span className="text-[1.2vmin] font-bold text-gray-300">Trading</span>
                          </div>
                          <div className="flex items-center gap-[0.6vmin] rounded-[0.9vmin] border border-white/10 bg-white/5 p-[1vmin]">
                            <span className="text-[1.35vmin]">{enableMortgage ? "✅" : "❌"}</span>
                            <span className="text-[1.2vmin] font-bold text-gray-300">Mortgage</span>
                          </div>
                          <div className="flex items-center gap-[0.6vmin] rounded-[0.9vmin] border border-white/10 bg-white/5 p-[1vmin]">
                            <span className="text-[1.35vmin]">{jailCollectsRent ? "✅" : "❌"}</span>
                            <span className="text-[1.2vmin] font-bold text-gray-300">Jail Rent</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => setIsSettingsExpanded(false)}
                      className="mt-[2.2vmin] w-full rounded-[1vmin] bg-gradient-to-r from-purple-600 to-indigo-600 py-[1.1vmin] text-[1.3vmin] font-black uppercase text-white shadow transition hover:brightness-110 cursor-pointer"
                    >
                      Close Settings
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ================= FLOATING CHAT SYSTEM (BOTTOM RIGHT) ================= */}
          <button
            onClick={() => {
              setIsChatOpen((prev) => !prev);
              if (!isChatOpen) setUnreadChatCount(0);
            }}
            className="fixed bottom-[2.5vmin] right-[2.5vmin] z-[160] flex h-[5.5vmin] w-[5.5vmin] items-center justify-center rounded-full border-2 border-indigo-400/80 bg-gradient-to-br from-[#1e153b] via-[#140e2b] to-[#0d091d] text-[2.6vmin] shadow-[0_0_2.5vmin_rgba(99,102,241,0.5)] transition-all hover:scale-110 hover:border-cyan-300 hover:shadow-[0_0_3.5vmin_rgba(6,182,212,0.7)] active:scale-95 cursor-pointer"
            title="Open Player Chat"
          >
            💬
            {!isChatOpen && unreadChatCount > 0 && (
              <span className="absolute -top-[0.4vmin] -right-[0.4vmin] flex h-[2.2vmin] w-[2.2vmin] items-center justify-center rounded-full bg-gradient-to-r from-red-500 to-rose-500 text-[1.1vmin] font-black text-white shadow-lg animate-bounce">
                {unreadChatCount > 9 ? "9+" : unreadChatCount}
              </span>
            )}
          </button>

          {/* Chat Window Popover */}
          {isChatOpen && (
            <div className="fixed bottom-[9vmin] right-[2.5vmin] z-[180] flex h-[54vmin] w-[42vmin] flex-col overflow-hidden rounded-[2vmin] border-2 border-indigo-500/50 bg-[#120c24] text-white shadow-[0_0_4.5vmin_rgba(99,102,241,0.45)] backdrop-blur-md">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-indigo-500/30 bg-[#191133] px-[1.8vmin] py-[1.2vmin]">
                <div className="flex items-center gap-[0.8vmin]">
                  <span className="text-[2vmin]">💬</span>
                  <span className="text-[1.65vmin] font-black uppercase tracking-wider text-white">Player Chat</span>
                  <span className="rounded-full bg-emerald-500/20 border border-emerald-400/50 px-[0.8vmin] py-[0.1vmin] text-[0.85vmin] font-bold text-emerald-300">
                    ● Live
                  </span>
                </div>
                <button
                  onClick={() => setIsChatOpen(false)}
                  className="flex h-[3vmin] w-[3vmin] items-center justify-center rounded-full bg-white/10 text-[1.2vmin] text-gray-300 transition hover:bg-white/20 hover:text-white cursor-pointer"
                  title="Close chat"
                >
                  ✕
                </button>
              </div>

              {/* Messages Body */}
              <div className="flex flex-1 flex-col gap-[1vmin] overflow-y-auto p-[1.4vmin] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden bg-[#0d091a]">
                {chatMessages.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-[0.8vmin] text-center text-gray-400">
                    <span className="text-[3vmin] opacity-60">👋</span>
                    <p className="text-[1.2vmin] font-medium">No messages yet.</p>
                    <p className="text-[1vmin] text-gray-500">Say hello to other players!</p>
                  </div>
                ) : (
                  chatMessages.map((msg) => {
                    const isSelf = currentPlayer && msg.senderId === currentPlayer.id;
                    return (
                      <div
                        key={msg.id}
                        className={`flex flex-col gap-[0.2vmin] ${isSelf ? "items-end" : "items-start"}`}
                      >
                        <div className="flex items-center gap-[0.6vmin] px-[0.2vmin]">
                          <span className="text-[0.95vmin] font-black" style={{ color: msg.senderColor }}>
                            {msg.senderName} {isSelf ? "(You)" : ""}
                          </span>
                          <span className="text-[0.8vmin] text-gray-400">{msg.timestamp}</span>
                        </div>
                        <div
                          className={`max-w-[85%] rounded-[1.2vmin] px-[1.2vmin] py-[0.8vmin] text-[1.25vmin] font-medium leading-normal shadow ${isSelf
                              ? "bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-tr-none"
                              : "bg-[#1c1538] border border-purple-500/30 text-gray-100 rounded-tl-none"
                            }`}
                        >
                          {msg.text}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={chatMessagesEndRef} />
              </div>

              {/* Input Footer */}
              <form onSubmit={handleSendChatMessage} className="flex items-center gap-[0.8vmin] border-t border-indigo-500/30 bg-[#160f2e] p-[1.1vmin]">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Type a message..."
                  maxLength={200}
                  className="flex-1 rounded-[0.9vmin] border border-purple-500/40 bg-[#0e091f] px-[1.2vmin] py-[0.8vmin] text-[1.25vmin] font-medium text-white placeholder:text-gray-500 focus:border-cyan-400 focus:bg-[#140c2c] focus:outline-none transition-all"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim()}
                  className="flex items-center justify-center rounded-[0.9vmin] bg-gradient-to-r from-purple-600 via-indigo-600 to-cyan-600 px-[1.6vmin] py-[0.8vmin] text-[1.3vmin] font-black uppercase text-white shadow transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  title="Send message"
                >
                  ✈️
                </button>
              </form>
            </div>
          )}

        {/* ================= DUAL-COLUMN AUCTION POP-UP MODAL ================= */}
        {activeAuction && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-[2vmin] backdrop-blur-md">
            <div className="relative flex max-h-[92vh] w-[90vmin] flex-col overflow-hidden rounded-[2vmin] border-2 border-amber-500/50 bg-[#120b24] text-white shadow-[0_0_5vmin_rgba(245,158,11,0.45)]">
              {/* Header */}
              <div className="relative flex items-center justify-between border-b border-amber-500/30 bg-[#190f33] px-[2.4vmin] py-[1.6vmin]">
                <div className="flex items-center gap-[1vmin]">
                  <span className="text-[2.4vmin]">🔨</span>
                  <div>
                    <h3 className="text-[2.2vmin] font-black uppercase tracking-wider text-amber-300">
                      PROPERTY AUCTION
                    </h3>
                    <p className="text-[1.1vmin] font-medium text-gray-300">
                      Bidding starts at $2. Highest bidder wins the property!
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-[1.2vmin]">
                  <div className="flex items-center gap-[0.6vmin] rounded-full border border-amber-400/60 bg-amber-500/20 px-[1.4vmin] py-[0.4vmin] shadow">
                    <span className="text-[1.2vmin] font-bold text-amber-200">⏳ Time Left:</span>
                    <span className="font-mono text-[1.6vmin] font-black text-amber-300 animate-pulse">
                      {activeAuction.timeLeft}s
                    </span>
                  </div>
                </div>
              </div>

              {/* Body: Dual Column */}
              {(() => {
                const tile = BOARD_TILES.find((t) => t.id === activeAuction.tileId);
                if (!tile) return null;
                const highestBidder = players.find((p) => p.id === activeAuction.highestBidderId);
                const hasCurrentPassed = currentPlayer && activeAuction.passedPlayerIds.includes(currentPlayer.id);
                const isCurrentHighest = currentPlayer && activeAuction.highestBidderId === currentPlayer.id;

                return (
                  <div className="flex flex-1 overflow-y-auto p-[2.4vmin] gap-[2vmin]">
                    {/* Left Column: Bidding Controls */}
                    <div className="flex flex-1 flex-col gap-[1.8vmin] justify-between">
                      {/* Current Bid Display */}
                      <div className="flex flex-col items-center justify-center rounded-[1.6vmin] border-2 border-amber-500/40 bg-[#1b1236] p-[2vmin] text-center shadow-inner">
                        <span className="text-[1.2vmin] font-black uppercase tracking-widest text-gray-400">Current Highest Bid</span>
                        <span className="my-[0.4vmin] font-mono text-[4.2vmin] font-black text-amber-300 drop-shadow-[0_0_1.5vmin_rgba(245,158,11,0.7)]">
                          ${activeAuction.currentBid.toLocaleString()}
                        </span>
                        {highestBidder ? (
                          <div className="flex items-center gap-[0.7vmin] rounded-full border border-emerald-400/50 bg-emerald-500/15 px-[1.4vmin] py-[0.3vmin]">
                            <span className="h-[1.2vmin] w-[1.2vmin] rounded-full" style={{ backgroundColor: highestBidder.color }} />
                            <span className="text-[1.35vmin] font-black text-emerald-300">
                              Highest Bidder: {highestBidder.name}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[1.2vmin] font-bold italic text-gray-400">
                            No bids placed yet (Starts at $2)
                          </span>
                        )}
                      </div>

                      {/* Bidding Increments Buttons (+$2, +$10, +$100) */}
                      <div className="flex flex-col gap-[1vmin]">
                        <span className="text-[1.2vmin] font-black uppercase tracking-wider text-amber-300">
                          Place a Bid (Shows Resulting Total Bid):
                        </span>
                        <div className="grid grid-cols-3 gap-[1vmin]">
                          {[2, 10, 100].map((inc) => {
                            const resultingBid = activeAuction.currentBid + inc;
                            const canAfford = currentPlayer && (currentPlayer.money ?? 0) >= resultingBid;
                            const isDisabled = !currentPlayer || !canAfford || hasCurrentPassed || isCurrentHighest;

                            return (
                              <button
                                key={inc}
                                onClick={() => handlePlaceBid(inc)}
                                disabled={isDisabled}
                                className={`flex flex-col items-center justify-center rounded-[1.2vmin] border-2 py-[1.4vmin] px-[1vmin] transition-all cursor-pointer ${
                                  isCurrentHighest
                                    ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-300 opacity-60 cursor-not-allowed"
                                    : isDisabled
                                    ? "border-white/10 bg-white/5 text-gray-500 opacity-40 cursor-not-allowed"
                                    : "border-amber-400/80 bg-gradient-to-br from-amber-600 via-orange-600 to-amber-700 text-white shadow-[0_0_1.6vmin_rgba(245,158,11,0.5)] hover:scale-[1.04] hover:brightness-110 active:scale-95"
                                }`}
                              >
                                <span className="text-[1.8vmin] font-black">+${inc}</span>
                                <span className="mt-[0.2vmin] font-mono text-[1.35vmin] font-bold text-amber-200">
                                  (${resultingBid.toLocaleString()})
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Status Note & Pass Button */}
                      <div className="flex flex-col gap-[1vmin]">
                        {hasCurrentPassed ? (
                          <div className="rounded-[1vmin] border border-red-500/40 bg-red-950/30 py-[1vmin] text-center text-[1.25vmin] font-bold text-red-300">
                            ❌ You passed on this auction
                          </div>
                        ) : isCurrentHighest ? (
                          <div className="rounded-[1vmin] border border-emerald-500/40 bg-emerald-950/30 py-[1vmin] text-center text-[1.25vmin] font-bold text-emerald-300">
                            👑 You are currently the highest bidder!
                          </div>
                        ) : (
                          <button
                            onClick={handlePassAuction}
                            className="w-full rounded-[1vmin] border border-red-500/40 bg-red-950/40 py-[1.2vmin] text-[1.3vmin] font-black uppercase text-red-200 transition hover:bg-red-900/60 hover:text-white cursor-pointer active:scale-95"
                          >
                            Pass / Withdraw from Auction
                          </button>
                        )}
                      </div>

                      {/* Bidders Status Grid */}
                      <div className="flex flex-col gap-[0.6vmin] border-t border-white/10 pt-[1.2vmin]">
                        <span className="text-[1.15vmin] font-black uppercase text-gray-400">Players Status:</span>
                        <div className="flex flex-wrap gap-[0.6vmin]">
                          {alivePlayers.map((p) => {
                            const isPassed = activeAuction.passedPlayerIds.includes(p.id);
                            const isHighest = activeAuction.highestBidderId === p.id;
                            return (
                              <div
                                key={p.id}
                                className={`flex items-center gap-[0.5vmin] rounded-full border px-[1vmin] py-[0.3vmin] text-[1.05vmin] font-bold ${
                                  isHighest
                                    ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                                    : isPassed
                                    ? "border-red-500/40 bg-red-950/40 text-gray-500 line-through"
                                    : "border-white/15 bg-white/5 text-gray-200"
                                }`}
                              >
                                <span className="h-[0.8vmin] w-[0.8vmin] rounded-full" style={{ backgroundColor: p.color }} />
                                <span>{p.name}</span>
                                <span>{isHighest ? "👑" : isPassed ? "❌" : "⚡"}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Right Column: Full Info of the Card Being Auctioned */}
                    <div className="w-[42vmin] shrink-0 rounded-[1.6vmin] border border-purple-500/30 bg-[#161226] p-[2vmin] shadow-lg flex flex-col justify-between">
                      <div>
                        {/* Header Badge */}
                        <div className="flex flex-col items-center text-center pb-[1.4vmin] border-b border-white/10">
                          {renderTileIconOrFlag(tile, "w-[4.8vmin] h-[3.2vmin]")}
                          <h4 className="mt-[0.8vmin] text-[2.2vmin] font-black text-white uppercase">{tile.name}</h4>
                          <span className="text-[1.2vmin] font-bold text-emerald-400 font-mono">Bank Value: {tile.price}</span>
                        </div>

                        {/* Rent Table */}
                        {PROPERTY_TYPES.has(tile.type) && tile.rents && (
                          <div className="my-[1.4vmin] space-y-[0.6vmin] text-[1.25vmin]">
                            <div className="text-[1.1vmin] font-black uppercase text-purple-300 tracking-wider mb-[0.4vmin]">Rent Structure:</div>
                            {[
                              { label: "Base Rent", val: tile.rents[0] },
                              { label: "1 House", val: tile.rents[1] },
                              { label: "2 Houses", val: tile.rents[2] },
                              { label: "3 Houses", val: tile.rents[3] },
                              { label: "4 Houses", val: tile.rents[4] },
                              { label: "Hotel", val: tile.rents[5] },
                            ].map((r) => (
                              <div key={r.label} className="flex justify-between text-gray-300">
                                <span>{r.label}</span>
                                <span className="font-mono font-black text-emerald-300">${r.val}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Utility Table */}
                        {UTILITY_TYPES.has(tile.type) && UTILITY_RENT_TABLE[tile.type] && (
                          <div className="my-[1.4vmin] space-y-[0.6vmin] text-[1.25vmin]">
                            <div className="text-[1.1vmin] font-black uppercase text-purple-300 tracking-wider mb-[0.4vmin]">Utility Rent Tiers:</div>
                            {UTILITY_RENT_TABLE[tile.type].map((amt, idx) => (
                              <div key={idx} className="flex justify-between text-gray-300">
                                <span>If owner holds {idx + 1}</span>
                                <span className="font-mono font-black text-emerald-300">${amt}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* House / Hotel Cost Footer */}
                      {PROPERTY_TYPES.has(tile.type) && (
                        <div className="flex items-center justify-between border-t border-white/10 pt-[1.2vmin] text-[1.2vmin]">
                          <span className="text-gray-400">🏠 House: <strong className="text-white">${tile.houseCost || 100}</strong></span>
                          <span className="text-gray-400">🏨 Hotel: <strong className="text-white">${tile.hotelCost || 100}</strong></span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
        </div>
      </div>
    </main>
  );
}