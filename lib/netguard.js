import dnsPromises from 'node:dns/promises';
import net from 'node:net';

export class BlockedAddressError extends Error {
  constructor(host, address) {
    super(
      `"${host}" resolves to ${address}, a private or internal address this server will not connect to. ` +
        'Use a database that is reachable on the public internet.',
    );
    this.name = 'BlockedAddressError';
    this.blockedAddress = address;
  }
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isPublicV4(ip) {
  if (ip === '255.255.255.255') return false;
  const value = ipv4ToInt(ip);
  return !V4_BLOCKS.some(({ base, mask }) => (value & mask) === (base & mask));
}

function expandV6(ip) {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.') && net.isIPv4(tail)) {
    const value = ipv4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const back = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - back.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.map((group) => parseInt(group || '0', 16));
}

function isPublicV6(ip) {
  const groups = expandV6(ip);
  if (!groups || groups.some((group) => Number.isNaN(group))) return false;

  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[4] === 0 && groups[5] === 0xffff;
  const isNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b;
  if (isMapped || isNat64) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPublicV4(v4);
  }

  if (groups.every((g) => g === 0)) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false;
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  return true;
}

export function addressIsPublic(ip) {
  if (net.isIPv4(ip)) return isPublicV4(ip);
  if (net.isIPv6(ip)) return isPublicV6(ip);
  return false;
}

export async function resolveSafely(host, lookup = dnsPromises.lookup) {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').trim();

  if (net.isIP(bare)) {
    if (!addressIsPublic(bare)) throw new BlockedAddressError(host, bare);
    return bare;
  }

  let records;
  try {
    records = await lookup(bare, { all: true });
  } catch {
    throw new Error(`The server name "${host}" could not be found.`);
  }
  const addresses = records.map((record) => record.address);
  if (addresses.length === 0) throw new Error(`The server name "${host}" could not be found.`);

  const blocked = addresses.find((address) => !addressIsPublic(address));
  if (blocked) throw new BlockedAddressError(host, blocked);
  return addresses[0];
}
