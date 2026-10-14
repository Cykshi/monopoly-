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
    return {
      canRoll,
      canEndTurn: false,
      showRollButton: true,
      showEndTurnButton: false,
      showWaitingState: false,
      badgeText: gamePhase,
      waitingText: "",
    };
  }

  // ACTION or END TURN phase
  const canEndTurn = !hasWinner && (gamePhase === "ACTION" || gamePhase === "END TURN");
  return {
    canRoll: false,
    canEndTurn,
    showRollButton: false,
    showEndTurnButton: true,
    showWaitingState: false,
    badgeText: gamePhase,
    waitingText: "",
  };
}
