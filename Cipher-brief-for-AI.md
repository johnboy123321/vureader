# Brief: help me find an edge for a crypto trading bot

Paste this whole document into the AI. Every number below was measured on my own data, not taken from theory.

## What I want from you

I want IDEAS, not a review of my code. Give me up to five ideas for a source of edge, then rank them by how cheaply I can disprove them. For each idea:

1. The hypothesis in one or two sentences, and why it should work.
2. The information it uses. I have already exhausted rearranging candle-based indicators (see "Ruled out"), so I am looking for NEW INFORMATION or a different bet structure.
3. Whether the data is free and historical, and where to get it. If you are not sure a source exists, say so.
4. How I would test it cheaply on three years of data, and what result would kill the idea.
5. How many trades a year it needs. Fees are a hard limit for me (see "Costs"), so an idea that needs many trades has to be much better than one that needs few.

Rules for your answer: say when you are guessing, do not quote figures you cannot source, and skip generic advice such as "add a stop loss" or "manage risk". I already have both. Finish by telling me which idea you are LEAST sure about.

## Who and what

I am a solo builder, based in the UK, building this with AI help. Everything runs on the Phemex TESTNET, so no real money is at risk yet, and the account is small. (Bybit is not available to me in the UK.)

The bot is a Node.js script run by GitHub Actions. It scans 20 coins per run from a rotating universe of 100, on 15m, 30m, 1H, 4H and 1D bars, and places perpetual-futures orders directly via signed Phemex API calls. Risk is about £10 a trade. Every trade has a stop from chart structure (at least 2.2% wide) and a target at 2.25R, where R is the distance to the stop. A separate app scans the top 100 coins and only alerts.

## The setups the bot trades (all from one coin's candles)

- Confluence score: daily and 4H trend agree, plus a 1H WaveTrend cross, money flow, extreme overbought/oversold and RSI. Fires at score 6 or more.
- Class A Divergence: price makes a new high or low, WaveTrend does not follow, then a WaveTrend cross confirms.
- Momentum Rollover: WaveTrend cross in the extreme zone (or mid-range if it agrees with the 50 EMA), with VWAP wave and money flow agreeing.
- Green Dot MF Reversal: oversold WaveTrend bull cross with money flow turning up. Long only, almost never fires.

WaveTrend, money flow and the "dots" are the VuManChu Market Cipher B indicators.

## What has been measured

**3-year replay of the live rules.** 3,229 trades, 25 coins, Aug 2023 to Jul 2026, using 1D/4H/1H bars.

| Stage | Expectancy per trade |
|---|---|
| No costs | +0.127R |
| After slippage | +0.040R |
| After fees and slippage | -0.023R (95% interval -0.108 to +0.061) |

Hit rate 31.7% against a break-even of 32.4%. The equity curve never gets above zero at any point in the three years. Maximum drawdown 241R. The bootstrap probability that the true edge is positive is about 27%.

**Live on testnet, 21 Aug to 19 Sep 2026.** 30 counted trades: 8 wins and 22 losses, net -4.0R, about -0.13R a trade. This is consistent with the replay. It is far too few trades to prove anything either way (a +0.14R edge needs roughly 480 trades to separate from luck).

**Costs are the binding constraint.** Phemex taker fee is about 0.06% each side. Because size is risk divided by stop distance, cost in R is roughly (2 x fee %) / stop %. In the replay, fees (0.062R a trade) were larger than the gross edge left after slippage (0.040R), and fees ran about 2.2 times gross profit.

**Signals do carry information.** Trading BTC 1H dots (red dot sells, green dot buys back), Jan 2025 to Aug 2026, measured in bitcoin units:

| Timeframe | Round trips | No fees | At 1 bp a side (maker) | At 10 bps a side |
|---|---|---|---|---|
| 5m | 16,730 | +10.9% | -96.1% | -100% |
| 1H | 1,394 | +38.2% | +4.6% | -91.5% |

The gross signal is positive at every timeframe from 5m to 1D, and fees destroy it.

**Findings that survived checking.**
- The confluence path is a real loser: -£0.74 a trade over 940 trades, interval excludes zero.
- Shorts lost overall (-£0.70 a trade over 1,505) but by year they were -0.65R (2023), -0.23R (2024), -0.01R (2025), +0.11R (2026), which looks like a bull market effect rather than a broken short side.
- 1D shorts: every one of 19 distinct setups hit its stop live, confirmed 78 of 78 at finer resolution.
- The exit multiple was swept from 0.5R to 6R: 2.25R is already the optimum.

## Ruled out (please do not suggest these)

- Regime gating (failed split-half), multi-timeframe agreement (predicts nothing), RSI, MACD and EMA-family filters (negative).
- Sizing or ranking by a quality score (the score ranks nothing), trading 5m or 15m (cannot pay costs), reducing size in high volatility (backwards for me: quiet coins are the ones that cannot pay their fees).
- More oscillator settings and pattern arrangements: my discovery lab searched 520 variants over 22 coins with an out-of-sample gate and found zero survivors.
- Forcing early exits or time stops (worse in the replay; a small live sample disagreed, so unresolved).
- Post-only maker entries as a cure: live results were roughly neutral (maker -0.28R against taker -0.23R, about 6% never filled).
- Relative strength as a FILTER: it swung +£2.49 a trade gross in the replay but failed forward (every live bucket negative).
- Funding rate as a PREDICTOR of price: tested, mostly nothing.
- Selling into pumps to accumulate bitcoin: units are down about 11% since 18 Aug while BTC rose about 25%, and a 14.5-year test also lost units to simply holding.
- A separate 19,299-trade replay of a "trend continuation with pullback" design: every variant lost to simply holding the same position. The only positive variant (+£0.10 a trade) had an interval from -1.03 to +1.23 and its two halves disagreed.

## Data I have

Free, public, in a GitHub repo (raw files, no login):

- Binance USD-M perpetual futures bars for 25 coins (BTC ETH SOL XRP BNB DOGE ADA LINK AVAX DOT LTC BCH UNI ATOM NEAR APT ARB OP SUI TON TRX POL FIL INJ AAVE), 1D, 4H and 1H, Aug 2023 to Jul 2026, with no gaps.
- Funding rate settlements for the same coins and period. Average annualised funding is about +7.3% for BTC, and ranges from -2.8% (BCH) to +9.1% (ARB) across the 25.
- A replay engine (engine.mjs) that evaluates a setup written as data, meaning a list of named conditions, over these bars. My separate replay harness adds a 0.22% round-trip cost, assumes the stop is hit first when a bar contains both levels, and scores every result against simply holding the same position. That harness is not in the repo yet.

I do NOT have: order book depth or spread, open interest, liquidations, spot-perp basis, on-chain or stablecoin flows, or any sentiment data. Tell me which of these have free historical data.

Links:
- https://raw.githubusercontent.com/johnboy123321/vureader/main/backtest-data/manifest.json
- https://raw.githubusercontent.com/johnboy123321/vureader/main/backtest-data/BTC.json.gz (same pattern for each coin)
- https://raw.githubusercontent.com/johnboy123321/vureader/main/engine.mjs
- https://raw.githubusercontent.com/johnboy123321/vureader/main/schema.mjs

## Ideas I already have (untested), so go beyond these or tell me which to do first

1. Signal freshness: expectancy may decay with how long a setup has been true, so take only fresh signals. Cuts trade count.
2. Scale risk to how correlated the market is, not to position count (three signals in a market that moves as one are one bet with three sets of fees).
3. Set the target from each coin's own typical favourable move instead of a fixed 2.25R.
4. Funding carry: hold spot and short the perpetual, delta-neutral, and collect funding as a yield instead of predicting price. Needs a spot leg and margin care.
5. Relative strength as the BET itself: long the strongest coins, short the weakest, market-neutral, low frequency.
6. New information classes, untested for lack of data: order book depth and spread, open interest, cross-coin dispersion, signal clustering, time of day.

## My constraint on your ideas

I am trying to build something new, not repair what I have. I would rather have three ideas I can disprove in an afternoon than one clever idea I cannot test.
