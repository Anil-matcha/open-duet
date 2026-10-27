import { formatPairingCode, normalizePairingCode, parsePairingLink } from '@/lib/pairing-link';

describe('normalizePairingCode', () => {
  it('ignores case, spaces and dashes', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' ABCD EFGH ')).toBe('ABCDEFGH');
  });

  it('rejects the wrong length and look-alike characters the server never issues', () => {
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(normalizePairingCode('ABCD-EFGHJ')).toBeNull();
    expect(normalizePairingCode('ABCD-EFG0')).toBeNull();
    expect(normalizePairingCode('ABCD-EFGO')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
  });

  it('formats like the server shows it', () => {
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

describe('parsePairingLink', () => {
  it('reads the phone app link', () => {
    expect(parsePairingLink('suparagent://pair?server=https%3A%2F%2Fdots.example.com#code=ABCD-EFGH')).toEqual({
      server: 'https://dots.example.com',
      code: 'ABCDEFGH',
    });
  });

  it('reads the server address with a port and path', () => {
    expect(parsePairingLink('suparagent://pair?server=https%3A%2F%2Fh.example.com%3A8443%2Fdots#code=ABCD-EFGH')?.server).toBe(
      'https://h.example.com:8443/dots',
    );
  });

  it('accepts the code in the query too', () => {
    expect(parsePairingLink('suparagent://pair?server=https%3A%2F%2Fx.example.com&code=ABCDEFGH')).toEqual({
      server: 'https://x.example.com',
      code: 'ABCDEFGH',
    });
  });

  it('reads the web link shown beside it', () => {
    expect(parsePairingLink('https://dots.example.com/pair#code=ABCD-EFGH')).toEqual({ server: 'https://dots.example.com', code: 'ABCDEFGH' });
    expect(parsePairingLink('https://example.com/dots/pair/#code=ABCD-EFGH')).toEqual({ server: 'https://example.com/dots', code: 'ABCDEFGH' });
  });

  it('rejects links without a valid code, and anything else', () => {
    expect(parsePairingLink('suparagent://pair?server=https%3A%2F%2Fx.example.com')).toBeNull();
    expect(parsePairingLink('suparagent://pair?server=x#code=NOPE')).toBeNull();
    expect(parsePairingLink('suparagent://other?server=x#code=ABCD-EFGH')).toBeNull();
    expect(parsePairingLink('https://example.com/login#code=ABCD-EFGH')).toBeNull();
    expect(parsePairingLink('hello')).toBeNull();
  });

  it('gives no server when the link has none', () => {
    expect(parsePairingLink('suparagent://pair#code=ABCD-EFGH')).toEqual({ server: null, code: 'ABCDEFGH' });
  });
});
