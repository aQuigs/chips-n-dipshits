/* Which chat lines show as a GIF, and from what address: the one place that decides what every browser at the table fetches. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GIF_HOSTS, gifAddress } from '../src/client/gifs.ts';

const GIPHY = 'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif';

test('a line that is a GIF’s address on a listed host shows as that GIF, from each host on the list', () => {
  assert.equal(gifAddress(GIPHY), GIPHY);
  assert.equal(gifAddress(`  ${GIPHY}  `), GIPHY, 'spaces around the line are no part of it');
  assert.equal(gifAddress('https://media.tenor.com/abcDEF123/dancing-cat.gif'), 'https://media.tenor.com/abcDEF123/dancing-cat.gif');
  assert.equal(gifAddress('https://i.imgur.com/AbC123.gif'), 'https://i.imgur.com/AbC123.gif');

  for (const host of GIF_HOSTS) {
    assert.equal(gifAddress(`https://${host}/a/b.gif`), `https://${host}/a/b.gif`, host);
  }
});

test('the query and fragment are left behind, so nothing typed after the file’s name goes to the host', () => {
  assert.equal(gifAddress(`${GIPHY}?cid=abc&rid=giphy.gif&ct=g`), GIPHY);
  assert.equal(gifAddress(`${GIPHY}#https://elsewhere.example/x`), GIPHY);
});

test('a Giphy page is turned into its picture’s address, and nothing else on giphy.com is', () => {
  assert.equal(gifAddress('https://giphy.com/gifs/cat-dance-party-l0MYt5jPR6QX5pnqM'), GIPHY);
  assert.equal(gifAddress('https://www.giphy.com/gifs/l0MYt5jPR6QX5pnqM'), GIPHY);
  assert.equal(gifAddress('https://giphy.com/gifs/cat-dance-party-l0MYt5jPR6QX5pnqM?utm=x'), GIPHY);

  assert.equal(gifAddress('https://giphy.com/stickers/cat-l0MYt5jPR6QX5pnqM'), null);
  assert.equal(gifAddress('https://giphy.com/gifs/cat-l0MYt5jPR6QX5pnqM/more'), null);
  assert.equal(gifAddress('https://giphy.com/gifs/'), null);
  assert.equal(gifAddress('https://giphy.com/gifs/cat_dance'), null, 'an id is letters and digits');
  assert.equal(gifAddress('https://giphy.com.evil.example/gifs/cat-l0MYt5jPR6QX5pnqM'), null);
});

test('the host must be on the list exactly: not as a subdomain of another, a path, a username, or with a trailing dot', () => {
  const tricks = [
    'https://media.giphy.com.evil.example/a.gif',
    'https://evil.example/media.giphy.com/a.gif',
    'https://evil.example/https://media.giphy.com/a.gif',
    'https://media.giphy.com@evil.example/a.gif',
    'https://user:pass@media.giphy.com/a.gif',
    'https://user@media.giphy.com/a.gif',
    'https://media.giphy.com./a.gif',
    'https://giphy.com/a.gif',
    'https://evilmedia.giphy.com/a.gif',
    'https://xn--mdia-giphy-9db.com/a.gif',
    'https://mеdia.giphy.com/a.gif',
    'https://evil.example\\.media.giphy.com/a.gif',
    'https://media.giphy.com\\@evil.example/a.gif',
  ];

  for (const line of tricks) {
    assert.equal(gifAddress(line), null, line);
  }
});

test('mixed case in the scheme and host is the same address, written as the browser reads it', () => {
  assert.equal(gifAddress('HTTPS://MEDIA.GIPHY.COM/media/abc/giphy.gif'), 'https://media.giphy.com/media/abc/giphy.gif');
  assert.equal(gifAddress('https://i.imgur.com/AbC123.GIF'), 'https://i.imgur.com/AbC123.GIF');
});

test('only https on the usual port: no other scheme, no port of its own, nothing but a GIF', () => {
  const others = [
    'http://media.giphy.com/a.gif',
    'javascript:alert(1)//media.giphy.com/a.gif',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    'ftp://media.giphy.com/a.gif',
    '//media.giphy.com/a.gif',
    'media.giphy.com/a.gif',
    'https://media.giphy.com:8443/a.gif',
    'https://media.giphy.com/a.png',
    'https://media.giphy.com/a.gifv',
    'https://i.imgur.com/AbC123.mp4',
    'https://media.giphy.com/',
    'https://media.giphy.com',
  ];

  for (const line of others) {
    assert.equal(gifAddress(line), null, line);
  }

  assert.equal(gifAddress('https://media.giphy.com:443/a.gif'), 'https://media.giphy.com/a.gif', 'the usual port written out is the same address');
});

test('encoded characters stay out of the path, and an encoded host is the host it decodes to', () => {
  assert.equal(gifAddress('https://media.giphy.com/a%2F..%2Fb.gif'), null);
  assert.equal(gifAddress('https://media.giphy.com/%2e%2e/a.gif'), 'https://media.giphy.com/a.gif', 'the browser reads an encoded dot segment as a step up, which stays on the host');
  assert.equal(gifAddress('https://media.giphy.com/caf%C3%A9.gif'), null);
  assert.equal(gifAddress('https://media%2Egiphy.com/a.gif'), 'https://media.giphy.com/a.gif');
  assert.equal(gifAddress('https://evil%2Eexample/media.giphy.com/a.gif'), null);
});

test('a line that is more than the one address is just words: a newline, a tab, two links, a link inside other words', () => {
  const lines = [
    `look ${GIPHY}`,
    `${GIPHY} lol`,
    `${GIPHY} ${GIPHY}`,
    `${GIPHY}${GIPHY}`,
    `https://media.gi\nphy.com/a.gif`,
    `https://media.giphy.com/a\t.gif`,
    `${GIPHY}\n`.repeat(2),
    `https://media.giphy.com/a.gif​`,
    `https://media.giphy.com/a‮.gif`,
    '',
    '   ',
  ];

  for (const line of lines) {
    assert.equal(gifAddress(line), null, JSON.stringify(line));
  }
});
