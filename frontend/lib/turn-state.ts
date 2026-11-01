// ================= TURN SYNCHRONIZATION HELPERS =================
// Pure functions for authoritative multiplayer turn permissions and UI state.
// Decoupled from React and Socket.io so turn gating can be unit-tested headlessly.

export function computeIsMyTurn(
  roomId: string | null,
  myPlayerId: number | null,
  currentTurnPlayerId: number | null | undefined
): boolean {
  if (!roomId || myPlayerId === null || currentTurnPlayerId === null || currentTurnPlayerId === undefined) {
    return false;
  }
  return myPlayerId === currentTurnPlayerId;
}

export interface TurnControlsParams {
  isMyTurn: boolean;
  gamePhase: "YOUR TURN" | "ROLLING..." | "MOVING..." | "ACTION" | "END TURN";
  isRolling: boolean;
  isMoving: boolean;
  currentPlayerName?: string | null;
  currentPlayerId?: number | null;
  hasWinner?: boolean;
  hasExtraTurn?: boolean;
  consecutiveDoubles?: number;
}

export interface TurnControlsResult {
  canRoll: boolean;
  canEndTurn: boolean;
  showRollButton: boolean;
  showEndTurnButton: boolean;
  showWaitingState: boolean;
  badgeText: string;
  waitingText: string;
}

export function computeTurnControls(params: TurnControlsParams): TurnControlsResult {
  const {
    isMyTurn,
    gamePhase,
    isRolling,
    isMoving,
    currentPlayerName,
    currentPlayerId,
    hasWinner = false,
    hasExtraTurn = false,
    consecutiveDoubles = 0,
  } = params;

  if (!isMyTurn) {
    const targetName = currentPlayerName?.trim() || (currentPlayerId ? `Player ${currentPlayerId}` : "Player");
    const badgeName = currentPlayerName?.trim() ? currentPlayerName.trim().toUpperCase() : (currentPlayerId ? `PLAYER ${currentPlayerId}` : "PLAYER");

    const waitingText = isRolling
      ? "🎲 Rolling..."
      : isMoving
        ? "🚶 Moving..."
        : `⏳ Waiting for ${targetName}...`;

    const badgeText = isRolling
      ? "ROLLING..."
      : isMoving
        ? "MOVING..."
        : `WAITING FOR ${badgeName}`;

    return {
      canRoll: false,
      canEndTurn: false,
      showRollButton: false,
      showEndTurnButton: false,
      showWaitingState: true,
      badgeText,
      waitingText,
    };
  }

  // Active player's turn
  if (gamePhase === "YOUR TURN" || gamePhase === "ROLLING..." || gamePhase === "MOVING...") {
    const canRoll = !isRolling && !isMoving && !hasWinner && gamePhase === "YOUR TURN";
    const badgeText = (consecutiveDoubles > 0 && gamePhase === "YOUR TURN")
      ? `DOUBLES x${consecutiveDoubles}! ROLL AGAIN`
      : gamePhase;
    return {
      canRoll,
      canEndTurn: false,
      showRollButton: true,
      showEndTurnButton: false,
      showWaitingState: false,
      badgeText,
      waitingText: "",
    };
  }

  // ACTION or END TURN phase
  const canRollAgain = !hasWinner && !isRolling && !isMoving && hasExtraTurn;
  const canEndTurn = !hasWinner && (gamePhase === "ACTION" || gamePhase === "END TURN");
  const badgeText = canRollAgain
    ? (consecutiveDoubles > 0 ? `DOUBLES x${consecutiveDoubles}! ROLL AGAIN` : "DOUBLES! ROLL AGAIN")
    : gamePhase;

  return {
    canRoll: canRollAgain,
    canEndTurn,
    showRollButton: canRollAgain,
    showEndTurnButton: !canRollAgain,
    showWaitingState: false,
    badgeText,
    waitingText: "",
  };
}
