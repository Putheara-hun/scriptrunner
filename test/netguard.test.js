import test from 'node:test';
import assert from 'node:assert/strict';
import { addressIsPublic, resolveSafely, BlockedAddressError } from '../lib/netguard.js';

test('private, loopback, link-local and reserved IPv4 are not public', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.5', '198.51.100.9',
    '203.0.113.7', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(addressIsPublic(ip), false, ip);
  }
});

test('ordinary public IPv4 is public, including near the edges of private blocks', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1', '126.255.255.255', '128.0.0.1']) {
    assert.equal(addressIsPublic(ip), true, ip);
  }
});

test('IPv6 loopback, unique-local, link-local and mapped private addresses are not public', () => {
  for (const ip of [
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.1', '64:ff9b::127.0.0.1',
  ]) {
    assert.equal(addressIsPublic(ip), false, ip);
  }
});

test('public IPv6 and a mapped public IPv4 are public', () => {
  assert.equal(addressIsPublic('2606:4700:4700::1111'), true);
  assert.equal(addressIsPublic('::ffff:8.8.8.8'), true);
});

test('nonsense is never treated as public', () => {
  for (const value of ['', 'not-an-ip', '999.1.1.1', '::gggg', '1.2.3']) {
    assert.equal(addressIsPublic(value), false, value);
  }
});

test('an IP literal is vetted directly, with no DNS lookup', async () => {
  const noLookup = () => { throw new Error('should not be called'); };
  assert.equal(await resolveSafely('93.184.216.34', noLookup), '93.184.216.34');
  await assert.rejects(resolveSafely('127.0.0.1', noLookup), BlockedAddressError);
  await assert.rejects(resolveSafely('[::1]', noLookup), BlockedAddressError);
});

test('a hostname is pinned to its resolved public address', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal(await resolveSafely('db.example.com', lookup), '93.184.216.34');
});

test('a hostname is refused if any of its addresses is private', async () => {
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ];
  await assert.rejects(resolveSafely('sneaky.example.com', lookup), (error) => {
    assert.ok(error instanceof BlockedAddressError);
    assert.equal(error.blockedAddress, '169.254.169.254');
    return true;
  });
});

test('a name that does not resolve gives a clear error', async () => {
  const lookup = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(resolveSafely('nope.invalid', lookup), /could not be found/);
});
