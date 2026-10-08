// Integration coverage for authoritative whole-property and improvement sales.
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const board = require('./game/board');
const URL = process.env.SERVER_URL || 'http://localhost:3002';
const sockets = [];
let seq = 0;
const actionId = () => `sale-test-${Date.now()}-${++seq}`;
const connect = () => new Promise((resolve, reject) => {
  const socket = io(URL, { reconnectionAttempts: 1, timeout: 4000 });
  sockets.push(socket);
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
});
const ack = (socket, event, data) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 2500);
  socket.emit(event, data, (result) => { clearTimeout(timer); resolve(result); });
});
const sync = (socket) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('sync timed out')), 2500);
  socket.once('game:sync', (state) => { clearTimeout(timer); resolve(state); });
  socket.emit('game:request-sync', {});
});
const money = (state, id = 1) => state.players.find((p) => p.id === id).money;
const sale = (socket, event, tileId, extra = {}) =>
  ack(socket, event, { tileId, playerId: 1, actionId: actionId(), ...extra });
const observe = (socket, event) => {
  const received = [];
  const listener = (data) => received.push(data);
  socket.on(event, listener);
  return { received, stop: () => socket.off(event, listener) };
};

(async () => {
  const A = await connect();
  const created = await ack(A, 'room:create', {});
  assert.equal(created.ok, true);
  const B = await connect();
  const joined = await ack(B, 'room:join', { roomId: created.roomId });
  assert.equal(joined.ok, true);
  assert.equal((await ack(A, 'player:identify', { roomId: created.roomId, token: created.token, playerId: 1 })).ok, true);
  assert.equal((await ack(B, 'player:identify', { roomId: created.roomId, token: joined.token, playerId: 2 })).ok, true);

  // Acquire tiles via the server's auction settlement, avoiding random dice.
  const acquire = async (tileId) => {
    const id = `sale-auction-${tileId}-${Date.now()}`;
    assert.equal((await ack(A, 'auction:start', { playerId: 1, auction: { id, tileId } })).ok, true);
    assert.equal((await ack(A, 'auction:bid', { auction: { id, tileId, currentBid: 10 } })).ok, true);
    assert.equal((await ack(A, 'auction:end', { auction: { id }, actionId: actionId() })).ok, true);
    assert.equal((await sync(A)).propertyOwnership[tileId], 1);
  };

  const spy = observe(B, 'property:sold');
  const houseSpy = observe(B, 'house:sold');
  await acquire(1); // Dhaka: $60, $50 per house / hotel
  await acquire(5); // Airport: $160, no improvements
  let state = await sync(A);
  let before = money(state);

  const C = await connect();
  const cJoined = await ack(C, 'room:join', { roomId: created.roomId });
  assert.equal(cJoined.ok, true);
  assert.equal((await sale(C, 'property:sold', 1)).code, 'NOT_IDENTIFIED');
  assert.equal((await sale(C, 'house:sold', 1)).code, 'NOT_IDENTIFIED');
  assert.equal((await sale(B, 'property:sold', 1)).code, 'NOT_YOUR_PLAYER');
  assert.equal((await sale(B, 'property:sold', 1, { playerId: 2 })).code, 'NOT_YOUR_TURN');
  assert.equal((await sale(B, 'house:sold', 1, { playerId: 2 })).code, 'NOT_YOUR_TURN');
  assert.equal((await sale(A, 'property:sold', 1, { playerId: 2 })).code, 'NOT_YOUR_PLAYER');
  assert.equal((await sale(A, 'house:sold', 1, { playerId: 2 })).code, 'NOT_YOUR_PLAYER');
  assert.equal((await sale(A, 'property:sold', 7)).code, 'BAD_TILE');
  assert.equal((await sale(A, 'property:sold', 2)).code, 'NOT_OWNED');
  assert.equal((await sale(A, 'property:sold', '1')).code, 'BAD_TILE');
  assert.equal((await sale(A, 'property:sold', 1, { actionId: '' })).code, 'BAD_ACTION_ID');
  assert.equal((await sale(A, 'house:sold', 1)).code, 'NOTHING_TO_SELL');
  assert.equal((await sale(A, 'house:sold', 5)).code, 'BAD_TILE');
  assert.equal(money(await sync(A)), before);
  assert.equal(spy.received.length, 0);
  assert.equal(houseSpy.received.length, 0);

  // With the turn handed to B, it still cannot sell A's tile as its owner.
  // The unidentified guest occupies seat 3; end that turn as well.
  assert.equal((await ack(A, 'turn:ended', { playerId: 1, actionId: actionId() })).ok, true);
  assert.equal((await sale(B, 'property:sold', 1, { playerId: 2 })).code, 'NOT_OWNER');
  assert.equal((await sale(B, 'house:sold', 1, { playerId: 2 })).code, 'NOT_OWNER');
  assert.equal((await ack(B, 'turn:ended', { playerId: 2, actionId: actionId() })).ok, true);
  assert.equal((await sync(A)).currentTurnPlayerId, 3);
  assert.equal((await ack(C, 'player:identify', { roomId: created.roomId, token: cJoined.token, playerId: 3 })).ok, true);
  assert.equal((await ack(C, 'turn:ended', { playerId: 3, actionId: actionId() })).ok, true);
  assert.equal((await sync(A)).currentTurnPlayerId, 1);
  assert.equal(money(await sync(A)), before);
  assert.equal(spy.received.length, 0);
  assert.equal(houseSpy.received.length, 0);

  const built = await ack(A, 'house:upgraded', { tileId: 1, playerId: 1, houses: 5, actionId: actionId() });
  assert.equal(built.ok, true, JSON.stringify(built));
  state = await sync(A);
  assert.equal(state.propertyHouses[1], 5);
  before = money(state);
  const malicious = { refund: 999, money: 999, houses: 0, price: 999 };
  const hotelId = actionId();
  const hotel = await sale(A, 'house:sold', 1, { ...malicious, actionId: hotelId });
  assert.deepEqual({ refund: hotel.refund, houses: hotel.houses, money: hotel.money },
    { refund: board.sellRefund(1, 5), houses: 4, money: before + board.sellRefund(1, 5) });
  assert.equal((await sync(A)).propertyHouses[1], 4);
  assert.equal(houseSpy.received.length, 1);
  assert.equal(houseSpy.received[0].money, hotel.money);
  assert.equal(houseSpy.received[0].houses, 4);
  assert.equal((await sale(A, 'house:sold', 1, { actionId: hotelId })).code, 'DUPLICATE_ACTION');
  assert.equal(money(await sync(A)), hotel.money);
  assert.equal(houseSpy.received.length, 1);

  const house = await sale(A, 'house:sold', 1, malicious);
  assert.equal(house.refund, board.sellRefund(1, 4));
  assert.equal(house.houses, 3);
  assert.equal(house.money, hotel.money + house.refund);
  assert.equal(houseSpy.received.length, 2);
  assert.equal((await ack(A, 'house:upgraded', { tileId: 1, playerId: 1, houses: 0, actionId: actionId() })).code, 'BAD_BUILD');
  assert.equal((await sync(A)).propertyHouses[1], 3);

  before = money(await sync(A));
  const propertyId = actionId();
  const expected = Math.floor(board.purchasePrice(1) / 2) + [1, 2, 3].reduce((sum, level) => sum + board.sellRefund(1, level), 0);
  const sold = await sale(A, 'property:sold', 1, { ...malicious, actionId: propertyId, ownerId: 2 });
  assert.deepEqual({ refund: sold.refund, money: sold.money, houses: sold.houses, ownerId: sold.ownerId },
    { refund: expected, money: before + expected, houses: 0, ownerId: null });
  state = await sync(A);
  assert.equal(state.propertyOwnership[1], undefined);
  assert.equal(state.propertyHouses[1], undefined);
  assert.equal(money(state), sold.money);
  assert.equal(spy.received.length, 1);
  assert.deepEqual({ money: spy.received[0].money, houses: spy.received[0].houses, ownerId: spy.received[0].ownerId },
    { money: sold.money, houses: 0, ownerId: null });
  assert.equal((await sale(A, 'property:sold', 1, { actionId: propertyId })).code, 'DUPLICATE_ACTION');
  assert.equal((await sale(A, 'property:sold', 1)).code, 'NOT_OWNED');
  assert.equal(spy.received.length, 1);
  assert.equal(money(await sync(A)), sold.money);

  before = money(await sync(A));
  const utility = await sale(A, 'property:sold', 5, malicious);
  assert.equal(utility.refund, Math.floor(board.purchasePrice(5) / 2));
  assert.equal(utility.money, before + utility.refund);
  assert.equal((await sync(B)).propertyOwnership[5], undefined);
  assert.equal(spy.received.length, 2);
  spy.stop(); houseSpy.stop();
  console.log('PASS property and house sales: official refunds, broadcasts, spoofing, unauthorized actions and replay');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const socket of sockets) socket.disconnect();
});
