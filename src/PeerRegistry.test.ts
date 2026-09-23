import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PeerRegistry } from './PeerRegistry.js';

type FakeSocket = { label: string };

function socket(label: string): FakeSocket {
  return { label };
}

describe('PeerRegistry', () => {
  it('registers and looks up roomless peers', () => {
    const registry = new PeerRegistry<FakeSocket>();
    const a = socket('a');

    registry.register('peer-a', a);

    assert.equal(registry.size, 1);
    assert.equal(registry.roomCount, 0);
    assert.equal(registry.has('peer-a'), true);
    assert.equal(registry.get('peer-a')?.socket, a);
    assert.equal(registry.get('peer-a')?.room, null);
    assert.deepEqual(
      registry.roomless().map((record) => record.id),
      ['peer-a'],
    );
  });

  it('indexes room membership and exposes a roster', () => {
    const registry = new PeerRegistry<FakeSocket>();
    registry.register('a', socket('a'), { name: 'Ada', room: 'teal-otter' });
    registry.register('b', socket('b'), { name: 'Bob', room: 'teal-otter' });
    registry.register('c', socket('c'), { name: 'Cy', room: 'other-room' });

    assert.equal(registry.sizeOfRoom('teal-otter'), 2);
    assert.equal(registry.roomCount, 2);
    assert.deepEqual(registry.rosterOf('teal-otter'), [
      { id: 'a', name: 'Ada' },
      { id: 'b', name: 'Bob' },
    ]);
    assert.deepEqual(registry.rosterOf('teal-otter', 'a'), [{ id: 'b', name: 'Bob' }]);
    assert.deepEqual(registry.roomless(), []);
  });

  it('drops empty rooms from the index so roomCount reflects live rooms', () => {
    const registry = new PeerRegistry<FakeSocket>();
    registry.register('a', socket('a'), { room: 'ghost-room' });

    assert.equal(registry.roomCount, 1);
    registry.unregister('a');

    assert.equal(registry.roomCount, 0);
    assert.equal(registry.sizeOfRoom('ghost-room'), 0);
    assert.deepEqual(registry.membersOf('ghost-room'), []);
  });

  it('does not leave a stale room member behind when an id is re-registered', () => {
    const registry = new PeerRegistry<FakeSocket>();
    const first = socket('first');
    const second = socket('second');

    registry.register('a', first, { name: 'First', room: 'room-one' });
    registry.register('a', second, { name: 'Second', room: 'room-two' });

    assert.equal(registry.size, 1);
    assert.equal(registry.sizeOfRoom('room-one'), 0);
    assert.equal(registry.sizeOfRoom('room-two'), 1);
    assert.equal(registry.get('a')?.socket, second);
    assert.deepEqual(registry.rosterOf('room-two'), [{ id: 'a', name: 'Second' }]);
  });

  it('moves a peer between rooms with joinRoom', () => {
    const registry = new PeerRegistry<FakeSocket>();
    registry.register('a', socket('a'), { name: 'Ada', room: 'room-one' });

    const moved = registry.joinRoom('a', 'room-two', 'Ada L');

    assert.equal(moved?.room, 'room-two');
    assert.equal(registry.sizeOfRoom('room-one'), 0);
    assert.deepEqual(registry.rosterOf('room-two'), [{ id: 'a', name: 'Ada L' }]);
  });

  it('promotes a roomless peer into a room with joinRoom', () => {
    const registry = new PeerRegistry<FakeSocket>();
    registry.register('a', socket('a'));

    registry.joinRoom('a', 'room-one', 'Ada');

    assert.deepEqual(registry.roomless(), []);
    assert.equal(registry.sizeOfRoom('room-one'), 1);
  });

  it('returns undefined when joining or unregistering an unknown peer', () => {
    const registry = new PeerRegistry<FakeSocket>();

    assert.equal(registry.joinRoom('nobody', 'room-one', 'Nobody'), undefined);
    assert.equal(registry.unregister('nobody'), undefined);
    assert.equal(registry.roomCount, 0);
  });

  it('keeps the rest of a room intact when one member leaves', () => {
    const registry = new PeerRegistry<FakeSocket>();
    registry.register('a', socket('a'), { name: 'Ada', room: 'room-one' });
    registry.register('b', socket('b'), { name: 'Bob', room: 'room-one' });

    const removed = registry.unregister('a');

    assert.equal(removed?.name, 'Ada');
    assert.equal(registry.sizeOfRoom('room-one'), 1);
    assert.deepEqual(registry.rosterOf('room-one'), [{ id: 'b', name: 'Bob' }]);
  });

  it('lists members in join order so the first joiner is stable', () => {
    const registry = new PeerRegistry<FakeSocket>();
    registry.register('a', socket('a'), { room: 'room-one' });
    registry.register('b', socket('b'), { room: 'room-one' });
    registry.register('c', socket('c'), { room: 'room-one' });

    assert.deepEqual(
      registry.membersOf('room-one').map((record) => record.id),
      ['a', 'b', 'c'],
    );
  });
});
