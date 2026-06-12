---
title: Understanding the Navigator
description: Every line, label and panel on your chart explained — the channel, the moving averages, the label glossary and the settings worth knowing.
order: 1
category: understand
---

This is your reference manual for the chart. Once the Navigator is attached, the screen fills with lines, labels and panels. This page explains what each one means. When you're ready to trade with them, move on to [Trading strategies](/learn/trading-strategies).

## What you see on the chart

With the Navigator attached, your chart shows:

- **The current channel** — a sloped price channel made of a resistance line on top, a support line at the bottom, and a middle line halfway between them.
- **The previous channel** — the channel that was in force before the latest one formed, shown faded. Handy for reference once a new channel starts.
- **Extended lines** — an extended resistance line above the channel and an extended support line below it. These mark the next levels if price overshoots the channel.
- **Two moving averages** — the 9 MA (faster) and the 30 MA (slower).
- **Two information panels** — Trend Analysis at the top and Channel Levels at the bottom. Both can be hidden.
- **Labels** — letters printed on the bars as things happen: support and resistance hits, buy and sell signals, breakouts, and markers showing where a new channel began.

## The channel lines

- **Resistance** — the top of the channel. When price reaches it, price is expected to fall.
- **Support** — the bottom of the channel. When price reaches it, price is expected to rise.
- **Middle** — halfway between support and resistance. This is the first take-profit reference in the strategies.
- **Extended resistance** — the next resistance above the channel, used when price overshoots the top.
- **Extended support** — the next support below the channel, used when price overshoots the bottom.

If price keeps overshooting, a second extended line can appear — **ES2** (a second extended support, further down) or **ER2** (a second extended resistance, further up).

### The green "good channel"

When the channel is drawn in green, the Navigator is telling you it's a good channel — one that's capturing the trend well. Think of it as a quick confidence check: green means the channel is reliable right now.

### Half channel width

One measurement comes up again and again in the strategies: the **half channel width**, or HCW. It's the distance from the middle line to either the support or the resistance line.

An example: if the middle line is at 200 and support is at 100, the half channel width is 100 points. When a strategy rule says "50% of the width", it means 50% of this half channel width — 50 points in that example.

## The two moving averages

A moving average is a line that smooths out the price by averaging the last several bars, so you can see the direction without the wobble.

- **9 MA** — the faster of the two, averaging the last 9 bars. It drives the "MA 9 take-profit" rule used throughout the strategies.
- **30 MA** — the slower one, averaging the last 30 bars. It gives you the broader trend.

## The labels, one by one

Labels print on the bars as events trigger. Each is a short code, and the colour tells you which side it's on. One thing to watch: **S** and **ES** appear on both the support side (teal) and the sell side (red), so the colour matters.

On the support and resistance side:

- **R** — resistance hit (maroon)
- **ER** — extended resistance hit (dark maroon)
- **MR** — middle resistance, shown as a small dot marker
- **S** — support hit (teal)
- **ES** — extended support hit (teal)
- **MS** — middle support, shown as a small dot marker

The trade signals:

- **B** — buy signal (blue)
- **EB** — extended buy signal (blue)
- **DTB** — downtrend breakout, a buy cue (blue)
- **S** — sell signal (red)
- **ES** — extended sell signal (red)
- **UTB** — uptrend breakdown, a sell cue (red)

And the trend markers:

- **UTA** — uptrend accelerates (cyan)
- **DTA** — downtrend accelerates (purple)
- **NC** — new channel formed (grey)

### The finer points

- **A hit is not a signal.** A hit (R, S, ER, ES) marks price reaching a level. A signal (B, EB, or the red S and ES) is the actual entry cue that follows when price reacts to that level.
- **Extended signals need a second hit.** An extended buy (EB) only prints after the extended support line is hit a *second* time and price rebounds. The same goes for the sell side. These are the higher-probability signals.
- **MS and MR are quiet markers.** Every other label fires a Telegram signal — the middle markers don't. You can switch them off in the settings.
- **NC shows where the channel began.** Everything to the right of the NC marker belongs to the current channel; everything to its left was the previous one.

### Looking back at older channels

To see an older channel and the signals that fired on it, use TradingView's **Bar Replay** tool in the top panel. Set the blue bar-selector to the bar just before the NC marker, and the chart redraws the previous channel with all its labels.

## The two panels

### Channel Levels panel

This panel lists the exact prices of the levels on the latest bar, in two columns: the current channel and the previous channel. You'll see resistance (R), middle (M), support (S), extended resistance (ER), extended support (ES), and a second extended support (ES2) where one exists.

A practical use: if a new channel forms while you still hold an open position, read the *previous* channel's levels for your exit references.

### Trend Analysis panel

This one tells you two things about the current channel:

- **Trend direction** — uptrend, sideways, or downtrend.
- **Width** — how wide the channel is compared with the market's normal movement. It's expressed as a multiple of the Average True Range, so you might see "Wide (12.1x ATR)". The bigger the number, the wider the channel relative to how much price usually moves.

## Settings worth knowing

Hover over the indicator's name at the top-left of the chart and click the gear icon. A few useful toggles:

- **Top and bottom panels** — tick or untick to show or hide the two panels. Useful on your phone, where they can cover the chart. The redraw takes a moment.
- **MS / MR labels** — switch the middle markers on or off.
- **Buy and sell zone lines** — optional lines drawn at the entry zones the strategies use: 50% from support or resistance for the normal entries, and 35% from the extended lines for the extended entries.

## Reading the bars

You can set your chart style in TradingView — the strategy examples use bars. On a single bar, the left tick is the opening price, the right tick is the closing price, and the top and bottom are the high and low. This matters because several strategy rules depend on a bar *closing* above or below a line or a moving average.

## A few practical notes

- The Navigator takes 10 to 20 seconds to load — three dots appear next to its name while it works. A paid TradingView plan loads faster and pulls in more history, which produces a better channel.
- **Labels showing but no channel lines?** Scroll or zoom the chart to the left until the channel's starting point (its NC marker) is on screen. TradingView only draws the lines once that bar is visible. Very common, and not a fault.
- An exclamation mark on the indicator means it's attached to a market that isn't in your plan.
- After an indicator update, remove the Navigator and attach it again to be safe. Any personal alerts you've built won't update themselves either; delete them and set them up again.
