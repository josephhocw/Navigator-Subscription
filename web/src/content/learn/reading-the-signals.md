---
title: Reading the signals
description: What arrives in your Telegram signal group, how each signal is generated, and how to use one properly before you act on it.
order: 4
category: signals
---

Every subscription comes with a private Telegram signal group for each market in your plan. This page explains what lands in that group, how the signals are made, and the right way to use them.

## The two types of signal

1. **Navigator signals** — automated alerts for a set list of popular instruments in each market, around 10 per market, triggered by the indicator's labels.
2. **Robin's personal trades** — Robin's own trade ideas, taken using the Navigator, posted to the group.

## How the signals are generated

- **Every signal comes from the 15-minute timeframe**, using Pepperstone chart data. To see a signal line up on your own chart, switch your chart to 15m.
- **Every label fires a signal except the middle markers** (MS and MR). Support and resistance hits, buy and sell signals, breakouts — they all reach the group.
- **The price quoted is the price at the moment the alert fired.**

That Pepperstone detail matters more than it sounds. A different broker's price feed produces slightly different bars, which means different channels — and the signals won't match what you see. This is why we ask subscribers to chart on Pepperstone data.

## What's inside a signal

A channel buy-zone signal (or extended buy-zone signal) spells out the whole trade for you:

- **Price** — the current price when the alert fired.
- **TP1** — the first take-profit level.
- **TP2** — the second take-profit level.
- **SL** — the stop loss.

![A Telegram message reading USDCHF 15m channel buy signal, with the price, TP1, TP2 and SL](/learn/signals/channel-buy-signal.png)
*A channel buy-zone signal as it lands in the group: entry price, both take-profits and the stop.*

![A Telegram message reading BTCUSD 15m extended channel buy signal](/learn/signals/extended-buy-signal.png)
*The extended version, from the bitcoin topic.*

In other words, the entry zone and the same take-profit and stop structure as the [trading scenarios](/learn/trading-strategies). The sell-zone signals mirror it on the way down.

## Use them properly

**Don't follow signals blindly.** A signal is a prompt to look, not an instruction to trade. Always open the chart and look at the Navigator channel before acting: where price sits in the channel, and whether the trade goes with the trend or against it.

And a practical tip: mute the instrument topics you don't trade. The group covers around 10 instruments per market, and the notifications add up. Muting the ones you ignore keeps the group useful instead of noisy.

![The signal group on a phone, with each instrument as its own topic](/learn/signals/signal-group-topics.png)
*Each instrument is its own topic in the group. Press and hold a topic to mute it.*

## Looking back at older signals

Signals belong to the channel that was live when they fired. To review the signals from a previous channel, use TradingView's Bar Replay to step back to the bar just before the **NC** (new channel) marker — the chart redraws the old channel and its labels. The steps are in [Understanding the Navigator](/learn/understanding-the-navigator).

## Want alerts for other instruments?

Our signal list covers the popular instruments in each market. For anything else, you can build your own alerts in TradingView — sent to your phone or email, on any timeframe you choose. The walkthrough is in [the alerts guide](/guides/set-your-alerts).
