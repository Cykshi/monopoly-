// ================= AUTHORITATIVE BOARD DATA =================
//
// This is the SERVER'S copy of the board, and it is the single source of truth
// for every money-moving decision: purchase prices, rent tables, house/hotel
// costs, tile types and groups.
//
// The frontend keeps a display-oriented copy in frontend/app/page.tsx (it has
// to — it renders the board, the rent tables and the tooltips). Nothing
// automatically proves the two agree: they must be edited together by hand.
// Keep the tile ids, prices, rent rows and house/hotel costs identical. If they
// drift, the server stays authoritative and the client merely DISPLAYS a wrong
// number — the money moved is always the server's.
//
// Rules encoded here (mirroring the client's display logic exactly):
//   - PROPERTY types have `rents[0..5]`: index = house count, 5 = hotel.
//   - UTILITY types have no houses; rent scales with how many of that SAME
//     type the owner holds, indexed by (owned - 1).
//   - `price` is the official purchase price in whole dollars.

const TILES = [
  { id: 0, name: 'START', type: 'corner', icon: '🏁' },
  { id: 1, name: 'Dhaka', type: 'bangladesh', countryCode: 'BD', price: 60, rents: [10, 30, 90, 270, 400, 550], houseCost: 50, hotelCost: 50 },
  { id: 2, name: 'Normandy', type: 'france', countryCode: 'FR', price: 100, rents: [20, 60, 180, 500, 700, 900], houseCost: 50, hotelCost: 50 },
  { id: 3, name: 'TREASURE', type: 'card', icon: '🎁' },
  { id: 4, name: 'Bihar', type: 'india', countryCode: 'IN', price: 140, rents: [30, 90, 270, 750, 925, 1100], houseCost: 100, hotelCost: 100 },
  { id: 5, name: 'AIRPORT 1', type: 'airport', icon: '✈️', price: 160 },
  { id: 6, name: 'Guangdong', type: 'china', countryCode: 'CN', price: 180, rents: [40, 100, 300, 750, 925, 1100], houseCost: 100, hotelCost: 100 },
  { id: 7, name: 'TAX', type: 'tax', icon: '📉', price: 100 },
  { id: 8, name: 'California', type: 'america', countryCode: 'US', price: 220, rents: [50, 150, 450, 1000, 1200, 1400], houseCost: 150, hotelCost: 150 },
  { id: 9, name: 'SOLAR', type: 'electricity', icon: '☀️', price: 240 },
  { id: 10, name: 'JAIL', type: 'corner', icon: '🔒' },
  { id: 11, name: 'Scotland', type: 'uk', countryCode: 'GB', price: 260, rents: [60, 180, 500, 1100, 1300, 1500], houseCost: 150, hotelCost: 150 },
  { id: 12, name: 'Sindh', type: 'pakistan', countryCode: 'PK', price: 260, rents: [60, 180, 500, 1100, 1300, 1500], houseCost: 150, hotelCost: 150 },
  { id: 13, name: 'Osaka', type: 'japan', countryCode: 'JP', price: 280, rents: [70, 200, 550, 1200, 1400, 1600], houseCost: 150, hotelCost: 150 },
  { id: 14, name: 'SURPRISE', type: 'card', icon: '❓' },
  { id: 15, name: 'AIRPORT 2', type: 'airport', icon: '✈️', price: 290 },
  { id: 16, name: 'UP', type: 'india', countryCode: 'IN', price: 300, rents: [80, 220, 600, 1400, 1700, 2000], houseCost: 200, hotelCost: 200 },
  { id: 17, name: 'Provence', type: 'france', countryCode: 'FR', price: 300, rents: [80, 220, 600, 1400, 1700, 2000], houseCost: 200, hotelCost: 200 },
  { id: 18, name: 'FIBER', type: 'internet', icon: '🌐', price: 310 },
  { id: 19, name: 'Texas', type: 'america', countryCode: 'US', price: 320, rents: [90, 250, 700, 1500, 1850, 2100], houseCost: 200, hotelCost: 200 },
  { id: 20, name: 'REST HOUSE', type: 'corner', icon: '🏨' },
  { id: 21, name: 'Shanghai', type: 'china', countryCode: 'CN', price: 350, rents: [100, 300, 750, 1700, 2000, 2300], houseCost: 200, hotelCost: 200 },
  { id: 22, name: 'Wales', type: 'uk', countryCode: 'GB', price: 350, rents: [100, 300, 750, 1700, 2000, 2300], houseCost: 200, hotelCost: 200 },
  { id: 23, name: 'WIND', type: 'electricity', icon: '🌪️', price: 360 },
  { id: 24, name: 'FIXED TAX', type: 'tax', icon: '💰', price: 200 },
  { id: 25, name: 'AIRPORT 3', type: 'airport', icon: '✈️', price: 370 },
  { id: 26, name: 'Chittagong', type: 'bangladesh', countryCode: 'BD', price: 380, rents: [120, 360, 850, 2000, 2200, 2400], houseCost: 200, hotelCost: 200 },
  { id: 27, name: 'France', type: 'france', countryCode: 'FR', price: 400, rents: [130, 390, 900, 2000, 2400, 2800], houseCost: 200, hotelCost: 200 },
  { id: 28, name: 'SURPRISE', type: 'card', icon: '❓' },
  { id: 29, name: 'MP', type: 'india', countryCode: 'IN', price: 400, rents: [140, 400, 900, 2000, 2400, 2800], houseCost: 200, hotelCost: 200 },
  { id: 30, name: 'CLUB', type: 'corner', icon: '🥂' },
  { id: 31, name: 'Tokyo', type: 'japan', countryCode: 'JP', price: 420, rents: [150, 450, 1000, 2200, 2600, 3000], houseCost: 300, hotelCost: 300 },
  { id: 32, name: 'New York', type: 'america', countryCode: 'US', price: 420, rents: [160, 450, 1000, 2200, 2600, 3000], houseCost: 300, hotelCost: 300 },
  { id: 33, name: 'Punjab', type: 'pakistan', countryCode: 'PK', price: 450, rents: [170, 500, 1100, 2400, 2800, 3200], houseCost: 300, hotelCost: 300 },
  { id: 34, name: 'TAX', type: 'tax', icon: '📉', price: 250 },
  { id: 35, name: 'AIRPORT 4', type: 'airport', icon: '✈️', price: 460 },
  { id: 36, name: 'England', type: 'uk', countryCode: 'GB', price: 480, rents: [180, 500, 1200, 2500, 3000, 3500], houseCost: 300, hotelCost: 300 },
  { id: 37, name: 'NUCLEAR', type: 'electricity', icon: '☢️', price: 490 },
  { id: 38, name: '5G NET', type: 'internet', icon: '📡', price: 495 },
  { id: 39, name: 'Beijing', type: 'china', countryCode: 'CN', price: 500, rents: [200, 600, 1400, 3000, 3500, 4000], houseCost: 300, hotelCost: 300 },
];

const BOARD_SIZE = TILES.length;

// A "property" in the Monopoly sense: buyable, buildable, rent from `rents`.
const PROPERTY_TYPES = new Set([
  'bangladesh', 'france', 'india', 'china', 'america', 'uk', 'pakistan', 'japan',
]);

// Utility-style tiles: buyable, no houses, rent scales with how many of the
// SAME type the owner holds (indexed by owned - 1).
const UTILITY_TYPES = new Set(['electricity', 'internet', 'airport']);

const OWNABLE_TYPES = new Set([...PROPERTY_TYPES, ...UTILITY_TYPES]);

const UTILITY_RENT_TABLE = {
  airport: [50, 100, 200, 400],
  electricity: [80, 200, 400],
  internet: [120, 300],
};

const MAX_HOUSES = 5; // 5 == hotel

// The economy constants the client also applies. Kept here so every money
// change the server makes uses one set of numbers.
const STARTING_MONEY = 1500;
const PASS_START_BONUS = 200;
const LAND_START_BONUS = 300;
const JAIL_BAIL_COST = 100;
const CLUB_FEE_PER_CARD = 50;
const CLUB_FEE_PER_HOUSE = 100;
const REST_HOUSE_TILE_ID = 20;
const CLUB_TILE_ID = 30;

// tileId -> tile, for O(1) lookups from event handlers.
const TILES_BY_ID = new Map(TILES.map((t) => [t.id, t]));

function getTile(tileId) {
  return TILES_BY_ID.get(tileId) || null;
}

// Is this a board index at all? Guards against ids off the board entirely.
function isValidTileId(tileId) {
  return Number.isInteger(tileId) && TILES_BY_ID.has(tileId);
}

function isOwnableTile(tileId) {
  const tile = getTile(tileId);
  return !!tile && OWNABLE_TYPES.has(tile.type);
}

function isPropertyTile(tileId) {
  const tile = getTile(tileId);
  return !!tile && PROPERTY_TYPES.has(tile.type);
}

function isUtilityTile(tileId) {
  const tile = getTile(tileId);
  return !!tile && UTILITY_TYPES.has(tile.type);
}

// The official purchase price, or null when the tile cannot be bought. This is
// the ONLY place a purchase price may come from.
function purchasePrice(tileId) {
  const tile = getTile(tileId);
  if (!tile || !OWNABLE_TYPES.has(tile.type)) return null;
  return Number.isFinite(tile.price) ? tile.price : null;
}

// Cost to build the NEXT level on a property: level 5 (hotel) is charged at
// hotelCost, everything below at houseCost — matching the client's build button.
function buildCost(tileId, currentHouses) {
  const tile = getTile(tileId);
  if (!tile || !PROPERTY_TYPES.has(tile.type)) return null;
  if (!Number.isInteger(currentHouses) || currentHouses < 0 || currentHouses >= MAX_HOUSES) {
    return null;
  }
  const cost = currentHouses === 4 ? tile.hotelCost : tile.houseCost;
  return Number.isFinite(cost) ? cost : null;
}

// Refund when selling the level that is currently built. A hotel (level 5) was
// paid for with hotelCost; anything below with houseCost. Half, floored.
function sellRefund(tileId, currentHouses) {
  if (!Number.isInteger(currentHouses) || currentHouses < 1) return null;
  const tile = getTile(tileId);
  if (!tile || !PROPERTY_TYPES.has(tile.type)) return null;
  const paid = currentHouses === 5 ? tile.hotelCost : tile.houseCost;
  if (!Number.isFinite(paid)) return null;
  return Math.floor(paid / 2);
}

// How many tiles of `type` does `ownerId` hold? Feeds utility rent scaling.
function countOwnedOfType(type, ownerId, propertyOwnership) {
  let n = 0;
  for (const tile of TILES) {
    if (tile.type === type && propertyOwnership[tile.id] === ownerId) n += 1;
  }
  return n;
}

// The authoritative rent for landing on `tileId`, computed from server state
// only. Returns 0 when no rent is due (unowned, self-owned, or not rentable).
//
// `propertyOwnership` and `propertyHouses` are the room's server-side maps.
function calculateRent(tileId, ownerId, propertyOwnership, propertyHouses) {
  const tile = getTile(tileId);
  if (!tile) return 0;

  if (PROPERTY_TYPES.has(tile.type)) {
    const houses = propertyHouses[tileId] || 0;
    if (Array.isArray(tile.rents) && tile.rents[houses] !== undefined) return tile.rents[houses];
    if (!Number.isFinite(tile.rents?.[0])) return 0;
    // Fallback shape, same as the client's: base rent + 60% per house.
    return Math.floor(tile.rents[0] * (1 + houses * 0.6));
  }

  if (UTILITY_TYPES.has(tile.type)) {
    const table = UTILITY_RENT_TABLE[tile.type];
    if (!table) return 0;
    const owned = countOwnedOfType(tile.type, ownerId, propertyOwnership);
    if (owned <= 0) return 0;
    return table[Math.min(owned, table.length) - 1] || 0;
  }

  return 0;
}

// The tax charged when landing on a tax tile (stored positive here; the client
// renders it as a negative amount).
function taxAmount(tileId) {
  const tile = getTile(tileId);
  if (!tile || tile.type !== 'tax') return 0;
  return Number.isFinite(tile.price) ? tile.price : 0;
}

// What a player is charged for landing on `tileId`. Covers the two money-moving
// specials the server can settle on its own (tax and rent). Returns
// { kind, amount, ownerId } or null when nothing is owed.
function landingCharge(tileId, playerId, propertyOwnership, propertyHouses) {
  const tile = getTile(tileId);
  if (!tile) return null;

  if (tile.type === 'tax') {
    return { kind: 'tax', amount: taxAmount(tileId), ownerId: null };
  }

  const ownerId = propertyOwnership[tileId];
  if (ownerId === undefined || ownerId === null) return null; // unowned
  if (ownerId === playerId) return null; // own property: no rent
  const amount = calculateRent(tileId, ownerId, propertyOwnership, propertyHouses);
  if (amount <= 0) return null;
  return { kind: 'rent', amount, ownerId };
}

// Cyclic forward search for the closest tile of a given type.
function findNearestTileIndex(fromPos, type) {
  for (let offset = 1; offset <= BOARD_SIZE; offset++) {
    const idx = (fromPos + offset) % BOARD_SIZE;
    const tile = getTile(idx);
    if (tile && tile.type === type) return idx;
  }
  return fromPos;
}

// Authoritative fee charged when landing on CLUB (tile 30).
// Formula: cardCount * $50 + houseCount * $100
function calculateClubFee(cardCount, houseCount) {
  const cards = Number(cardCount) > 0 ? 1 : 0;
  const houses = Number.isInteger(houseCount) && houseCount > 0 ? houseCount : 0;
  return cards * CLUB_FEE_PER_CARD + houses * CLUB_FEE_PER_HOUSE;
}

// Authoritative fee charged when landing on REST HOUSE (tile 20).
// Rest House has no fee; landing pays out the shared pot.
function calculateRestHouseFee() {
  return 0;
}

// Total number of houses owned by a given player across all properties.
function countPlayerHouses(propertyOwnership, propertyHouses, playerId) {
  if (!propertyHouses || !propertyOwnership) return 0;
  let total = 0;
  for (const [tileId, houses] of Object.entries(propertyHouses)) {
    if (propertyOwnership[tileId] === playerId) {
      total += Number(houses) || 0;
    }
  }
  return total;
}

// Whether a tile is a tax tile
function isTaxTile(tileId) {
  const tile = getTile(tileId);
  return !!tile && tile.type === 'tax';
}

module.exports = {
  TILES,
  BOARD_SIZE,
  PROPERTY_TYPES,
  UTILITY_TYPES,
  OWNABLE_TYPES,
  UTILITY_RENT_TABLE,
  MAX_HOUSES,
  STARTING_MONEY,
  PASS_START_BONUS,
  LAND_START_BONUS,
  JAIL_BAIL_COST,
  CLUB_FEE_PER_CARD,
  CLUB_FEE_PER_HOUSE,
  REST_HOUSE_TILE_ID,
  CLUB_TILE_ID,
  getTile,
  isValidTileId,
  isOwnableTile,
  isPropertyTile,
  isUtilityTile,
  purchasePrice,
  buildCost,
  sellRefund,
  countOwnedOfType,
  calculateRent,
  taxAmount,
  landingCharge,
  findNearestTileIndex,
  calculateClubFee,
  calculateRestHouseFee,
  countPlayerHouses,
  isTaxTile,
};