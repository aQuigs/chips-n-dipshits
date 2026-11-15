import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG_SPECS, DEFAULT_CONFIG, LIMITS, validatedConfig, validSetting } from '../src/engine/index.ts';
import { callHost } from '../src/client/callHost.ts';
import { seededRng } from './helpers.ts';

const voiceLink = (value: unknown) => validSetting(CONFIG_SPECS.voiceLink, value, DEFAULT_CONFIG) as string;

const refusal = (value: unknown) => {
  try {
    voiceLink(value);
  } catch (error) {
    assert.equal((error as Error).name, 'GameError');

    return (error as Error).message;
  }

  return null;
};

test('the voice chat link takes a secure web address, trimmed, with its scheme in small letters', () => {
  assert.equal(voiceLink('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  assert.equal(voiceLink('  https://discord.gg/AbCd123 \n'), 'https://discord.gg/AbCd123');
  assert.equal(voiceLink('HTTPS://Meet.Google.com/abc'), 'https://Meet.Google.com/abc');
  assert.equal(voiceLink('hTtPs://us02web.zoom.us/j/123456789?pwd=Ab.c-_~9'), 'https://us02web.zoom.us/j/123456789?pwd=Ab.c-_~9');
  assert.equal(voiceLink('https://call.example.org:8443/room#lobby'), 'https://call.example.org:8443/room#lobby');
  assert.equal(voiceLink('https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%22Tid%22%7d'), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%22Tid%22%7d');
  assert.equal(voiceLink('https://xn--bcher-kva.example/raum'), 'https://xn--bcher-kva.example/raum', 'a name in another alphabet, in the form browsers show');
  assert.equal(voiceLink('https://meet.example'), 'https://meet.example', 'nothing after the host');
});

test('an empty voice chat link turns it off', () => {
  assert.equal(voiceLink(''), '');
  assert.equal(voiceLink('   '), '');
  assert.equal(validatedConfig({ voiceLink: '' }, { ...DEFAULT_CONFIG, voiceLink: 'https://meet.google.com/abc' }).voiceLink, '');
});

test('anything but a plain secure web address is refused, saying why', () => {
  const scheme = 'The voice chat link must start with https://';
  const shape = "The voice chat link isn't a web address like https://meet.google.com/abc-defg-hij";
  const credentials = "The voice chat link can't have a username or password in it";
  const hidden = "The voice chat link can't have spaces or hidden characters in it";

  assert.equal(refusal('http://meet.google.com/abc'), scheme);
  assert.equal(refusal('javascript:alert(1)'), scheme);
  assert.equal(refusal('JavaScript://meet.google.com/%0aalert(1)'), scheme);
  assert.equal(refusal('data:text/html,<b>hi</b>'), scheme);
  assert.equal(refusal('meet.google.com/abc'), scheme);
  assert.equal(refusal('//meet.google.com/abc'), scheme);
  assert.equal(refusal('https:meet.google.com'), scheme);

  assert.equal(refusal('https://user:pass@meet.google.com/abc'), credentials);
  assert.equal(refusal('https://meet.google.com@evil.example/abc'), credentials);
  assert.equal(refusal('https://@evil.example'), credentials);

  assert.equal(refusal('https://meet.google.com/a b'), hidden);
  assert.equal(refusal('https://meet.google.com/a\tb'), hidden);
  assert.equal(refusal('https://meet.google.com/\u0000'), hidden);
  assert.equal(refusal('https://meet.google.com​/abc'), hidden);
  assert.equal(refusal('https://meet.google.com/‮abc'), hidden);

  const plainLetters = "The voice chat link must spell its site's name in a to z, 0 to 9 and hyphens";
  assert.equal(refusal('https://bücher.example/raum'), plainLetters);
  assert.equal(refusal('https://例え.テスト'), plainLetters);
  assert.equal(refusal('https://meet.gооgle.com/abc'), plainLetters, 'Cyrillic o, which reads as the Latin one');

  assert.equal(refusal('https://'), shape);
  assert.equal(refusal('https:///meet.google.com'), shape);
  assert.equal(refusal('https://localhost/room'), shape, 'a host the internet has no name for');
  assert.equal(refusal('https://meet.google.com./abc'), shape);
  assert.equal(refusal('https://-evil.example'), shape);
  assert.equal(refusal('https://evil.example:99999'), shape);
  assert.equal(refusal('https://evil.example:80:80'), shape);
  assert.equal(refusal('https://[::1]/room'), shape);
  assert.equal(refusal('https://192.168.1.20/room'), shape, 'a browser reads a host ending in a number as an IP address');
  assert.equal(refusal('https://meet.example/raum/ü'), shape);
  assert.equal(refusal('https://evil.example\\@meet.google.com'), shape, 'a browser reads a backslash as the end of the host');
  assert.equal(refusal('https://meet.google.com/"><script>'), shape);
  assert.equal(refusal('https://meet.google.com/{x}'), shape);

  assert.equal(refusal(`https://meet.google.com/${'a'.repeat(LIMITS.linkLength)}`), `The voice chat link must be at most ${LIMITS.linkLength} characters`);
  assert.equal(voiceLink(`https://meet.example/${'a'.repeat(LIMITS.linkLength - 'https://meet.example/'.length)}`).length, LIMITS.linkLength);
  assert.equal(refusal(42), 'The voice chat link is missing');
  assert.equal(refusal(null), 'The voice chat link is missing');
});

test('an address the table takes is one a browser reads as secure, with no username or password, and the same host', () => {
  const pieces = ['https://', 'HTTPS://', 'a', 'Z', '0', '0x', '-', '_', '.', 'xn--', 'ü', 'ß', 'א', '\u0301', ':', '443', '@', '/', '\\', '?', '#', '%', '%2F', '[', ']', "'", '!', '=', 'x.y', 'meet.google.com', 'www.'];
  const rng = seededRng(29);
  let taken = 0;

  for (let draw = 0; draw < 30_000; draw++) {
    const typed = ['https://', ...Array.from({ length: 1 + rng.int(8) }, () => pieces[rng.int(pieces.length)])].join('');

    let address: string;
    try {
      address = voiceLink(typed);
    } catch {
      continue;
    }

    taken += 1;
    const read = new URL(address);
    const host = address.slice('https://'.length).split(/[/?#:]/, 1)[0]!;

    assert.equal(read.protocol, 'https:', typed);
    assert.equal(read.username + read.password, '', typed);
    assert.equal(read.hostname, new URL(`https://${host}`).hostname, typed);
  }

  assert.ok(taken > 300, `only ${taken} random addresses were taken, too few to say anything`);
});

test('the button names the host the browser will go to, shortened from the front', () => {
  assert.deepEqual(callHost('https://meet.google.com/abc-defg-hij'), { host: 'meet.google.com', shown: 'meet.google.com' });
  assert.deepEqual(callHost('https://www.Zoom.us/j/1'), { host: 'www.zoom.us', shown: 'zoom.us' });

  const long = callHost('https://meet.google.com.a-very-long-subdomain.evil.example/abc')!;
  assert.equal(long.shown, '…-subdomain.evil.example');
  assert.equal(long.shown.length, 24);

  assert.equal(callHost('not an address'), null);
});
