---
title: I built a whole action game in one HTML file
published: false
description: How a 1000-stage canvas platformer fits in one page of plain JavaScript, with generated music, local saves and a consent-free play counter. Plus what that choice costs.
tags: gamedev, javascript, webdev, html5
---

Samurai Vengeance is a side-on samurai action platformer with 1000 stages, ten bosses, a three-hit combo, a parry and a dash. The game itself lives in one file: `index.html`. It is about 600 KB and roughly 8,700 lines of plain JavaScript, CSS and markup, drawn on HTML canvas with no game engine and no build step.

That is mostly true, and the "mostly" is part of this post. Here is how the pieces fit, and where the single-file idea stops.

## Why one file

It was my first game, and one file meant there was nothing to configure. No bundler, no module graph, no asset pipeline. Open the file, change a line, reload. Deploying is uploading a static page to Netlify.

It also suits the platform. The whole point of the game is that anyone can play it from a link, on a phone or a computer, without installing anything. A single page that starts as soon as it loads fits that.

## Three canvases, not one

The page has three stacked full-screen canvases: `bg` for the parallax background, `c` for the action, and `fg` for weather and foreground. Splitting them lets each layer run at a different cost.

On high-density phone screens I scale the canvases by the device pixel ratio, but cap it at 2. All three are full screen and redrawn every frame, so fill cost grows with the square of the ratio. Going to 3x would be more than twice the pixels of 2x for a difference that is hard to see on a phone at arm's length.

## Art: procedural first, atlases on top

This is where "one file" bends. The painted art is not inlined. It ships as separate PNG atlases next to the page: one each for the player, the ninja enemies, the archer and the scenery, plus one per boss. That is fourteen image files.

Each atlas is a sheet of body parts, not animation frames. A table in the code gives every piece its position in the sheet and a pivot point at the joint:

```js
const PARTS={
  torso   :[  0,  0,186,377, .50,.07],
  head    :[311,  0,175,201, .46,.90],
  katana  :[  0,520,498, 34, .055,.55]
  // ...
};
```

The numbers are atlas x, atlas y, width, height, then pivot x and y as fractions of the piece. The pivot is the shoulder on an arm, the neck on a head, the grip on the katana. The game already had a procedural skeleton that animates the characters, so the painted pieces are drawn onto that skeleton and rotate around their joints. Walk cycles, attacks and recoils all come from code that existed before the art did.

Every character also has a fully procedural drawing path in the file. The atlas loader tries a list of paths and, if none load, it logs one line and leaves that character procedural:

```js
function _loadAtlas(list,onReady,label){
  let i=0;
  const next=()=>{
    if(i>=list.length){
      console.log('[parts] no '+label+' atlas found, using procedural drawing');
      return;
    }
    const src=list[i++],im=new Image();
    im.onload=()=>{onReady(im);console.log('[parts] '+label+' atlas loaded from '+src);};
    im.onerror=next;
    im.src=src;
  };
  next();
}
```

Because each atlas loads on its own, a painted player could fight procedural enemies while art arrived one character at a time. A missing file is a normal state, not a crash.

That fallback list cost me something. Each atlas originally tried a `sprites/` folder before the site root, but the files lived at the root, so every atlas waited on a 404 first on every visit. Three sprite sheets that were never made were also being requested on every visit. The fix was to try the root first and put the unused sheets behind a `SHEETS_ENABLED = false` flag.

## Audio: a soundtrack with no audio files

There are no music files. The soundtrack is generated live with the Web Audio API. Every track is written in the miyako-bushi scale (D, E flat, G, A, B flat), a five-note scale used in a lot of koto and shamisen music:

```js
const ROOT=146.83;                 // D3
const SCALE=[0,1,5,7,8];           // miyako-bushi
```

Each instrument is a small function built from oscillators, filters and noise. A koto pluck, a shamisen, a breathy shakuhachi with delayed vibrato, a taiko that is a sine wave dropping in pitch plus a burst of filtered noise, and a low pad. A melody function walks up and down the scale instead of jumping randomly.

Timing uses a lookahead scheduler. A `setInterval` runs every 25 ms and queues notes about 150 ms ahead on the audio clock. Notes are scheduled against `AudioContext.currentTime`, not against the game loop, so the music stays in time even when a frame hitches. There are menu, stage and boss themes, and the boss theme speeds up and adds drums when a boss enters Phase II.

Sound effects work the same way: short synthesized tones, no samples.

## Saves: localStorage, with a cloud option

Progress saves without an account. The core save is one JSON object in `localStorage` under the key `sv5`: highest stage, coins, upgrade levels, difficulty, sword style and premium status. Settings, stats, daily challenges and achievements each get their own key.

Every read and write is wrapped in `try/catch`. Storage can throw in private browsing or when site data is blocked, and a save failure should never stop the game. The loader also falls back to the older `sv4` key, so players from an earlier version kept their progress.

Signing in is optional. When a player does, progress syncs through Firebase Firestore, and the same account puts them on the leaderboard. The Firebase SDK loads from Google's CDN, which is another thing outside the one file.

## The counter: knowing if anyone played

This was the piece I needed most and expected least. Firebase Analytics only starts after a visitor accepts the consent banner, which is a small share of visitors. Netlify counts HTTP requests, and since the whole game is one page, a three-second bounce and a forty-minute session look the same there. Neither could tell me whether anyone actually played.

So I wrote a small counter. The page sends plain event names, like `arrived`, `start`, `s_clear` with a stage number, `death`, `quit`, and each tutorial step. A Netlify function adds them to daily integer totals in Firestore. No cookies, no identifier, no IP, nothing written to the device, and the function only accepts event names on an allowlist so nobody can grow the data with junk.

On the client, events are batched on a 1.2 second timer and sent with `navigator.sendBeacon` as `text/plain`, which avoids a CORS preflight. The queue is flushed on `pagehide`, because a phone can background the page at any moment. The `arrived` event only fires once the page is visible, because some apps preload links in the background and were inflating the count.

## The tradeoffs

Honestly, here is what one file costs.

**Every change ships the whole game.** Fixing one typo means a new 600 KB page. The server is set to `no-cache` so browsers check for a new version on every visit, but an unchanged page now costs a 304 instead of a full download. Hosting bandwidth is metered, so this mattered.

**It is not truly one file.** The art is fourteen PNGs. Payments and the counter run in Netlify functions. Firebase comes from a CDN. "One file" really means one file of game code.

**Navigation is hard.** At 8,700 lines, finding things means searching, not browsing. Some bugs came from two parts of the file that had to agree and drifted apart, like a hit box defined in one place and the slash drawn from different numbers in another.

**Errors are global.** With one hand-written loop, one thrown error in drawing code used to stop the whole game. The loop now wraps draw and update in separate `try` blocks so a bad frame stays one bad frame.

What it gave me was a game that starts from a link on any device, with nothing to install and no toolchain between me and the code. For a first game, that was the right trade.

Play it at https://samuraivengeance.com
