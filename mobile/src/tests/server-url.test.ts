import { normalizeServerUrl, serverLabel } from '@/lib/server-url';

const https = { allowHttp: false };

describe('normalizeServerUrl', () => {
  it('adds https when no scheme is given and drops trailing slashes', () => {
    expect(normalizeServerUrl('Dots.Example.com/', https)).toEqual({ ok: true, url: 'https://dots.example.com', secure: true });
  });

  it('keeps a port and a path prefix', () => {
    expect(normalizeServerUrl('https://example.com:8443/dots/', https)).toEqual({ ok: true, url: 'https://example.com:8443/dots', secure: true });
  });

  it('accepts a bare host and port', () => {
    expect(normalizeServerUrl('example.com:8443', https)).toMatchObject({ ok: true, url: 'https://example.com:8443' });
  });

  it('refuses plain http unless allowed', () => {
    expect(normalizeServerUrl('http://192.168.1.5:8000', https)).toEqual({ ok: false, reason: 'insecure' });
    expect(normalizeServerUrl('http://192.168.1.5:8000', { allowHttp: true })).toEqual({ ok: true, url: 'http://192.168.1.5:8000', secure: false });
  });

  it('refuses other schemes, user info, queries and fragments', () => {
    expect(normalizeServerUrl('ftp://example.com', https)).toEqual({ ok: false, reason: 'unsupported_scheme' });
    expect(normalizeServerUrl('https://user:pw@example.com', https)).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('https://example.com/?x=1', https)).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('https://example.com/#frag', https)).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('javascript:alert(1)', https)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses empty input and bad ports', () => {
    expect(normalizeServerUrl('   ', https)).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeServerUrl('https://example.com:0', https)).toEqual({ ok: false, reason: 'invalid' });
    expect(normalizeServerUrl('https://example.com:70000', https)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('serverLabel', () => {
  it('shows host, port and path without the scheme', () => {
    expect(serverLabel('https://example.com:8443/dots')).toBe('example.com:8443/dots');
  });
});
