---
title: My browser game ran 2.4x too fast on 144Hz monitors
published: false
description: Per-frame physics constants tied my canvas game's speed to the display refresh rate. A fixed timestep fixed it without retuning anything.
tags: gamedev, javascript, webdev, html5
canonical_url: https://samuraivengeance.com/devlog-120hz-physics-bug
---

I make Samurai Vengeance, a free action platformer that runs in the browser. It is plain JavaScript on an HTML canvas, no engine. For weeks it shipped with a bug that made it run at double speed on most current phones and at 2.4x on a 144Hz gaming monitor. I never saw it, because every screen I tested on ran at 60Hz.

This post covers what the bug was, how I finally found it, and the fix I used, which did not require changing a single tuned value.

## The loop most browser games start with

My original loop had the usual shape:

```js
function loop() {
  draw();
  update();
  requestAnimationFrame(loop);
}
```

`update()` ran once per animation frame. Every number inside it was a per-frame value: gravity `0.57`, jump velocity `-13.5`, friction `0.81`. Every cooldown, every invincibility window and every timer counted down by one per call.

That is correct at 60Hz. The problem is that `requestAnimationFrame` fires at the display's refresh rate, not at 60. Many phones now run at 120Hz, and gaming monitors commonly run at 144Hz or 165Hz. On those screens `update()` is called two or more times as often, so gravity is applied two or more times as often, and so is everything else.

The result is not "a bit snappier". It is a different game:

- Jump arcs change, so gaps tuned for one arc can become impossible to clear.
- Enemy attack timing is compressed.
- The parry window, the core skill in the game, is half as long or shorter in real time.

## Measuring it

Afterwards I measured how many `update()` calls it took for the player to fall 200 pixels. The answer was 25, and it is always 25, because the physics has no concept of time. What that means in seconds depends entirely on the display:

| Refresh rate | Time to fall 200px | Speed |
|---|---|---|
| 60 Hz | 0.42 s | 1x (correct) |
| 120 Hz | 0.21 s | 2x |
| 144 Hz | 0.17 s | 2.4x |
| 165 Hz | 0.15 s | 2.75x |

You can check your own game the same way. Freeze input, call `update()` a fixed number of times, and see how far an object moved. If the distance depends only on the call count and not on elapsed time, your simulation speed is tied to the refresh rate.

The faster check is to run the game on a 120Hz phone next to a 60Hz device. If it looks faster on the newer one, you have this bug.

## How I found it

I did not find it myself. A game portal rejected my submission with one sentence:

> The overall quality of the game does not yet meet the expectations of our platform.

There were no specifics. My first reading was "the game is not good enough", and I started thinking about redoing the art.

Instead I went through the portal's published technical requirements one line at a time, looking for anything concrete I might be failing. One line said game mechanics must perform identically on 60Hz, 144Hz and 165Hz monitors. That was the whole clue.

A reviewer on a high refresh rate monitor would have opened a game running at 2.4x or 2.75x speed. From their side that is a quality problem. It just was not the one I would have guessed.

## The fix: a fixed timestep accumulator

The common advice is to multiply everything by a delta time. That works, but it means touching every tuned constant and rebalancing the whole game. I had combat timing I was happy with and did not want to retune it.

A fixed timestep avoids that. `update()` keeps meaning exactly 1/60 of a second, and the loop calls it the right number of times for the real time that has passed. This is the loop now in the game, with the comments trimmed:

```js
const _STEP = 1000/60;
let _acc = 0, _prevTs = null;

function loop(ts){
  try{ drawBG();drawGame();drawFG(); }
  catch(err){ console.error('[loop] draw error:',err); }

  try{
    if(ts===undefined)ts=performance.now();
    if(_prevTs===null)_prevTs=ts;
    let dt=ts-_prevTs;
    _prevTs=ts;
    if(dt>250)dt=250;
    if(dt<0)dt=0;
    _acc+=dt;
    let steps=0;
    while(_acc>=_STEP && steps<5){ update(); _acc-=_STEP; steps++; }
    if(steps>=5)_acc=0;
  }
  catch(err){ console.error('[loop] frame error:',err); }
  requestAnimationFrame(loop);
}
```

Nothing inside `update()` changed. Gravity is still `0.57`, the jump is still `-13.5`, and cooldowns still count in frames, because one update still represents 1/60 of a second.

Drawing still happens once per animation frame, so a 144Hz screen still renders at 144Hz. Only the simulation is pinned to 60 steps per second.

It also helps slow devices. If a phone only manages 40fps, the accumulator runs `update()` twice on some frames, and the game runs at the correct speed instead of in slow motion.

(The two `try` blocks are there for a separate reason: a single thrown error in the draw code used to stop the loop for good, because the next frame was never requested. That is its own story.)

## Three details that matter

**Clamp the delta.** When a tab is backgrounded and comes back, the delta can be many seconds. Without the `dt > 250` clamp, the loop tries to simulate all of it at once and locks the page.

**Cap the catch-up steps.** If a device truly cannot keep up, an uncapped `while` loop builds a debt it never pays off and the frame rate spirals down. Five steps, then drop the backlog.

**Compare the previous timestamp to `null`, not to falsy.** A timestamp of `0` is a valid value on the first frame. `if (!prev)` treats it as missing.

## What I would do differently

Test on a high refresh rate device before shipping. I developed on one phone and one laptop, both 60Hz, and that blind spot went out to every player with a newer screen.

Also, when a rejection is vague, read the platform's technical requirements before deciding what it means. I was ready to rebuild the art. The actual problem was the game loop.

If you want to see the result, the game is free and runs in the browser: https://samuraivengeance.com
