import { isLocalHost, isPlainHttp, normalizeServerUrl, responseAllowed, serverLabel } from '@/lib/server-url';

describe('normalizeServerUrl', () => {
  it('adds https when no scheme is given and drops trailing slashes', () => {
    expect(normalizeServerUrl('Dots.Example.com/')).toEqual({ ok: true, url: 'https://dots.example.com', secure: true });
  });

  it('keeps a port and a path prefix', () => {
    expect(normalizeServerUrl('https://example.com:8443/dots/')).toEqual({ ok: true, url: 'https://example.com:8443/dots', secure: true });
  });

  it('accepts a bare host and port', () => {
    expect(normalizeServerUrl('example.com:8443')).toMatchObject({ ok: true, url: 'https://example.com:8443' });
  });

  it('accepts plain http for an address on the local network and marks it not secure', () => {
    expect(normalizeServerUrl('http://192.168.1.5:8000')).toEqual({ ok: true, url: 'http://192.168.1.5:8000', secure: false });
    expect(normalizeServerUrl('http://10.0.2.2:8000/')).toEqual({ ok: true, url: 'http://10.0.2.2:8000', secure: false });
    expect(normalizeServerUrl('http://MyBox.local')).toEqual({ ok: true, url: 'http://mybox.local', secure: false });
    expect(normalizeServerUrl('http://[::1]:8000')).toEqual({ ok: true, url: 'http://[::1]:8000', secure: false });
  });

  it('refuses plain http for any other address', () => {
    for (const url of ['http://example.com', 'http://8.8.8.8:8000', 'http://100.64.0.1', 'http://mybox', 'http://192.168.1.5.evil.com', 'http://localhost.evil.com']) {
      expect(normalizeServerUrl(url)).toEqual({ ok: false, reason: 'insecure' });
    }
  });

  it('still accepts https for any host, including a local one', () => {
    expect(normalizeServerUrl('https://192.168.1.5:8443')).toMatchObject({ ok: true, secure: true });
  });

  it('refuses other schemes, user info, queries and fragments', () => {
    expect(normalizeServerUrl('ftp://example.com')).toEqual({ ok: false, reason: 'unsupported_scheme' });
    expect(normalizeServerUrl('https://user:pw@example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('https://example.com/?x=1')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('https://example.com/#frag')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('javascript:alert(1)')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses empty input and bad ports', () => {
    expect(normalizeServerUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeServerUrl('https://example.com:0')).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('https://example.com:70000')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('serverLabel', () => {
  it('shows host, port and path without the scheme', () => {
    expect(serverLabel('https://example.com:8443/dots')).toBe('example.com:8443/dots');
  });
});

describe('isLocalHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'dots.localhost',
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.0',
    '10.0.2.2',
    '10.255.255.255',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.10.20',
    'mybox.local',
    'My-Box.LOCAL',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[fc00::1]',
    '[fd12:3456:789a::1]',
  ])('accepts %s', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each([
    '',
    'example.com',
    'local',
    '.local',
    'mybox',
    'localhost.evil.com',
    'evil.com.local.example.com',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.0.1',
    '192.167.255.255',
    '11.0.0.1',
    '9.255.255.255',
    '169.253.1.1',
    '100.64.0.1',
    '8.8.8.8',
    '0.0.0.0',
    '192.168.1',
    '192.168.1.256',
    '192.168.001.5',
    '010.0.0.1',
    '0x7f.0.0.1',
    '2130706433',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[fe80::1]',
    '[2001:db8::1]',
    '[::2]',
    '[fb00::1]',
    '[fe00::1]',
    '[::1',
  ])('refuses %s', (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});

describe('responseAllowed', () => {
  it('allows a missing URL, any https URL and a local http URL', () => {
    expect(responseAllowed(undefined)).toBe(true);
    expect(responseAllowed('')).toBe(true);
    expect(responseAllowed('https://example.com/api/v1/threads')).toBe(true);
    expect(responseAllowed('http://192.168.1.5:8000/api/v1/threads')).toBe(true);
  });

  it('refuses a response that came from plain http on another host, as after a redirect', () => {
    expect(responseAllowed('http://example.com/api/v1/threads')).toBe(false);
    expect(responseAllowed('http://8.8.8.8:8000/x')).toBe(false);
    expect(responseAllowed('HTTP://evil.example/')).toBe(false);
  });
});

describe('isPlainHttp', () => {
  it('tells http from https', () => {
    expect(isPlainHttp('http://192.168.1.5:8000')).toBe(true);
    expect(isPlainHttp('https://dots.example.com')).toBe(false);
  });
});
