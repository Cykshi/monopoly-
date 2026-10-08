// ================= AUTHORITATIVE CARD ENGINE =================
//
// Single source of truth for Chance/Community Chest (Treasure/Surprise) cards:
//   1. Card drawing: Server rolls D6 / picks card; never trust client.
//   2. Rewards and penalties: Server-computed bank payouts, tax deductions, dividends.
//   3. Movement and landing: Server-computed destinations (airport jump, 8-tile jump,
//      jail jump, swap) routed through authoritative movement and landing checks.
//   4. State changes: Server updates player positions, money, and room state.

const board = require('./board');

// Card definitions matching the rules:
// Treasure Chest (Community Chest):
//   1-2: Collect $100 from bank
//   3-4: Collect $200 + free Movement Card
//   5:   Advance to nearest Airport
//   6:   Pay $150 luxury tax
const TREASURE_CARDS = {
  1: { id: 'treasure-1', title: 'Treasure Chest', description: 'Collect $100 from the bank.', money: 100, grantSkillCard: false, movementType: 'none' },
  2: { id: 'treasure-2', title: 'Treasure Chest', description: 'Collect $100 from the bank.', money: 100, grantSkillCard: false, movementType: 'none' },
  3: { id: 'treasure-3', title: 'Treasure Chest', description: 'Collect $200 and a free Movement Card.', money: 200, grantSkillCard: true, movementType: 'none' },
  4: { id: 'treasure-4', title: 'Treasure Chest', description: 'Collect $200 and a free Movement Card.', money: 200, grantSkillCard: true, movementType: 'none' },
  5: { id: 'treasure-5', title: 'Treasure Chest', description: 'Advances to the nearest Airport.', money: 0, grantSkillCard: false, movementType: 'nearest_airport' },
  6: { id: 'treasure-6', title: 'Treasure Chest', description: 'Pays $150 luxury tax.', money: -150, grantSkillCard: false, movementType: 'none' },
};

// Surprise Card (Chance):
//   1-2: Go directly to JAIL (tile 10)
//   3-4: Jump forward 8 spaces
//   5:   Receive $250 dividend
//   6:   Swap position with any player
const SURPRISE_CARDS = {
  1: { id: 'surprise-1', title: 'Surprise Card', description: 'Sent straight to JAIL.', money: 0, grantSkillCard: false, movementType: 'jail' },
  2: { id: 'surprise-2', title: 'Surprise Card', description: 'Sent straight to JAIL.', money: 0, grantSkillCard: false, movementType: 'jail' },
  3: { id: 'surprise-3', title: 'Surprise Card', description: 'Jumps forward 8 spaces.', money: 0, grantSkillCard: false, movementType: 'forward_8' },
  4: { id: 'surprise-4', title: 'Surprise Card', description: 'Jumps forward 8 spaces.', money: 0, grantSkillCard: false, movementType: 'forward_8' },
  5: { id: 'surprise-5', title: 'Surprise Card', description: 'Receives a $250 dividend.', money: 250, grantSkillCard: false, movementType: 'none' },
  6: { id: 'surprise-6', title: 'Surprise Card', description: 'Swap position with any player.', money: 0, grantSkillCard: false, movementType: 'swap' },
};

function rollD6() {
  return Math.floor(Math.random() * 6) + 1;
}

function findNearestTileIndex(fromPos, type) {
  for (let offset = 1; offset <= board.BOARD_SIZE; offset++) {
    const idx = (fromPos + offset) % board.BOARD_SIZE;
    const tile = board.getTile(idx);
    if (tile && tile.type === type) return idx;
  }
  return fromPos;
}

function isCardTile(tileId) {
  const tile = board.getTile(tileId);
  return !!tile && tile.type === 'card';
}

function getCardTileType(tileId) {
  const tile = board.getTile(tileId);
  if (!tile || tile.type !== 'card') return null;
  return tile.name === 'TREASURE' ? 'treasure' : 'surprise';
}

function getCardDefinition(kind, roll) {
  if (kind === 'treasure') return TREASURE_CARDS[roll] || TREASURE_CARDS[1];
  if (kind === 'surprise') return SURPRISE_CARDS[roll] || SURPRISE_CARDS[1];
  return null;
}

function resolveCardDraw(room, player, options = {}) {
  const fromPosition = Number.isInteger(player.position) ? player.position : 0;
  const kind = getCardTileType(fromPosition);
  if (!kind) {
    return { ok: false, code: 'NOT_ON_CARD_TILE', error: `Player is on tile ${fromPosition}, not on a card tile.` };
  }

  // Server determines the roll (1-6)
  const roll = (Number.isInteger(options.forcedRoll) && options.forcedRoll >= 1 && options.forcedRoll <= 6)
    ? options.forcedRoll
    : rollD6();

  const card = getCardDefinition(kind, roll);
  if (!card) {
    return { ok: false, code: 'CARD_NOT_FOUND', error: 'Card definition not found.' };
  }

  let newPosition = fromPosition;
  let passedGo = false;
  let salary = 0;
  let swap = null;

  // Execute movement
  if (card.movementType === 'nearest_airport') {
    const targetIdx = findNearestTileIndex(fromPosition, 'airport');
    let steps = targetIdx - fromPosition;
    if (steps <= 0) steps += board.BOARD_SIZE;
    const raw = fromPosition + steps;
    if (raw >= board.BOARD_SIZE) {
      passedGo = true;
      salary = board.PASS_START_BONUS;
    }
    newPosition = targetIdx;
  } else if (card.movementType === 'forward_8') {
    const steps = 8;
    const raw = fromPosition + steps;
    if (raw >= board.BOARD_SIZE) {
      passedGo = true;
      salary = board.PASS_START_BONUS;
    }
    newPosition = ((raw % board.BOARD_SIZE) + board.BOARD_SIZE) % board.BOARD_SIZE;
  } else if (card.movementType === 'jail') {
    newPosition = 10;
    // Straight to JAIL does not pass GO
    passedGo = false;
    salary = 0;
    player.inJail = true;
    player.jailTurns = 0;
  } else if (card.movementType === 'swap') {
    const others = (room && Array.isArray(room.players))
      ? room.players.filter((p) => p.id !== player.id && !p.isBankrupt)
      : [];
    if (others.length > 0) {
      let target = null;
      if (options.targetId !== undefined && options.targetId !== null) {
        target = others.find((p) => p.id === options.targetId) || null;
      }
      if (!target) {
        target = others[Math.floor(Math.random() * others.length)];
      }
      if (target) {
        const targetOldPos = Number.isInteger(target.position) ? target.position : 0;
        swap = {
          targetId: target.id,
          targetName: target.name,
          targetPosition: fromPosition,
          targetOldPosition: targetOldPos,
        };
        target.position = fromPosition;
        newPosition = targetOldPos;
      }
    }
  }

  player.position = newPosition;

  // Rewards and penalties
  const curMoney = Number.isFinite(player.money) ? player.money : 0;
  const cardMoney = card.money || 0;
  let finalMoney = curMoney;

  if (cardMoney < 0) {
    const penalty = Math.abs(cardMoney);
    const paid = Math.min(penalty, Math.max(0, curMoney));
    finalMoney = Math.max(0, curMoney - paid);
  } else if (cardMoney > 0) {
    finalMoney = curMoney + cardMoney;
  }

  if (salary > 0) {
    finalMoney += salary;
  }

  player.money = finalMoney;

  return {
    ok: true,
    kind,
    roll,
    card: {
      id: card.id,
      title: card.title,
      description: card.description,
      money: card.money,
      grantSkillCard: card.grantSkillCard,
      movementType: card.movementType,
    },
    playerId: player.id,
    fromPosition,
    position: player.position,
    money: player.money,
    cardMoneyDelta: card.money,
    passedGo,
    salary,
    grantSkillCard: !!card.grantSkillCard,
    swap,
    inJail: typeof player.inJail === 'boolean' ? player.inJail : false,
    jailTurns: Number.isInteger(player.jailTurns) ? player.jailTurns : 0,
  };
}

module.exports = {
  TREASURE_CARDS,
  SURPRISE_CARDS,
  rollD6,
  findNearestTileIndex,
  isCardTile,
  getCardTileType,
  getCardDefinition,
  resolveCardDraw,
};
