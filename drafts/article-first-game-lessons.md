---
title: What I learned shipping my first game
published: false
description: Concrete lessons from a year of building Samurai Vengeance, a free browser action game, as a solo developer.
tags: gamedev, indiedev, javascript, beginners
---

After the military I wanted to make a living doing something I actually care about. I love tech and I like working with AI agents, and building a game is where those meet. Samurai Vengeance is the first game I have ever made. It is a samurai action platformer that runs in the browser, on a phone or a computer, and I have been working on it for about a year as a one-person studio, Billfiti Studios, in Southern California.

The proudest moment so far was the day it went live and anyone could play it from a link. Most of what I learned came after that day. Here are the lessons that were specific enough to change how I work.

## 1. Your test devices are a blind spot

The game shipped running at double speed on 120Hz phones and 2.4x on 144Hz monitors. Every constant in my update function, gravity, jump velocity, every cooldown, was a per-frame value, and the update ran once per screen refresh. I develop on one phone and one laptop, both 60Hz, so I never saw it.

The fix was a fixed timestep: the simulation always steps at 60 per second, no matter how fast the screen draws. No tuned value had to change.

The lesson is cheap to act on. Before shipping, run the game on at least one high refresh rate screen.

## 2. Read a vague rejection against the written requirements

I found that bug because a game portal rejected the game with one line saying the overall quality did not meet their expectations. My first instinct was that the art was not good enough, and I was ready to redo it.

Instead I went through their published technical requirements line by line. One said mechanics had to perform identically on 60Hz, 144Hz and 165Hz monitors. That was the actual problem. A reviewer on a gaming monitor had opened a game running far too fast.

When feedback is vague, do not assume it means the thing you are already insecure about. Look for the concrete rule you broke.

## 3. Thin sites get judged as thin

When I applied for AdSense, the site was turned down for low value content. A game canvas does not give a reviewer much text to evaluate, and a few short pages around it were not enough.

So I built pages with real depth, written from the game code: a Boss Guide covering all ten bosses, their health and their Phase II changes, an Enemy Guide with health tables and spawn rates, and more dev notes about bugs I fixed. They are useful to players on their own, and they show anyone reviewing the site what it is. Ads in the game stay switched off until access is granted.

## 4. Send first-time players straight into the game

My early flow had a splash screen, then a menu full of choices, then gameplay with timed tips that popped up and disappeared whether or not you had done anything.

Now first-time players go straight into stage 1 on the normal difficulty with an interactive tutorial. Each step waits for you to actually do the thing: move, jump, double jump, defeat an enemy, parry, dash. The parry step fires slow, harmless practice arrows and tells you if you were too early or too late, instead of hoping an enemy wanders close. The wording matches your controls, keyboard or touch, the relevant touch button glows, and a Skip button is always visible.

I also hid the shop offers (Premium, Season Pass, Starter Bundle, referrals) until a player reaches stage 4. Someone on their first minute should be learning to play, not reading prices.

## 5. A single error can freeze everything

A hand-written `requestAnimationFrame` loop only continues because each frame requests the next one on its last line. If anything above that throws, the game stops for good, with no message on screen.

I had two of these. The first boss health bar used the boss's remaining health as a gradient stop, and the Ki special could push health below zero. A negative gradient offset throws, so the game could freeze right as you beat the first boss. The second was a sword skin in a paid bundle that was missing from the renderer's colour table, which would have frozen the game for every single person who bought it. Nobody had bought it yet when I found it.

Now draw and update each sit in their own `try` block inside the loop. A bad frame is one bad frame, and the error still goes to the console.

## 6. Believe players before you can reproduce it

Two of the bugs I wrote up were found by players, not by me. One told me the Ki bar filled just as fast swinging at empty air. The code had a flag recording whether a swing connected, and the reward lines right under it never checked it. Another reported swings that visibly went through enemies and did nothing, worst in mid-air. The hit box and the drawn slash came from two different sets of numbers that had drifted apart.

A player on the r/gamedev Discord also reported that A and D did not move the character, even though the tutorial and How to Play told them to. The movement code only read the arrow keys.

Each of these was obvious once someone said it. I knew how the game was supposed to play, so my eyes filled in the rest.

## 7. Make one thing come from the other

The hit box bug, the Ki bug and the missing skin colours were all the same shape: two pieces of code that were supposed to agree, with nothing checking that they did. Now when I add something that has to match something else, I try to derive one from the other. The hit box is now calculated from the same arc that draws the slash. If the picture changes, the hit area changes with it.

## 8. Measure whether anyone actually plays

My analytics only ran after a visitor accepted the consent banner, and few people do. My host counted page requests, and since the whole game is one page, a three-second visit and a long session looked the same.

So I added a small counter that records plain totals, with no cookies and no identifiers: arrived, started, cleared a stage, died, quit, and each tutorial step. That is how I can see where people stop, which matters more to me than how many arrive.

## What is next

More stages and content for the game, and more work under the Billfiti Studios name. I write up the worst bugs in the dev notes on the site as I find them.

Samurai Vengeance is free to play at https://samuraivengeance.com
