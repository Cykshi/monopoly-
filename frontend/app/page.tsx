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
}

const BOARD_TILES: Tile[] = [
  { id: 0, name: "START", type: "corner", icon: "🏁" },
  { id: 1, name: "Dhaka", type: "bangladesh", countryCode: "BD", price: "$60", rent: 10, rents: [10, 30, 90, 270, 400, 550], houseCost: 50, hotelCost: 50 },
  { id: 2, name: "Normandy", type: "france", countryCode: "FR", price: "$100", rent: 20, rents: [20, 60, 180, 500, 700, 900], houseCost: 50, hotelCost: 50 },
  { id: 3, name: "TREASURE", type: "card", icon: "🎁" },
  { id: 4, name: "Bihar", type: "india", countryCode: "IN", price: "$140", rent: 30, rents: [30, 90, 270, 750, 925, 1100], houseCost: 100, hotelCost: 100 },
  { id: 5, name: "AIRPORT 1", type: "airport", icon: "✈️", price: "$200" },
  { id: 6, name: "Guangdong", type: "china", countryCode: "CN", price: "$180", rent: 40, rents: [40, 100, 300, 750, 925, 1100], houseCost: 100, hotelCost: 100 },
  { id: 7, name: "TAX", type: "tax", icon: "📉", price: "-$100" },
  { id: 8, name: "California", type: "america", countryCode: "US", price: "$220", rent: 50, rents: [50, 150, 450, 1000, 1200, 1400], houseCost: 150, hotelCost: 150 },
  { id: 9, name: "SOLAR", type: "electricity", icon: "☀️", price: "$150" },
  { id: 10, name: "JAIL", type: "corner", icon: "🔒" },
  { id: 11, name: "Scotland", type: "uk", countryCode: "GB", price: "$260", rent: 60, rents: [60, 180, 500, 1100, 1300, 1500], houseCost: 150, hotelCost: 150 },
  { id: 12, name: "Sindh", type: "pakistan", countryCode: "PK", price: "$260", rent: 60, rents: [60, 180, 500, 1100, 1300, 1500], houseCost: 150, hotelCost: 150 },
  { id: 13, name: "Osaka", type: "japan", countryCode: "JP", price: "$280", rent: 70, rents: [70, 200, 550, 1200, 1400, 1600], houseCost: 150, hotelCost: 150 },
  { id: 14, name: "SURPRISE", type: "card", icon: "❓" },
  { id: 15, name: "AIRPORT 2", type: "airport", icon: "✈️", price: "$200" },
  { id: 16, name: "UP", type: "india", countryCode: "IN", price: "$300", rent: 80, rents: [80, 220, 600, 1400, 1700, 2000], houseCost: 200, hotelCost: 200 },
  { id: 17, name: "Provence", type: "france", countryCode: "FR", price: "$300", rent: 80, rents: [80, 220, 600, 1400, 1700, 2000], houseCost: 200, hotelCost: 200 },
  { id: 18, name: "FIBER", type: "internet", icon: "🌐", price: "$150" },
  { id: 19, name: "Texas", type: "america", countryCode: "US", price: "$320", rent: 90, rents: [90, 250, 700, 1500, 1850, 2100], houseCost: 200, hotelCost: 200 },
  { id: 20, name: "REST HOUSE", type: "corner", icon: "🏨" },
  { id: 21, name: "Shanghai", type: "china", countryCode: "CN", price: "$350", rent: 100, rents: [100, 300, 750, 1700, 2000, 2300], houseCost: 200, hotelCost: 200 },
  { id: 22, name: "Wales", type: "uk", countryCode: "GB", price: "$350", rent: 100, rents: [100, 300, 750, 1700, 2000, 2300], houseCost: 200, hotelCost: 200 },
  { id: 23, name: "WIND", type: "electricity", icon: "🌪️", price: "$150" },
  { id: 24, name: "FIXED TAX", type: "tax", icon: "💰", price: "-$200" },
  { id: 25, name: "AIRPORT 3", type: "airport", icon: "✈️", price: "$200" },
  { id: 26, name: "Chittagong", type: "bangladesh", countryCode: "BD", price: "$380", rent: 120, rents: [120, 360, 850, 2000, 2200, 2400], houseCost: 200, hotelCost: 200 },
  { id: 27, name: "Île-de-France", type: "france", countryCode: "FR", price: "$400", rent: 130, rents: [130, 390, 900, 2000, 2400, 2800], houseCost: 200, hotelCost: 200 },
  { id: 28, name: "SURPRISE", type: "card", icon: "❓" },
  { id: 29, name: "MP", type: "india", countryCode: "IN", price: "$400", rent: 140, rents: [140, 400, 900, 2000, 2400, 2800], houseCost: 200, hotelCost: 200 },
  { id: 30, name: "CLUB", type: "corner", icon: "🥂" },
  { id: 31, name: "Tokyo", type: "japan", countryCode: "JP", price: "$420", rent: 150, rents: [150, 450, 1000, 2200, 2600, 3000], houseCost: 300, hotelCost: 300 },
  { id: 32, name: "New York", type: "america", countryCode: "US", price: "$420", rent: 160, rents: [160, 450, 1000, 2200, 2600, 3000], houseCost: 300, hotelCost: 300 },
  { id: 33, name: "Punjab", type: "pakistan", countryCode: "PK", price: "$450", rent: 170, rents: [170, 500, 1100, 2400, 2800, 3200], houseCost: 300, hotelCost: 300 },
  { id: 34, name: "TAX", type: "tax", icon: "📉", price: "-$250" },
  { id: 35, name: "AIRPORT 4", type: "airport", icon: "✈️", price: "$200" },
  { id: 36, name: "England", type: "uk", countryCode: "GB", price: "$480", rent: 180, rents: [180, 500, 1200, 2500, 3000, 3500], houseCost: 300, hotelCost: 300 },
  { id: 37, name: "NUCLEAR", type: "electricity", icon: "☢️", price: "$150" },
  { id: 38, name: "5G NET", type: "internet", icon: "📡", price: "$150" },
  { id: 39, name: "Beijing", type: "china", countryCode: "CN", price: "$500", rent: 200, rents: [200, 600, 1400, 3000, 3500, 4000], houseCost: 300, hotelCost: 300 },
];

const INITIAL_PLAYERS: Player[] = [
  { id: 1, name: "You", color: "#8b5cf6", money: 2400, position: 0, isCurrentPlayer: true },
  { id: 2, name: "Alex", color: "#22c55e", money: 2100, position: 0 },
  { id: 3, name: "Sam", color: "#ef4444", money: 1950, position: 0 },
  { id: 4, name: "Jordan", color: "#f59e0b", money: 2250, position: 0 },
];

const INITIAL_HOUSES: Record<number, number> = { 1: 2, 4: 3, 17: 1, 26: 0, 29: 2 };
const PROPERTY_OWNERSHIP: Record<number, number> = { 1: 1, 4: 1, 17: 2, 26: 3, 29: 4 };

const PROPERTY_TYPES = new Set(["bangladesh", "france", "india", "china", "america", "uk", "pakistan", "japan"]);
const BOARD_SIZE = BOARD_TILES.length;
const PASS_START_BONUS = 200;

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

export default function GameBoard() {
  const socketRef = useRef<Socket | null>(null);
  const rollIntervalRef = useRef<number | null>(null);
  const moveTimeoutRef = useRef<number | null>(null);
  const pendingRollRef = useRef<[number, number] | null>(null);

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

  const currentPlayer = useMemo(() => players.find((p) => p.isCurrentPlayer), [players]);
  const playersRef = useRef(players);
  playersRef.current = players;

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

    newSocket.on("player:moved", (data: any) => {
      setPlayers((prev) => prev.map((p) => (p.id === data.playerId ? { ...p, position: data.position, money: data.money } : p)));
    });
    newSocket.on("property:bought", (data: any) => {
      setPropertyOwnership((prev) => ({ ...prev, [data.tileId]: data.playerId }));
    });
    newSocket.on("house:upgraded", (data: any) => {
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
      if (rollIntervalRef.current) window.clearInterval(rollIntervalRef.current);
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
    setActionLog((prev) => [msg, ...prev].slice(0, 8));
  };

  const animateMovement = (steps: number) => {
    const player = playersRef.current.find((p) => p.isCurrentPlayer);
    if (!player) return;

    setIsMoving(true);
    setGamePhase("MOVING...");

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

      if (currentPos === 0) setHasSkillCard(true);

      setPlayers((prev) =>
        prev.map((p) =>
          p.id === player.id
            ? { ...p, position: currentPos, money: p.money + (currentPos === 0 ? PASS_START_BONUS : 0) }
            : p
        )
      );

      moveTimeoutRef.current = window.setTimeout(step, 260);
    };

    step();
  };

  const handleLanding = (tile: Tile, playerId: number) => {
    const player = playersRef.current.find((p) => p.id === playerId);
    if (!player) return;

    if (tile.type === "tax") {
      const amount = Math.abs(parsePrice(tile.price) || 0);
      setPlayers((prev) =>
        prev.map((p) => (p.id === playerId ? { ...p, money: Math.max(0, p.money - amount) } : p))
      );
      addLog(`${player.name} paid $${amount} tax.`);
      return;
    }

    if (PROPERTY_TYPES.has(tile.type)) {
      const ownerId = propertyOwnership[tile.id];
      if (ownerId && ownerId !== playerId) {
        const houses = propertyHouses[tile.id] || 0;
        const rent = calculateRent(tile, houses);
        const owner = playersRef.current.find((p) => p.id === ownerId);

        setPlayers((prev) =>
          prev.map((p) => {
            if (p.id === playerId) return { ...p, money: Math.max(0, p.money - rent) };
            if (p.id === ownerId) return { ...p, money: p.money + rent };
            return p;
          })
        );
        addLog(`${player.name} paid $${rent} rent to ${owner?.name} on ${tile.name}.`);
      } else if (!ownerId) {
        setActiveModal(tile);
      }
    }

    if (tile.type === "card") {
      addLog(`${player.name} landed on ${tile.name}.`);
    }
  };

  const rollDice = () => {
    if (isRolling || isMoving || gamePhase !== "YOUR TURN") return;

    // One immutable result per roll. The log, dice and movement all use these exact values.
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

    setIsRolling(false);
    addLog(`Rolled ${total} (${first} + ${second})`);
    socketRef.current?.emit("player:rolled", { dice: [first, second], total });

    // The piece starts moving only after the final die face is visible.
    animateMovement(total);
  };

  const openSkillCard = () => {
    if (!hasSkillCard || isRolling || isMoving || gamePhase !== "YOUR TURN") return;
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
    if (gamePhase !== "ACTION" && gamePhase !== "END TURN") return;

    setPlayers((prev) => {
      const currentIdx = prev.findIndex((p) => p.isCurrentPlayer);
      const nextIdx = (currentIdx + 1) % prev.length;
      return prev.map((p, i) => ({ ...p, isCurrentPlayer: i === nextIdx }));
    });

    setGamePhase("YOUR TURN");
    addLog("Turn ended.");
  };

  const buyProperty = (tile: Tile) => {
    if (!currentPlayer || !PROPERTY_TYPES.has(tile.type) || propertyOwnership[tile.id]) return;
    const cost = parsePrice(tile.price);
    if (cost === null || cost <= 0 || currentPlayer.money < cost) return;

    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, money: p.money - cost } : p))
    );
    setPropertyOwnership((prev) => ({ ...prev, [tile.id]: currentPlayer.id }));
    addLog(`${currentPlayer.name} bought ${tile.name} for ${tile.price}`);
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

  const downgradeHouse = (tileId: number) => {
    if (!currentPlayer) return;
    const tile = BOARD_TILES.find((t) => t.id === tileId);
    if (!tile || propertyOwnership[tileId] !== currentPlayer.id) return;

    const currentHouses = propertyHouses[tileId] || 0;
    if (currentHouses <= 0) return;

    const refund = Math.floor((tile.houseCost || 100) / 2);
    setPropertyHouses((prev) => ({ ...prev, [tileId]: currentHouses - 1 }));
    setPlayers((prev) =>
      prev.map((p) => (p.id === currentPlayer.id ? { ...p, money: p.money + refund } : p))
    );
    addLog(`${currentPlayer.name} sold a house on ${tile.name}`);
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

  return (
    <main className="flex h-screen w-screen items-center justify-center overflow-hidden bg-[#050508] bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-[#110d1c] to-[#050508] p-[1.5vmin] font-sans">
      <div
        className="relative grid aspect-square h-[96vmin] w-[96vmin] rounded-[2vmin] border border-white/10 bg-[#0f0c16] p-[0.5vmin] shadow-[0_0_5vmin_rgba(139,92,246,0.15)]"
        style={{
          gridTemplateColumns: "repeat(11, 1fr)",
          gridTemplateRows: "repeat(11, 1fr)",
          gap: "0.35vmin",
        }}
      >
        {/* BOARD TILES */}
        {BOARD_TILES.map((tile, i) => {
          const { gridRow, gridColumn, orientation } = getTilePosition(i);
          const isCorner = [0, 10, 20, 30].includes(i);
          const isProperty = PROPERTY_TYPES.has(tile.type);
          const owner = isProperty ? getTileOwner(tile.id) : undefined;
          const houses = propertyHouses[tile.id] || 0;
          const playersHere = players.filter((p) => p.position === tile.id);

          const ownerStripClass =
            orientation === "top"
              ? "absolute left-0 right-0 top-0 z-30 h-[0.55vmin]"
              : orientation === "left"
              ? "absolute bottom-0 left-0 top-0 z-30 w-[0.55vmin]"
              : orientation === "right"
              ? "absolute bottom-0 right-0 top-0 z-30 w-[0.55vmin]"
              : "absolute bottom-0 left-0 right-0 z-30 h-[0.55vmin]";

          let innerRotation = "";
          let counterRotation = "";
          if (orientation === "left") {
            innerRotation = "rotate-90";
            counterRotation = "-rotate-90";
          } else if (orientation === "top") {
            innerRotation = "rotate-180";
            counterRotation = "-rotate-180";
          } else if (orientation === "right") {
            innerRotation = "-rotate-90";
            counterRotation = "rotate-90";
          }

          const ownedBackground = owner ? getTransparentColor(owner.color, "25") : undefined;
          const ownedBorder = owner ? getTransparentColor(owner.color, "90") : undefined;

          return (
            <div
              key={tile.id}
              onClick={() => handleTileClick(tile)}
              className={`relative flex cursor-pointer items-center justify-center rounded-[0.9vmin] shadow-lg transition-all duration-200 hover:z-30 hover:scale-[1.04] ${
                owner ? "shadow-[0_0_1.5vmin_rgba(255,255,255,0.08)]" : "hover:shadow-[0_0_2vmin_rgba(255,255,255,0.35)]"
              } ${
                isCorner
                  ? "overflow-hidden border-[0.25vmin] border-indigo-400/60 bg-gradient-to-br from-[#1e143c] to-[#120b24]"
                  : "border border-[#34404d] bg-[#171e26]/80"
              }`}
              style={{
                gridRow,
                gridColumn,
                ...(owner ? { backgroundColor: ownedBackground, borderColor: ownedBorder } : {}),
              }}
            >
              {!isCorner && tile.countryCode && (
                <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[0.9vmin]">
                  <div className="absolute inset-0 flex scale-150 items-center justify-center opacity-[0.07] mix-blend-screen">
                    <Flag code={tile.countryCode} className="h-full w-full object-cover grayscale" />
                  </div>
                </div>
              )}

              {owner && (
                <div
                  className={ownerStripClass}
                  style={{ backgroundColor: owner.color, boxShadow: `0 0 0.8vmin ${owner.color}` }}
                />
              )}

              {playersHere.length > 0 && (
                <div
                  className={`absolute z-50 flex max-w-[95%] flex-wrap gap-[0.3vmin] ${
                    orientation === "top" ? "bottom-[0.35vmin]" : "top-[0.35vmin]"
                  } left-[0.35vmin]`}
                >
                  {playersHere.map((player) => (
                    <div
                      key={player.id}
                      title={player.name}
                      className={`relative flex h-[2.6vmin] w-[2.6vmin] items-center justify-center rounded-full border-[0.25vmin] border-white shadow-[0_0.4vmin_1.2vmin_rgba(0,0,0,0.7)] transition-all duration-300 ${
                        player.isCurrentPlayer ? "scale-125 ring-2 ring-white/80 z-10" : "hover:scale-110"
                      }`}
                      style={{
                        backgroundColor: player.color,
                        boxShadow: `0 0 1.2vmin ${player.color}99, 0 0.4vmin 1vmin rgba(0,0,0,0.6)`,
                      }}
                    >
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <div className="flex gap-[0.35vmin] mt-[0.15vmin]">
                          <div className="h-[0.45vmin] w-[0.45vmin] rounded-full bg-white" />
                          <div className="h-[0.45vmin] w-[0.45vmin] rounded-full bg-white" />
                        </div>
                        <div className="mt-[0.15vmin] h-[0.25vmin] w-[0.9vmin] rounded-full bg-white/90" />
                      </div>
                      <span className="absolute -bottom-[0.15vmin] text-[0.55vmin] font-black text-white/90 drop-shadow">
                        {player.name.slice(0, 1)}
                      </span>
                    </div>
                  ))}
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
                <div className={`relative z-10 flex h-full w-full flex-col items-center justify-between p-[0.6vmin] ${innerRotation}`}>
                  {owner && (
                    <div className="absolute right-[0.2vmin] top-[0.2vmin] z-40 flex items-center">
                      <div
                        className="flex items-center gap-[0.15vmin] rounded-[0.4vmin] border px-[0.35vmin] py-[0.1vmin] shadow-lg backdrop-blur-sm"
                        style={{
                          backgroundColor: `${owner.color}45`,
                          borderColor: `${owner.color}99`,
                        }}
                      >
                        <span className="text-[1vmin]">{houses === 5 ? "🏨" : "🏠"}</span>
                        <span className="text-[0.9vmin] font-black" style={{ color: owner.color }}>
                          {houses}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="absolute left-1/2 top-0 z-30 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center">
                    {tile.countryCode ? (
                      <div className={`h-[2.4vmin] w-[3.5vmin] overflow-hidden rounded-[0.2vmin] border-[0.15vmin] border-white/80 shadow-md ${counterRotation}`}>
                        <Flag code={tile.countryCode} className="h-full w-full object-cover" />
                      </div>
                    ) : (
                      <span className={`text-[2.4vmin] drop-shadow-xl ${counterRotation}`}>{tile.icon}</span>
                    )}
                  </div>

                  <div className="h-[18%] w-full" />

                  <div className="flex w-full flex-1 flex-col items-center justify-center text-center">
                    <span className="max-w-full break-words text-[1vmin] font-bold uppercase leading-tight tracking-wide text-gray-100">
                      {tile.name}
                    </span>
                    {owner && (
                      <span className="mt-[0.2vmin] max-w-full truncate text-[0.7vmin] font-bold uppercase" style={{ color: owner.color }}>
                        {owner.name}
                      </span>
                    )}
                  </div>

                  {!owner && tile.price ? (
                    <div
                      className={`w-[95%] rounded-[0.35vmin] py-[0.15vmin] text-center text-[0.85vmin] font-bold ${
                        tile.price.includes("-")
                          ? "bg-red-500/80 text-white"
                          : "border border-[#526171] bg-[#293541] text-[#d9e3ec]"
                      }`}
                    >
                      {tile.price}
                    </div>
                  ) : owner ? (
                    <div
                      className="w-[95%] rounded-[0.3vmin] py-[0.15vmin] text-center text-[0.7vmin] font-black uppercase tracking-wide"
                      style={{ color: owner.color, backgroundColor: `${owner.color}18` }}
                    >
                      Owned
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}

        {/* ================= CENTER CONSOLE ================= */}
        <div
          className="relative z-0 flex flex-col items-center justify-between rounded-[1.8vmin] border border-white/5 bg-[#0a0812] p-[2vmin] text-center shadow-2xl"
          style={{ gridRow: "2 / 11", gridColumn: "2 / 11", margin: "1.8vmin" }}
        >
          {/* Top bar */}
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

          {/* Title + Phase */}
          <div>
            <h1 className="bg-gradient-to-br from-indigo-400 via-purple-400 to-white bg-clip-text text-[4.2vmin] font-black uppercase tracking-widest text-transparent">
              Finance Chess
            </h1>
            <div
              className={`mx-auto mt-[0.6vmin] w-fit rounded-full border px-[1.8vmin] py-[0.4vmin] text-[1.1vmin] font-black uppercase tracking-widest ${
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

          {/* 3D Dice - FIXED */}
          <div className="my-3 flex justify-center">
            <DiceScene dice={dice} rollTrigger={rollTrigger} onSettled={handleDiceSettled} />
          </div>

          {/* Action Log */}
          <div className="h-[7vmin] w-full max-w-[42vmin] overflow-hidden rounded-[1vmin] border border-white/5 bg-black/40 px-[1.5vmin] py-[0.8vmin] text-left">
            {actionLog.slice(0, 3).map((msg, i) => (
              <p key={i} className={`text-[1.15vmin] leading-snug ${i === 0 ? "text-gray-200" : "text-gray-500"}`}>
                {msg}
              </p>
            ))}
          </div>

          {/* Buttons */}
          <div className="flex w-full max-w-[44vmin] gap-[1.2vmin]">
            <button
              onClick={rollDice}
              disabled={isRolling || isMoving || gamePhase !== "YOUR TURN"}
              className="flex-1 rounded-[1.1vmin] border border-white/20 bg-gradient-to-r from-indigo-600 to-purple-600 py-[1.6vmin] text-[1.6vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isRolling ? "Rolling..." : "🎲 Roll Dice"}
            </button>

            <button
              onClick={openSkillCard}
              disabled={!hasSkillCard || isRolling || isMoving || gamePhase !== "YOUR TURN"}
              className="relative flex-1 rounded-[1.1vmin] border border-white/20 bg-gradient-to-r from-emerald-600 to-teal-600 py-[1.6vmin] text-[1.6vmin] font-black uppercase text-white shadow-lg transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {hasSkillCard ? "🃏 Card" : "Exhausted"}
              {hasSkillCard && (
                <span className="absolute -right-[0.6vmin] -top-[0.6vmin] flex h-[2vmin] min-w-[2vmin] items-center justify-center rounded-full bg-yellow-400 text-[0.9vmin] font-black text-black">
                  1
                </span>
              )}
            </button>

            <button
              onClick={endTurn}
              disabled={gamePhase !== "ACTION" && gamePhase !== "END TURN"}
              className="rounded-[1.1vmin] border border-white/15 bg-white/10 px-[2vmin] py-[1.6vmin] text-[1.4vmin] font-bold uppercase text-gray-300 transition hover:bg-white/20 disabled:opacity-30"
            >
              End Turn
            </button>
          </div>

          {/* Player strip */}
          <div className="flex gap-[0.8vmin]">
            {players.map((player) => (
              <div
                key={player.id}
                className={`flex items-center gap-[0.5vmin] rounded-full border px-[1vmin] py-[0.4vmin] ${
                  player.isCurrentPlayer ? "border-white/40 bg-white/15" : "border-white/5 bg-white/[0.03]"
                }`}
              >
                <span className="h-[0.9vmin] w-[0.9vmin] rounded-full" style={{ backgroundColor: player.color }} />
                <span className="text-[1vmin] font-bold text-gray-300">{player.name}</span>
                <span className="text-[0.9vmin] text-gray-500">${(player.money / 1000).toFixed(1)}k</span>
              </div>
            ))}
          </div>
        </div>

        {/* ================= PROPERTY MODAL ================= */}
        {activeModal && (
          <div
            className="absolute inset-0 z-[100] flex items-center justify-center rounded-[2vmin] bg-black/70 p-[4vmin] backdrop-blur-md"
            onClick={() => setActiveModal(null)}
          >
            <div
              className="relative w-[42vmin] overflow-hidden rounded-[1.8vmin] border bg-[#161224] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              style={{
                borderColor: getTileOwner(activeModal.id)
                  ? `${getTileOwner(activeModal.id)!.color}66`
                  : "rgba(255,255,255,0.08)",
              }}
            >
              <div className="bg-gradient-to-r from-indigo-900/80 to-purple-900/60 px-[2.5vmin] py-[1.8vmin] text-center">
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
                {PROPERTY_TYPES.has(activeModal.type) && activeModal.rents && (
                  <div className="mb-[2vmin] space-y-[0.7vmin] text-[1.35vmin]">
                    <div className="flex justify-between text-gray-400">
                      <span>with rent</span>
                      <span className="font-bold text-white">${activeModal.rents[0]}</span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>with one house</span>
                      <span className="font-bold text-white">${activeModal.rents[1]}</span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>with two houses</span>
                      <span className="font-bold text-white">${activeModal.rents[2]}</span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>with three houses</span>
                      <span className="font-bold text-white">${activeModal.rents[3]}</span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>with four houses</span>
                      <span className="font-bold text-white">${activeModal.rents[4]}</span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>with a hotel</span>
                      <span className="font-bold text-emerald-400">${activeModal.rents[5]}</span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-white/10 pt-[1.5vmin] text-[1.4vmin]">
                  <div className="text-center">
                    <div className="text-gray-500">Price</div>
                    <div className="font-black text-white">{activeModal.price}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-gray-500">🏠</div>
                    <div className="font-black text-white">${activeModal.houseCost ?? 100}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-gray-500">🏨</div>
                    <div className="font-black text-white">${activeModal.hotelCost ?? 100}</div>
                  </div>
                </div>

                {getTileOwner(activeModal.id)?.id === currentPlayer?.id && PROPERTY_TYPES.has(activeModal.type) && (
                  <div className="mt-[2vmin] grid grid-cols-2 gap-[1.2vmin]">
                    <button
                      onClick={() => upgradeHouse(activeModal.id)}
                      disabled={(propertyHouses[activeModal.id] || 0) >= 5}
                      className="rounded-[0.9vmin] bg-green-600 py-[1.2vmin] text-[1.2vmin] font-black uppercase text-white hover:bg-green-500 disabled:opacity-30"
                    >
                      {(propertyHouses[activeModal.id] || 0) === 4 ? "Buy Hotel" : "Build House"}
                    </button>
                    <button
                      onClick={() => downgradeHouse(activeModal.id)}
                      disabled={(propertyHouses[activeModal.id] || 0) <= 0}
                      className="rounded-[0.9vmin] bg-red-600/80 py-[1.2vmin] text-[1.2vmin] font-black uppercase text-white hover:bg-red-500 disabled:opacity-30"
                    >
                      Sell
                    </button>
                  </div>
                )}

                {!getTileOwner(activeModal.id) && PROPERTY_TYPES.has(activeModal.type) && (
                  <button
                    onClick={() => buyProperty(activeModal)}
                    disabled={(currentPlayer?.money ?? 0) < (parsePrice(activeModal.price) || 0)}
                    className="mt-[2vmin] w-full rounded-[0.9vmin] bg-gradient-to-r from-green-600 to-emerald-600 py-[1.4vmin] text-[1.3vmin] font-black uppercase text-white hover:scale-[1.02] disabled:opacity-30"
                  >
                    Buy for {activeModal.price}
                  </button>
                )}
              </div>

              <button
                onClick={() => setActiveModal(null)}
                className="absolute right-[1.4vmin] top-[1.4vmin] text-[2vmin] text-white/50 hover:text-white"
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
      </div>
    </main>
  );
}