// Turns the raw bytes of a script into text. SSMS saves scripts as UTF-16 by
// default and older tools use Windows-1252, so UTF-8 cannot be assumed.

function decode(label, bytes, options) {
  return new TextDecoder(label, options).decode(bytes);
}

export function decodeScript(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decode('utf-8', bytes), encoding: 'UTF-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decode('utf-16le', bytes), encoding: 'UTF-16 LE' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decode('utf-16be', bytes), encoding: 'UTF-16 BE' };
  }

  // UTF-16 without a byte order mark: plain ASCII text leaves every other byte
  // empty, and which side they fall on gives the byte order.
  let nulEven = 0;
  let nulOdd = 0;
  const sampleEnd = Math.min(bytes.length, 4096);
  for (let i = 0; i < sampleEnd; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) nulEven++;
      else nulOdd++;
    }
  }
  if (nulEven + nulOdd > 0) {
    return nulOdd >= nulEven
      ? { text: decode('utf-16le', bytes), encoding: 'UTF-16 LE' }
      : { text: decode('utf-16be', bytes), encoding: 'UTF-16 BE' };
  }

  try {
    return { text: decode('utf-8', bytes, { fatal: true }), encoding: 'UTF-8' };
  } catch {
    return { text: decode('windows-1252', bytes), encoding: 'Windows-1252', guessed: true };
  }
}
