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

const INITIAL_PLAYERS: Player[] = [
  { id: 1, name: "You", color: "#8b5cf6", money: STARTING_MONEY, position: 0, isCurrentPlayer: true, mood: "happy" },
  { id: 2, name: "Alex", color: "#22c55e", money: STARTING_MONEY, position: 0, mood: "happy" },
  { id: 3, name: "Sam", color: "#ef4444", money: STARTING_MONEY, position: 0, mood: "happy" },
  { id: 4, name: "Jordan", color: "#f59e0b", money: STARTING_MONEY, position: 0, mood: "happy" },
];

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

const getTokenAnchor = (orientation: string) => {
  switch (orientation) {
    case "bottom":
      return { top: "32%", left: "50%" };
    case "top":
      return { top: "68%", left: "50%" };
    case "left":
      return { top: "50%", left: "68%" };
    case "right":
      return { top: "50%", left: "32%" };
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
  const [specialModal, setSpecialModal] = useState<"treasure" | "surprise" | "tax" | null>(null);
  const [propertyHouses, setPropertyHouses] = useState<Record<number, number>>(INITIAL_HOUSES);
  const [propertyOwnership, setPropertyOwnership] = useState<Record<number, number>>(PROPERTY_OWNERSHIP);
  const [players, setPlayers] = useState<Player[]>(INITIAL_PLAYERS);
  const [actionLog, setActionLog] = useState<string[]>(["Game started. Waiting for your move..."]);
  const [gamePhase, setGamePhase] = useState<"YOUR TURN" | "ROLLING..." | "MOVING..." | "ACTION" | "END TURN">("YOUR TURN");
  const [winner, setWinner] = useState<Player | null>(null);
  const [escapingIds, setEscapingIds] = useState<number[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [restHousePot, setRestHousePot] = useState(0);

  const currentPlayer = useMemo(() => players.find((p) => p.isCurrentPlayer), [players]);
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
    if (amount <= 0) return;
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
      const startBonus = currentPos === 0 ? (landsOnStart ? LAND_START_BONUS : PASS_START_BONUS) : 0;

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
      moveTimeoutRef.current = window.setTimeout(step, 260);
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

    setPlayers((prev) => {
      const updated = prev.map((p) =>
        p.id === playerId ? { ...p, isBankrupt: true, money: 0, isCurrentPlayer: false } : p
      );
      checkForWinnerAmong(updated);
      return updated;
    });

    const creditor = creditorId ? playersRef.current.find((p) => p.id === creditorId) : undefined;
    addLog(
      `${player.name} went BANKRUPT${
        creditor ? ` — ${creditor.name} seized their properties` : " — properties returned to the bank"
      }.`
    );
  };

  // Instantly moves a player to a target tile (for card-driven jumps rather
  // than a dice roll), crediting the pass-START bonus if the jump wraps
  // around, then resolves whatever they land on exactly like a normal move.
  const teleportAndLand = (playerId: number, targetIndex: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player) return;

       const wrapped = targetIndex < player.position;
    const landsOnStart = targetIndex === 0;
    const startBonus = landsOnStart ? LAND_START_BONUS : wrapped ? PASS_START_BONUS : 0;

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
      const houses = propertyHouses[tile.id] || 0;
      const rent = PROPERTY_TYPES.has(tile.type)
        ? calculateRent(tile, houses)
        : calculateUtilityRent(tile, ownerId);
      const owner = playersRef.current.find((p) => p.id === ownerId);

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
    triggerJailBreak(currentPlayer.id);
    addLog(`${currentPlayer.name} paid -$${bail} bail and is released from JAIL.`);
  };

  const openSkillCard = () => {
    if (!hasSkillCard || isRolling || isMoving || gamePhase !== "YOUR TURN" || winner || currentPlayer?.inJail || currentPlayer?.isResting) return;
    setShowCardSelector(true);
    setSelectedCardValue(null);
  };

  const confirmSkillCard = () => {
    if (!selectedCardValue || !hasSkillCard) return;
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
  };

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
          const tokenAnchor = getTokenAnchor(orientation);

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
              className={`relative flex cursor-pointer items-center justify-center rounded-[0.9vmin] transition-all duration-300 hover:z-30 hover:scale-[1.04] ${
                owner ? "" : "shadow-lg hover:shadow-[0_0_2vmin_rgba(255,255,255,0.35)]"
              } ${
                isCorner
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
                  className="absolute z-50 flex items-center"
                  style={{
                    top: tokenAnchor.top,
                    left: tokenAnchor.left,
                    transform: "translate(-50%, -50%)",
                    maxWidth: "80%",
                  }}
                >
                  {(() => {
                    const MAX_VISIBLE = 3;
                    const overflowCount = Math.max(0, playersHere.length - MAX_VISIBLE);
                    const visible = overflowCount > 0 ? playersHere.slice(0, MAX_VISIBLE - 1) : playersHere;
                    const size = "3.8vmin";

                    return (
                      <>
                        {visible.map((player, idx) => {
                          const isEscaping = escapingIds.includes(player.id);
                          return (
                            <div
                              key={player.id}
                              className="relative"
                              style={{
                                height: size,
                                width: size,
                                marginLeft: idx === 0 ? 0 : "-1.15vmin",
                                zIndex: player.isCurrentPlayer ? 10 : idx,
                                animation: player.inJail
                                  ? isEscaping
                                    ? "jailBreak 0.7s ease-out"
                                    : "jailRattle 1.8s ease-in-out infinite"
                                  : undefined,
                              }}
                            >
                              <div
                                title={player.name}
                                className="relative flex h-full w-full items-center justify-center rounded-full transition-transform duration-300 hover:z-20 hover:scale-110"
                                style={{
                                  background: `radial-gradient(circle at 30% 24%, ${player.color}ff, ${player.color}ee 42%, ${player.color} 68%, #00000066 100%)`,
                                  border: `0.09vmin solid ${player.color}`,
                                  boxShadow: player.isCurrentPlayer
                                    ? `0 0 1.8vmin ${player.color}cc, 0 0 0.5vmin ${player.color}, 0 0.7vmin 1.3vmin rgba(0,0,0,0.75), inset 0 0.25vmin 0.35vmin rgba(255,255,255,0.45), inset 0 -0.3vmin 0.4vmin rgba(0,0,0,0.35)`
                                    : `0 0 0.6vmin ${player.color}aa, 0 0.5vmin 1vmin rgba(0,0,0,0.65), inset 0 0.22vmin 0.3vmin rgba(255,255,255,0.35), inset 0 -0.25vmin 0.35vmin rgba(0,0,0,0.3)`,
                                  animation: player.isCurrentPlayer
                                    ? `tokenGlow 1.4s ease-in-out infinite ${(player.id % 4) * 0.15}s`
                                    : undefined,
                                }}
                              >
                                <div
                                  className="pointer-events-none absolute left-[16%] top-[12%] h-[38%] w-[38%] rounded-full opacity-80"
                                  style={{ background: "radial-gradient(circle, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%)" }}
                                />
                                <div className="absolute inset-0 flex flex-col items-center justify-center">
                                  {player.mood === "flat" ? (
                                    <>
                                      <div className="flex gap-[0.45vmin]">
                                        <div className="h-[0.26vmin] w-[0.7vmin] rounded-full bg-white/95" />
                                        <div className="h-[0.26vmin] w-[0.7vmin] rounded-full bg-white/95" />
                                      </div>
                                      <div className="mt-[0.25vmin] h-[0.26vmin] w-[1.05vmin] rounded-full bg-white/85" />
                                    </>
                                  ) : (
                                    <>
                                      <div className="flex gap-[0.45vmin]">
                                        <div className="h-[0.52vmin] w-[0.52vmin] rounded-full bg-white/95" />
                                        <div className="h-[0.52vmin] w-[0.52vmin] rounded-full bg-white/95" />
                                      </div>
                                      <div className="mt-[0.1vmin] h-[0.42vmin] w-[0.8vmin] rounded-b-full border-b-[0.16vmin] border-l-[0.16vmin] border-r-[0.16vmin] border-white/85 bg-transparent" />
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* Jail bars overlay - visible while locked up, hidden during the breakout pop */}
                              {player.inJail && !isEscaping && (
                                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-[0.16vmin] overflow-hidden rounded-full bg-black/15">
                                  <div className="h-[85%] w-[0.16vmin] rounded-full bg-white/85 shadow-[0_0_0.3vmin_rgba(0,0,0,0.6)]" />
                                  <div className="h-[85%] w-[0.16vmin] rounded-full bg-white/85 shadow-[0_0_0.3vmin_rgba(0,0,0,0.6)]" />
                                  <div className="h-[85%] w-[0.16vmin] rounded-full bg-white/85 shadow-[0_0_0.3vmin_rgba(0,0,0,0.6)]" />
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {overflowCount > 0 && (
                          <div
                            title={`+${overflowCount} more`}
                            className="relative flex items-center justify-center rounded-full bg-[#1c1626] text-white"
                            style={{
                              height: size,
                              width: size,
                              marginLeft: "-0.9vmin",
                              zIndex: 20,
                              border: "0.16vmin solid rgba(255,255,255,0.5)",
                              boxShadow: "0 0.4vmin 0.9vmin rgba(0,0,0,0.6)",
                            }}
                          >
                            <span className="text-[1.05vmin] font-black">+{overflowCount}</span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {isCorner ? (
                <div className="z-10 flex flex-col items-center justify-center gap-[0.3vmin]">
                  <span className="text-[3.8vmin] drop-shadow-[0_0_1vmin_rgba(255,255,255,0.4)]">
                    {tile.icon}
                  </span>
                  <div className="text-center text-[1.35vmin] font-black uppercase leading-tight tracking-widest text-white drop-shadow-md">
                    {tile.name}
                  </div>
                </div>
              ) : (
                <div className="relative z-40 flex h-full w-full items-center justify-center p-[0.6vmin]">
                  <div
                    className={`absolute left-1/2 top-1/2 flex items-center justify-start ${
                      orientation === "top" ? "flex-col-reverse" : "flex-col"
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
                      className={`absolute left-1/2 z-40 flex -translate-x-1/2 items-center justify-center ${
                        orientation === "top" ? "bottom-0 translate-y-1/2" : "top-0 -translate-y-1/2"
                      }`}
                    >
                      {tile.countryCode ? (
                        <div
                          className={`h-[3vmin] w-[4.6vmin] overflow-hidden rounded-[0.5vmin] border-[0.22vmin] shadow-lg transition-all duration-300 ${
                            isOccupied ? "scale-110 border-white shadow-[0_0_1.4vmin_rgba(255,255,255,0.5)]" : "border-white/80"
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
                        className={`relative z-[60] whitespace-nowrap font-bold uppercase leading-tight tracking-wide text-gray-100 ${
                          isOccupied ? "rounded-[0.4vmin] bg-[#0f0c16]/90 px-[0.5vmin] py-[0.1vmin] shadow-md" : ""
                        }`}
                        style={{ fontSize: `${getNameFontSize(tile.name)}vmin` }}
                      >
                        {tile.name}
                      </span>
                    </div>

                    {!owner && tile.price ? (
                      <div
                        className={`m-[0.2vmin] flex h-[2.6vmin] w-[85%] max-w-[7vmin] items-center justify-center rounded-[0.35vmin] text-center font-black ${
                          tile.price.includes("-")
                            ? "bg-red-500/80 text-white"
                            : "border border-[#526171] bg-[#293541] text-[#e7eef5]"
                        }`}
                      >
                        <span className="whitespace-nowrap text-[1.15vmin]">{tile.price}</span>
                      </div>
                    ) : owner ? (
                      <div
                        className={`m-[0.2vmin] flex h-[2.6vmin] w-[85%] max-w-[7vmin] items-center justify-center rounded-[0.3vmin] text-center font-black uppercase tracking-wide ${
                          isProperty && houses > 0 ? "invisible" : ""
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
                        className={`absolute left-1/2 z-[70] flex -translate-x-1/2 items-center justify-center gap-[0.35vmin] rounded-[0.5vmin] border-[0.2vmin] px-[0.6vmin] shadow-lg ${
                          orientation === "top" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2"
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
          <div className="flex w-full items-start justify-between">
            <div className="flex flex-col items-start">
              <span className="text-[1vmin] font-bold uppercase tracking-[0.2em] text-gray-500">Current</span>
              <div className="flex items-center gap-[0.5vmin]">
                <span className="h-[1.2vmin] w-[1.2vmin] rounded-full" style={{ backgroundColor: currentPlayer?.color }} />
                <span className="text-[1.6vmin] font-black text-white">{currentPlayer?.name}</span>
              </div>
              <span className="text-[1.3vmin] font-bold text-emerald-400">
                ${(currentPlayer?.money ?? 0).toLocaleString()}
              </span>
            </div>

            <div className="flex items-center gap-[0.8vmin]">
              <button
                onClick={toggleFullscreen}
                className="rounded-full border border-white/10 bg-white/5 px-[1.2vmin] py-[0.5vmin] text-[1.1vmin] text-gray-300 hover:bg-white/10"
              >
                {isFullscreen ? "Exit" : "Fullscreen"}
              </button>
              <div className="flex items-center gap-[0.5vmin] rounded-full border border-white/10 bg-white/5 px-[1.2vmin] py-[0.5vmin]">
                <div className={`h-[0.8vmin] w-[0.8vmin] rounded-full ${isConnected ? "animate-pulse bg-green-400" : "bg-red-500"}`} />
                <span className="text-[1.1vmin] text-gray-300">{connectionLabel}</span>
              </div>
            </div>
          </div>

          <div>
            <div
              className={`mx-auto w-fit rounded-full border px-[1.8vmin] py-[0.4vmin] text-[1.1vmin] font-black uppercase tracking-widest ${
                gamePhase === "YOUR TURN"
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

                {!currentPlayer?.inJail && (
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
                        className={`mt-[2vmin] grid gap-[1.2vmin] ${
                          isUpgradable ? "grid-cols-3" : "grid-cols-1"
                        }`}
                      >
                        <button
                          onClick={() => sellPropertyEntirely(activeModal.id)}
                          className="rounded-[0.9vmin] border-[0.18vmin] border-red-500 bg-red-950/60 py-[1.2vmin] text-[1.1vmin] font-black uppercase text-red-100 shadow-[inset_0_0_1.4vmin_rgba(239,68,68,0.55),0_0_0.8vmin_rgba(239,68,68,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-red-400 hover:bg-red-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(239,68,68,0.85),0_0_1.6vmin_rgba(239,68,68,0.65)]"
                        >
                          Sell (+${sellRefund})
                        </button>
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
                  <button
                    onClick={() => buyProperty(activeModal)}
                    disabled={(currentPlayer?.money ?? 0) < (parsePrice(activeModal.price) || 0)}
                    className="mt-[2vmin] w-full rounded-[0.9vmin] border-[0.18vmin] border-green-500 bg-green-950/60 py-[1.4vmin] text-[1.3vmin] font-black uppercase text-green-100 shadow-[inset_0_0_1.4vmin_rgba(34,197,94,0.55),0_0_0.8vmin_rgba(34,197,94,0.35)] transition-all duration-200 hover:scale-[1.03] hover:border-green-400 hover:bg-green-600/70 hover:text-white hover:shadow-[inset_0_0_2vmin_rgba(34,197,94,0.85),0_0_1.6vmin_rgba(34,197,94,0.65)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100"
                  >
                    Buy for {activeModal.price}
                  </button>
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
                    className={`rounded-[1vmin] border py-[1.8vmin] text-[2.6vmin] font-black transition-all ${
                      selectedCardValue === value
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
      </div>

      {/* ================= RIGHT SIDEBAR - ALL PLAYERS & THEIR CARDS ================= */}
      <div className="flex h-[96vmin] w-full flex-1 flex-col self-start overflow-hidden rounded-[1.4vmin] border border-white/10 bg-[#0f0c16]/90 p-[1.1vmin] shadow-[0_0_2vmin_rgba(139,92,246,0.12)]">
        <h2 className="mb-[0.8vmin] px-[0.3vmin] text-[1.4vmin] font-black uppercase tracking-widest text-white">
          Players
        </h2>

        <div className="flex flex-col gap-[0.7vmin]">
          {players.map((player) => {
            const isSelected = selectedPlayerId === player.id;
            return (
              <button
                key={player.id}
                onClick={() => setSelectedPlayerId((prev) => (prev === player.id ? null : player.id))}
                className={`flex items-center justify-between rounded-[1vmin] border-[0.18vmin] px-[1.1vmin] py-[0.9vmin] text-left transition-all duration-200 ${
                  player.isBankrupt ? "opacity-40 grayscale" : ""
                } ${
                  isSelected && !player.isCurrentPlayer ? "ring-[0.14vmin] ring-white/40" : ""
                }`}
                style={{
                  // Whoever's turn it is gets highlighted in THEIR OWN
                  // color - a red player lights up red, a yellow player
                  // lights up yellow, etc. - regardless of selection.
                  borderColor: player.isCurrentPlayer ? `${player.color}cc` : "rgba(255,255,255,0.1)",
                  backgroundColor: player.isCurrentPlayer ? `${player.color}2e` : "rgba(255,255,255,0.04)",
                  boxShadow: player.isCurrentPlayer
                    ? `0 0 1.6vmin ${player.color}88, inset 0 0 0.7vmin ${player.color}33`
                    : undefined,
                }}
              >
                <div className="flex items-center gap-[0.8vmin]">
                  {renderPlayerFace(player, "3.6vmin")}
                  <div className="flex flex-col leading-tight">
                    <span className={`text-[1.25vmin] font-bold ${player.isCurrentPlayer ? "text-white" : "text-gray-300"}`}>
                      {player.name}
                    </span>
                    {(player.isBankrupt || player.inJail) && (
                      <span className={`text-[0.9vmin] ${player.isBankrupt ? "text-red-400" : "text-amber-400"}`}>
                        {player.isBankrupt ? "BANKRUPT" : "🔒 JAIL"}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={`text-[1.35vmin] font-black tracking-tight ${
                    player.isCurrentPlayer ? "text-emerald-300" : "text-emerald-400"
                  }`}
                >
                  ${player.money.toLocaleString()}
                </span>
              </button>
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
                      ? `Highlighting ${selectedPlayer.name}'s ${ownedCount} propert${ownedCount === 1 ? "y" : "ies"} on the board`
                      : `${selectedPlayer.name} doesn't own any properties yet`}
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
      </div>
      </div>
    </main>
  );
}