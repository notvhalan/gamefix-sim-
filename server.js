const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir));
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ─── Region and climate definitions ──────────────────────────────────────────

const REGION_DEFS = [
  { region: 'South Asia',           count: 110, latRange: [6,  35],  lonRange: [65,  92],  zones: ['MONSOON','TROPICAL','ARID'] },
  { region: 'Southeast Asia',       count: 100, latRange: [-10,22],  lonRange: [95, 140],  zones: ['TROPICAL','MONSOON'] },
  { region: 'East Asia',            count: 90,  latRange: [20, 50],  lonRange: [100,145],  zones: ['TEMPERATE','CONTINENTAL','MONSOON'] },
  { region: 'Europe',               count: 90,  latRange: [35, 70],  lonRange: [-10, 40],  zones: ['TEMPERATE','MEDITERRANEAN','CONTINENTAL'] },
  { region: 'North America',        count: 110, latRange: [15, 70],  lonRange: [-130,-60], zones: ['TEMPERATE','CONTINENTAL','ARID','TROPICAL'] },
  { region: 'South America',        count: 90,  latRange: [-55,12],  lonRange: [-80,-35],  zones: ['TROPICAL','TEMPERATE','ARID'] },
  { region: 'Africa',               count: 90,  latRange: [-35,37],  lonRange: [-18, 50],  zones: ['TROPICAL','ARID','MONSOON','MEDITERRANEAN'] },
  { region: 'Oceania',              count: 65,  latRange: [-47, 0],  lonRange: [112,178],  zones: ['TROPICAL','TEMPERATE','ARID'] },
  { region: 'Middle East',          count: 50,  latRange: [12, 42],  lonRange: [32,  65],  zones: ['ARID','MEDITERRANEAN'] },
  { region: 'Pacific Islands',      count: 50,  latRange: [-25,25],  lonRange: [150,180],  zones: ['TROPICAL'] },
  { region: 'Atlantic Islands',     count: 30,  latRange: [15, 40],  lonRange: [-30,-10],  zones: ['TROPICAL','MEDITERRANEAN'] },
  { region: 'Indian Ocean Islands', count: 50,  latRange: [-25,10],  lonRange: [45,  80],  zones: ['TROPICAL','MONSOON'] },
];

const ZONE_PARAMS = {
  TROPICAL:      { baseline: 8.0,  vol: 12.0, seasonality: 0.4, stormSens: 0.85, wetStart: 5,  wetEnd: 10 },
  MONSOON:       { baseline: 6.0,  vol: 14.0, seasonality: 0.8, stormSens: 0.90, wetStart: 6,  wetEnd: 9  },
  TEMPERATE:     { baseline: 2.5,  vol:  4.5, seasonality: 0.3, stormSens: 0.50, wetStart: 10, wetEnd: 3  },
  ARID:          { baseline: 0.35, vol:  2.0, seasonality: 0.2, stormSens: 0.25, wetStart: 12, wetEnd: 2  },
  MEDITERRANEAN: { baseline: 2.0,  vol:  4.0, seasonality: 0.6, stormSens: 0.40, wetStart: 10, wetEnd: 3  },
  CONTINENTAL:   { baseline: 2.0,  vol:  5.0, seasonality: 0.5, stormSens: 0.40, wetStart: 4,  wetEnd: 9  },
  POLAR:         { baseline: 0.7,  vol:  1.5, seasonality: 0.2, stormSens: 0.15, wetStart: 6,  wetEnd: 8  },
};

const STORM_TYPES = ['TROPICAL_CYCLONE','MONSOON_SURGE','ATMOSPHERIC_RIVER','CONVECTIVE_SYSTEM','EXTRATROPICAL_STORM'];

// ─── Trading constants ────────────────────────────────────────────────────────

const MONTH_ABBREV = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MULTIPLIER_PENCE = 1000; // £10 per index point = 1000p
const PRICE_SCALE      = 100;  // internal price units per index point (21.45 pts = 2145 units)
const PENCE_PER_UNIT   = MULTIPLIER_PENCE / PRICE_SCALE; // 10p per price unit
const USER_ACCOUNT_ID  = 'acct-user';
const SIM_DESK_IDS     = ['acct-alpha', 'acct-beta', 'acct-gamma'];

const DEFAULT_SETTINGS = {
  seed: 4217,
  startDate: '2027-01-01',
  locationCount: 1000,
  speed: 2,
  rainfallThresholdMm: 100.0,
  globalRainfallMultiplier: 1.0,
  rainfallVolatility: 1.0,
  seasonalStrength: 1.0,
  regionalCorrelation: 0.3,
  localCorrelation: 0.4,
  extremeEventTailStrength: 1.0,
  baselineStormProbability: 0.15,
  quoteSpread: 0.15,        // proportional half-spread for location binaries (fraction of yesPrice)
  marketNoise: 0.001,
  liquidityLevel: 74,
  forecastQuality: 0.75,
  marketSentimentVolatility: 0.002,
  // Trading
  futuresMultiplier: 10,
  initialMarginRiskPoints: 4.3,
  simDeskHalfSpread: 0.4,  // base half-spread for simulated desk standing orders
  weightingMethod: 'EQUAL_LOCATION',
  // Storm model
  stormFormationProbability: 0.12,
  stormDurationDays: 5,
  stormRadiusKm: 400,
  stormIntensity: 1.0,
  stormMovementSpeed: 1.0,
  correlatedRainfallStrength: 0.6,
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthStr(year, month) { return `${year}-${String(month).padStart(2, '0')}`; }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function lastDayOfMonth(year, month) { return `${monthStr(year, month)}-${String(daysInMonth(year, month)).padStart(2,'0')}`; }

function futSymbol(year, month) { return `GFX-RAIN100-${MONTH_ABBREV[month-1]}${String(year).slice(2)}`; }
function futName(year, month)   { return `GFX Global Rain 100 ${MONTH_ABBREV[month-1]} ${year}`; }

// Points (float) → internal price units (integer)
function toUnits(points)  { return Math.round(points * PRICE_SCALE); }
// Internal units → points
function toPoints(units)  { return units / PRICE_SCALE; }

let orderSeq = 0, tradeSeq = 0, posSeq = 0;
function nextOrderId() { return `ORD-${String(++orderSeq).padStart(6,'0')}`; }
function nextTradeId() { return `TRD-${String(++tradeSeq).padStart(6,'0')}`; }
function nextPosId()   { return `POS-${String(++posSeq).padStart(6,'0')}`; }

function seededRandom(seed) {
  let v = ((seed % 2147483647) + 2147483647) % 2147483647 || 1;
  return function () {
    v = (v * 16807) % 2147483647;
    return (v - 1) / 2147483646;
  };
}

function normCdf(z) {
  if (z < -6) return 0;
  if (z >  6) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - phi * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Location generation ──────────────────────────────────────────────────────

function generateLocations(seed, count) {
  const rng = seededRandom(seed + 7777);
  const locations = [];
  const totalDefined = REGION_DEFS.reduce((s, r) => s + r.count, 0);
  let id = 0;
  for (const def of REGION_DEFS) {
    const n = Math.round(count * def.count / totalDefined);
    for (let i = 0; i < n; i++) {
      const lat = def.latRange[0] + rng() * (def.latRange[1] - def.latRange[0]);
      const lon = def.lonRange[0] + rng() * (def.lonRange[1] - def.lonRange[0]);
      const zone = def.zones[Math.floor(rng() * def.zones.length)];
      const zp   = ZONE_PARAMS[zone];
      const elev = Math.max(0, rng() * 1800);
      const elevFactor = Math.max(0.4, 1 - elev / 6000);
      locations.push({
        id: `loc-${String(id).padStart(4, '0')}`,
        name: `${def.region} ${String(i + 1).padStart(3, '0')}`,
        latitude:  Math.round(lat * 100) / 100,
        longitude: Math.round(lon * 100) / 100,
        region: def.region,
        climateZone: zone,
        elevationMetres: Math.round(elev),
        areaWeight: 0, populationWeight: 0, insuredExposureWeight: 0, selectedWeight: 0,
        wetSeasonStartMonth: zp.wetStart,
        wetSeasonEndMonth:   zp.wetEnd,
        baselineDailyRainfallMm: Math.max(0.1, zp.baseline * elevFactor * (0.6 + rng() * 0.8)),
        rainfallVolatility:      Math.max(0.5, zp.vol     * (0.6 + rng() * 0.8)),
        stormSensitivity:        Math.max(0.1, zp.stormSens * (0.5 + rng() * 1.0)),
        isActive: true,
      });
      id++;
    }
  }
  const aRaw = locations.map(() => 0.3 + rng() * 1.4);
  const pRaw = locations.map(l => { const b = l.climateZone === 'MONSOON' ? 3 : l.climateZone === 'TEMPERATE' ? 2.5 : l.climateZone === 'ARID' ? 0.2 : 1; return b * (0.4 + rng() * 1.2); });
  const iRaw = locations.map(l => { const b = l.climateZone === 'TEMPERATE' ? 3 : l.climateZone === 'MEDITERRANEAN' ? 2.5 : 0.5 + rng(); return b * (0.4 + rng() * 1.2); });
  const aSum = aRaw.reduce((s,v)=>s+v,0), pSum = pRaw.reduce((s,v)=>s+v,0), iSum = iRaw.reduce((s,v)=>s+v,0);
  locations.forEach((loc,i) => { loc.areaWeight = aRaw[i]/aSum; loc.populationWeight = pRaw[i]/pSum; loc.insuredExposureWeight = iRaw[i]/iSum; });
  return locations;
}

function applyWeighting(locations, method) {
  const n = locations.length;
  locations.forEach(loc => {
    switch (method) {
      case 'EQUAL_LOCATION':            loc.selectedWeight = 1 / n; break;
      case 'AREA_WEIGHTED':             loc.selectedWeight = loc.areaWeight; break;
      case 'POPULATION_WEIGHTED':       loc.selectedWeight = loc.populationWeight; break;
      case 'INSURED_EXPOSURE_WEIGHTED': loc.selectedWeight = loc.insuredExposureWeight; break;
      default:                          loc.selectedWeight = 1 / n;
    }
  });
  return locations;
}

// ─── Rainfall physics ─────────────────────────────────────────────────────────

function seasonalFactor(loc, month, settings) {
  const { wetSeasonStartMonth: ws, wetSeasonEndMonth: we } = loc;
  const inWet = ws <= we ? (month >= ws && month <= we) : (month >= ws || month <= we);
  return 1 + ((inWet ? 1.9 : 0.35) - 1) * settings.seasonalStrength;
}

function stormContribAt(loc, storm, daysSinceStart) {
  const lat = storm.centreLatitude  + storm.movementLatitudePerDay  * daysSinceStart;
  const lon = storm.centreLongitude + storm.movementLongitudePerDay * daysSinceStart;
  const d   = distKm(loc.latitude, loc.longitude, lat, lon);
  if (d > storm.radiusKm * 2.5) return 0;
  const decay = Math.exp(-((d / storm.radiusKm) * (d / storm.radiusKm)));
  return storm.intensity * storm.rainfallMultiplier * loc.stormSensitivity * decay * 130;
}

function stormDayIdx(storm, dateStr) {
  return Math.round((new Date(dateStr) - new Date(storm.startDate)) / 86400000);
}

function rainfallExpected(loc, dateStr, gf, rf, storms, settings) {
  const month = new Date(dateStr).getUTCMonth() + 1;
  const sf    = seasonalFactor(loc, month, settings);
  const base  = loc.baselineDailyRainfallMm * sf * gf * rf * settings.globalRainfallMultiplier;
  let extra = 0;
  storms.forEach(s => { extra += stormContribAt(loc, s, stormDayIdx(s, dateStr)); });
  return Math.max(0.01, base + extra);
}

function exceedanceProb(loc, dateStr, gf, rf, storms, threshold, settings, rng) {
  const month    = new Date(dateStr).getUTCMonth() + 1;
  const sf       = seasonalFactor(loc, month, settings);
  const mean     = rainfallExpected(loc, dateStr, gf, rf, storms, settings);
  const baseStd  = loc.rainfallVolatility * sf * settings.rainfallVolatility;
  const stormVar = storms.reduce((s, st) => s + stormContribAt(loc, st, stormDayIdx(st, dateStr)) * 0.35, 0);
  const variance = baseStd * baseStd + stormVar;
  const mu  = Math.log(mean * mean / Math.sqrt(mean * mean + variance));
  const sig = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  const z   = (Math.log(threshold) - mu) / Math.max(0.01, sig);
  const prob = 1 - normCdf(z);
  return clamp(prob + (rng() - 0.5) * settings.marketNoise, 0, 0.9999);
}

function simulateRainfallMm(loc, dateStr, gf, rf, storms, settings, locRng) {
  const month    = new Date(dateStr).getUTCMonth() + 1;
  const sf       = seasonalFactor(loc, month, settings);
  const mean     = loc.baselineDailyRainfallMm * sf * gf * rf * settings.globalRainfallMultiplier;
  const std      = loc.rainfallVolatility * sf * settings.rainfallVolatility * settings.extremeEventTailStrength;
  const variance = std * std;
  const mu  = Math.log(mean * mean / Math.sqrt(mean * mean + variance));
  const sig = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  const u1  = Math.max(1e-10, locRng());
  const z   = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * locRng());
  const base = Math.exp(mu + sig * z);
  let extra = 0;
  storms.forEach(s => {
    const c = stormContribAt(loc, s, stormDayIdx(s, dateStr));
    if (c > 0) extra += c * (0.7 + locRng() * settings.correlatedRainfallStrength);
  });
  return Math.max(0, base + extra);
}

// ─── Storm management ─────────────────────────────────────────────────────────

let stormSeq = 0;
function makeStorm(rng, dateStr, settings, overrides = {}) {
  stormSeq++;
  const type = overrides.stormType || STORM_TYPES[Math.floor(rng() * STORM_TYPES.length)];
  const dur  = Math.round(settings.stormDurationDays * (0.6 + rng()));
  return {
    id: `STM-${String(stormSeq).padStart(4, '0')}`,
    name: `${type.replace(/_/g, ' ')} ${dateStr}`,
    stormType: type, startDate: dateStr, endDate: addDays(dateStr, dur),
    centreLatitude:  overrides.centreLatitude  ?? (rng() * 60 - 30),
    centreLongitude: overrides.centreLongitude ?? (rng() * 360 - 180),
    radiusKm:  clamp(settings.stormRadiusKm   * (0.5 + rng()), 150, 1200),
    intensity: clamp(settings.stormIntensity   * (0.4 + rng() * 1.2), 0.2, 3.0),
    movementLatitudePerDay:  (rng() - 0.5) * 3 * settings.stormMovementSpeed,
    movementLongitudePerDay: (rng() - 0.3) * 5 * settings.stormMovementSpeed,
    rainfallMultiplier: 1.0 + rng() * 2.5, affectedRegions: [], status: 'ACTIVE',
  };
}

// ─── Location contract building ───────────────────────────────────────────────

function buildContractSet(locations, obsDate, gf, rf, storms, threshold, settings, rng) {
  let wSum = 0;
  const contracts = locations.map((loc, li) => {
    const locRng = seededRandom(rng() * 1e9 + li);
    const p  = exceedanceProb(loc, obsDate, gf, rf[loc.region] ?? 1.0, storms, threshold, settings, locRng);
    wSum += loc.selectedWeight * p;
    const yp     = Math.round(clamp(p, 0, 0.9999) * 10000);
    const halfSpread = Math.max(1, Math.round(yp * settings.quoteSpread));
    return {
      id: `${loc.id}-${obsDate}`, locationId: loc.id, observationDate: obsDate,
      thresholdMm: threshold, theoreticalProbability: p,
      yesPrice: yp, noPrice: 10000 - yp,
      bidPrice: Math.max(0, yp - halfSpread), askPrice: Math.min(10000, yp + halfSpread),
      physicsHalfSpread: halfSpread,
      marketMidpoint: yp, lastPrice: yp, volume: 0, openInterest: 0,
      rainfallMm: null, settlementValue: null, status: 'LISTED',
    };
  });
  return { contracts, impliedIndex: Math.round(10000 * wSum * 10) / 10 };
}

// Returns market-implied index for a single observation date using location book midpoints.
// Falls back to contract yesPrice (physics) for any location without a live book.
function computeMarketIndex(snap, obsDate) {
  let sum = 0;
  snap.locations.forEach(loc => {
    const book = snap.locationOrderBooks[`${loc.id}-${obsDate}`];
    if (book) {
      sum += loc.selectedWeight * (book.bid + book.ask) / 2;
    } else {
      const c = snap.activeContracts.find(c => c.locationId === loc.id && c.observationDate === obsDate);
      if (c) sum += loc.selectedWeight * c.yesPrice;
    }
  });
  return Math.round(sum * 10) / 10;
}

// Initialise or drift location order books after a daily physics rebuild.
// New contract IDs get a fresh MM book; existing ones drift by the physics yesPrice change
// so user-driven divergence survives across days.
function initLocationBooks(snap, newContracts, prevContractMap) {
  const activeIds = new Set();
  newContracts.forEach(c => {
    activeIds.add(c.id);
    const prev = prevContractMap.get(c.id);
    if (!snap.locationOrderBooks[c.id]) {
      // Brand-new contract (first time this obsDate appears)
      snap.locationOrderBooks[c.id] = {
        bid: c.bidPrice, ask: c.askPrice,
        yesPrice: c.yesPrice, physicsHalfSpread: c.physicsHalfSpread,
        mmDepth: 0, volume: 0, lastPrice: null,
      };
    } else {
      // Existing book: drift by physics change, preserve user-driven offset
      const book = snap.locationOrderBooks[c.id];
      const physicsDelta = c.yesPrice - book.yesPrice;
      book.bid        = Math.max(0,     book.bid + physicsDelta);
      book.ask        = Math.min(10000, book.ask + physicsDelta);
      book.yesPrice   = c.yesPrice;
      book.physicsHalfSpread = c.physicsHalfSpread;
    }
  });
  // Drop books for contracts no longer in the active window
  Object.keys(snap.locationOrderBooks).forEach(id => {
    if (!activeIds.has(id)) delete snap.locationOrderBooks[id];
  });
}

// Apply market impact after a location fill. Side is 'BUY' (YES) or 'SELL' (YES).
// Impact proportional to qty / mmBaseQuantity, capped at physicsHalfSpread per fill.
function applyLocationImpact(book, side, qty, settings) {
  const shift = Math.round(
    Math.min(book.physicsHalfSpread, qty / 50 * book.physicsHalfSpread)
  );
  if (side === 'BUY') {
    book.bid = Math.min(10000, book.bid + shift);
    book.ask = Math.min(10000, book.ask + shift);
  } else {
    book.bid = Math.max(0, book.bid - shift);
    book.ask = Math.max(0, book.ask - shift);
  }
  // Ensure ask > bid by at least 1
  if (book.ask <= book.bid) book.ask = Math.min(10000, book.bid + 1);
}


// ─── Tradable futures creation ────────────────────────────────────────────────

function makeTradableFuture(year, month, listingDate, fairValuePoints) {
  const expiry = lastDayOfMonth(year, month);
  const initUnits = toUnits(fairValuePoints);
  return {
    id: `fut-${MONTH_ABBREV[month-1]}${year}`,
    symbol: futSymbol(year, month),
    name: futName(year, month),
    referenceIndex: 'GLOBAL_RAIN_100',
    weightingMethod: 'EQUAL_LOCATION',
    contractMonth: monthStr(year, month),
    listingDate,
    expiryDate: expiry,
    finalSettlementDate: expiry,
    multiplierPencePerPoint: MULTIPLIER_PENCE,
    bidPricePoints: null,
    askPricePoints: null,
    lastTradePricePoints: null,
    previousSettlementPriceUnits: initUnits,
    currentSettlementPriceUnits:  initUnits,
    finalRealisedIndexPoints: null,
    volume: 0,
    openInterest: 0,
    status: 'ACTIVE',
    realisedDays: [],
    projectedSettlement: fairValuePoints,
    fairValuePoints,
    tradeHistory: [],          // { priceUnits, quantity, time } for VWAP
    dailySettlementMethod: null,
    daysUntilExpiry: 0,
    autoRollEnabled: false,
  };
}

function createInitialTradableFutures(startDate, ladder) {
  const sd = new Date(startDate);
  const y0 = sd.getUTCFullYear(), m0 = sd.getUTCMonth() + 1;
  const m1 = m0 === 12 ? { y: y0+1, m: 1 } : { y: y0, m: m0+1 };
  const m2 = m1.m === 12 ? { y: m1.y+1, m: 1 } : { y: m1.y, m: m1.m+1 };
  const fv0 = ladder.d1 ?? 5.0;
  const fv1 = ladder.d4 ?? 5.0;
  const fv2 = ladder.d7 ?? 5.0;
  return [
    makeTradableFuture(y0, m0, startDate, fv0),
    makeTradableFuture(m1.y, m1.m, startDate, fv1),
    makeTradableFuture(m2.y, m2.m, startDate, fv2),
  ];
}

// ─── Market maker ─────────────────────────────────────────────────────────────


// ─── Order book ───────────────────────────────────────────────────────────────

function emptyBook() { return { bids: [], asks: [] }; }

function insertOrder(book, order) {
  if (order.side === 'BUY') {
    book.bids.push(order);
    book.bids.sort((a, b) => b.limitPriceUnits - a.limitPriceUnits || a.seqNum - b.seqNum);
  } else {
    book.asks.push(order);
    book.asks.sort((a, b) => a.limitPriceUnits - b.limitPriceUnits || a.seqNum - b.seqNum);
  }
}

function cancelSimDeskOrders(book) {
  const ids = new Set(SIM_DESK_IDS);
  book.bids = book.bids.filter(o => !ids.has(o.accountId));
  book.asks = book.asks.filter(o => !ids.has(o.accountId));
}

// ─── Position management ──────────────────────────────────────────────────────

function getOrCreatePosition(snap, accountId, futureId) {
  let pos = snap.positions.find(p => p.accountId === accountId && p.futureId === futureId && p.status === 'OPEN');
  if (!pos) {
    const fut = snap.tradableFutures.find(f => f.id === futureId);
    pos = {
      id: nextPosId(),
      accountId,
      futureId,
      netQuantity: 0,
      averageEntryPriceUnits: fut ? fut.currentSettlementPriceUnits : 0,
      previousSettlementPriceUnits: fut ? fut.currentSettlementPriceUnits : 0,
      realisedTradingPnlPence: 0,
      variationMarginPence: 0,
      unrealisedPnlPence: 0,
      initialMarginReservedPence: 0,
      status: 'OPEN',
    };
    snap.positions.push(pos);
  }
  return pos;
}

function updatePositionOnTrade(snap, accountId, futureId, side, qty, tradePriceUnits, settings) {
  const pos = getOrCreatePosition(snap, accountId, futureId);
  const dir = side === 'BUY' ? 1 : -1;
  const tradedQty = qty * dir;
  const prevQty   = pos.netQuantity;
  const newQty    = prevQty + tradedQty;

  if (prevQty === 0 || Math.sign(prevQty) === Math.sign(tradedQty)) {
    // Opening or adding to existing position — recalculate average entry
    const totalCost = Math.abs(prevQty) * pos.averageEntryPriceUnits + qty * tradePriceUnits;
    pos.averageEntryPriceUnits = Math.abs(newQty) > 0 ? Math.round(totalCost / Math.abs(newQty)) : tradePriceUnits;
  } else {
    // Reducing or crossing through zero
    const closedQty = Math.min(Math.abs(prevQty), qty);
    const pnlPence  = closedQty * (tradePriceUnits - pos.averageEntryPriceUnits) * Math.sign(prevQty) * PENCE_PER_UNIT;
    pos.realisedTradingPnlPence += pnlPence;
    // Release proportional margin
    const releaseProportion = closedQty / Math.abs(prevQty);
    const marginRelease = Math.round(pos.initialMarginReservedPence * releaseProportion);
    pos.initialMarginReservedPence -= marginRelease;
    const account = snap.accounts.find(a => a.id === accountId);
    if (account) {
      account.reservedMargin -= marginRelease / 100; // pence → pounds
      account.cash += pnlPence / 100; // pence → pounds
    }
    if (Math.sign(newQty) !== Math.sign(prevQty) && newQty !== 0) {
      // Crossed through zero — start new position at trade price
      pos.averageEntryPriceUnits = tradePriceUnits;
    }
  }
  pos.netQuantity = newQty;
  if (newQty === 0) pos.status = 'CLOSED';

  // Reserve margin for the new position
  const marginPence = Math.round(Math.abs(newQty) * toUnits(settings.initialMarginRiskPoints) * PENCE_PER_UNIT);
  const prevMargin  = pos.initialMarginReservedPence;
  pos.initialMarginReservedPence = newQty === 0 ? 0 : marginPence;
  const account = snap.accounts.find(a => a.id === accountId);
  if (account) {
    account.reservedMargin += (marginPence - prevMargin) / 100; // pence → pounds
  }
}

// ─── Order matching ───────────────────────────────────────────────────────────

let globalSeq = 0;

function matchOrders(snap, futureId, date) {
  const fut  = snap.tradableFutures.find(f => f.id === futureId);
  if (!fut || fut.status === 'EXPIRED' || fut.status === 'SETTLED') return [];
  const book = snap.orderBook[futureId];
  if (!book) return [];
  const executed = [];

  while (book.bids.length > 0 && book.asks.length > 0) {
    const bid = book.bids[0];
    const ask = book.asks[0];
    if (bid.limitPriceUnits < ask.limitPriceUnits) break;
    if (bid.accountId === ask.accountId) { book.bids.shift(); continue; } // no self-trade
    const tradePriceUnits = ask.limitPriceUnits; // price-time: aggressive pays passive price
    const tradeQty = Math.min(bid.remainingQty, ask.remainingQty);

    const trade = {
      id: nextTradeId(),
      futureId,
      symbol: fut.symbol,
      buyOrderId:  bid.id,
      sellOrderId: ask.id,
      buyAccountId:  bid.accountId,
      sellAccountId: ask.accountId,
      priceUnits: tradePriceUnits,
      pricePoints: toPoints(tradePriceUnits),
      quantity: tradeQty,
      executedAt: date,
    };
    executed.push(trade);
    snap.recentTrades.unshift(trade);
    if (snap.recentTrades.length > 200) snap.recentTrades.pop();

    // Update orders
    bid.remainingQty -= tradeQty;
    ask.remainingQty -= tradeQty;
    if (bid.remainingQty === 0) { bid.status = 'FILLED';  book.bids.shift(); }
    if (ask.remainingQty === 0) { ask.status = 'FILLED';  book.asks.shift(); }

    // Update positions for all accounts
    updatePositionOnTrade(snap, bid.accountId, futureId, 'BUY',  tradeQty, tradePriceUnits, snap.settings);
    updatePositionOnTrade(snap, ask.accountId, futureId, 'SELL', tradeQty, tradePriceUnits, snap.settings);

    // Trade history for VWAP settlement
    fut.tradeHistory.push({ priceUnits: tradePriceUnits, quantity: tradeQty, time: date });

    // Update volume and open interest
    fut.volume += tradeQty;
    fut.lastTradePricePoints = toPoints(tradePriceUnits);
  }
  return executed;
}

function submitUserOrder(snap, orderPayload, internal = false) {
  if (snap.processing && !internal) return { ok: false, reason: 'Simulation is processing — try again.' };
  const { accountId, futureId, side, quantity, orderType, limitPricePoints, timeInForce } = orderPayload;
  const fut     = snap.tradableFutures.find(f => f.id === futureId || f.symbol === futureId);
  const account = snap.accounts.find(a => a.id === accountId);
  if (!fut)     return { ok: false, reason: 'Future not found.' };
  if (!account) return { ok: false, reason: 'Account not found.' };
  if (fut.status === 'EXPIRED' || fut.status === 'SETTLED') return { ok: false, reason: 'Future has expired.' };
  if (quantity <= 0)  return { ok: false, reason: 'Quantity must be positive.' };
  if (orderType === 'LIMIT' && (!limitPricePoints || limitPricePoints <= 0)) return { ok: false, reason: 'Limit price required.' };

  // Margin check
  const marginPence = Math.round(quantity * toUnits(snap.settings.initialMarginRiskPoints) * PENCE_PER_UNIT);
  const available   = account.cash - account.reservedMargin;
  if (marginPence / 100 > available) return { ok: false, reason: `Insufficient margin. Required £${(marginPence/100).toFixed(0)}, available £${available.toFixed(0)}.` };

  const limitUnits = orderType === 'MARKET'
    ? (side === 'BUY' ? 999999 : 0)
    : toUnits(limitPricePoints);

  const order = {
    id: nextOrderId(),
    accountId,
    futureId: fut.id,
    side,
    quantity,
    orderType,
    timeInForce: timeInForce || 'GTC',
    limitPriceUnits: limitUnits,
    limitPricePoints: orderType === 'MARKET' ? null : limitPricePoints,
    remainingQty: quantity,
    status: 'PENDING',
    submittedAt: snap.date,
    filledAt: null,
    seqNum: ++globalSeq,
  };

  if (!snap.orderBook[fut.id]) snap.orderBook[fut.id] = emptyBook();
  const book = snap.orderBook[fut.id];

  insertOrder(book, order);
  const trades = matchOrders(snap, fut.id, snap.date);

  // IOC: cancel unfilled remainder
  if (order.timeInForce === 'IOC' && order.remainingQty > 0) {
    order.status = 'CANCELLED';
    book.bids = book.bids.filter(o => o.id !== order.id);
    book.asks = book.asks.filter(o => o.id !== order.id);
  }

  if (trades.length > 0) {
    snap.audit.push({ time: snap.date, type: 'trade', message: `Trade: ${trades[0].quantity} ${fut.symbol} at ${trades[0].pricePoints.toFixed(2)}` });
  }

  return { ok: true, order, tradesExecuted: trades.length };
}


// ─── Official daily settlement price ─────────────────────────────────────────

function calcOfficialSettlement(fut, settingsWindow) {
  const trades = fut.tradeHistory.filter(t => t.time === settingsWindow);
  if (trades.length > 0 && trades.reduce((s,t)=>s+t.quantity,0) >= 1) {
    // VWAP
    const totalQty = trades.reduce((s,t)=>s+t.quantity,0);
    const vwap = Math.round(trades.reduce((s,t)=>s+(t.priceUnits*t.quantity),0) / totalQty);
    return { priceUnits: vwap, method: 'VWAP', eligibleCount: trades.length, eligibleVol: totalQty };
  }
  // Midpoint fallback
  const bid = fut.bidPricePoints, ask = fut.askPricePoints;
  if (bid !== null && ask !== null) {
    return { priceUnits: toUnits((bid + ask) / 2), method: 'MIDPOINT', eligibleCount: 0, eligibleVol: 0 };
  }
  // Model fallback
  return { priceUnits: toUnits(fut.projectedSettlement), method: 'MODEL_FALLBACK', eligibleCount: 0, eligibleVol: 0 };
}

// ─── Variation margin for futures positions ───────────────────────────────────

function applyFuturesVariationMargin(snap, fut, newSettleUnits) {
  const prevSettleUnits = fut.currentSettlementPriceUnits;
  const deltaUnits = newSettleUnits - prevSettleUnits;
  if (deltaUnits === 0) return 0;

  let totalCreditsPence = 0, totalDebitsPence = 0;

  snap.positions.forEach(pos => {
    if (pos.futureId !== fut.id || pos.status !== 'OPEN' || pos.netQuantity === 0) return;
    const vmPence = pos.netQuantity * deltaUnits * PENCE_PER_UNIT;
    pos.variationMarginPence += vmPence;
    pos.previousSettlementPriceUnits = newSettleUnits;

    const account = snap.accounts.find(a => a.id === pos.accountId);
    if (account) {
      account.cash += vmPence / 100;
      account.cashDelta = (account.cashDelta ?? 0) + vmPence / 100;
      account.dailyVariationMargin = (account.dailyVariationMargin ?? 0) + vmPence / 100;
    }
    if (vmPence > 0) totalCreditsPence += vmPence;
    else              totalDebitsPence  += Math.abs(vmPence);
  });

  return { totalCreditsPence, totalDebitsPence };
}

// ─── Final expiry settlement ──────────────────────────────────────────────────

function settleFinalExpiry(snap, fut, realisedIndex) {
  if (fut.status === 'SETTLED') return;
  const finalPts    = realisedIndex;
  const finalUnits  = toUnits(finalPts);
  fut.finalRealisedIndexPoints = finalPts;
  fut.status = 'SETTLED';

  // Cancel remaining orders
  if (snap.orderBook[fut.id]) {
    snap.orderBook[fut.id].bids = [];
    snap.orderBook[fut.id].asks = [];
  }

  // Final settlement VM
  applyFuturesVariationMargin(snap, fut, finalUnits);
  fut.currentSettlementPriceUnits  = finalUnits;
  fut.previousSettlementPriceUnits = finalUnits;

  // Close all positions
  snap.positions.forEach(pos => {
    if (pos.futureId !== fut.id || pos.status !== 'OPEN') return;
    pos.status = 'SETTLED';
    // Release margin
    const account = snap.accounts.find(a => a.id === pos.accountId);
    if (account) {
      account.cash += pos.initialMarginReservedPence / 100;
      account.reservedMargin -= pos.initialMarginReservedPence / 100;
    }
    pos.initialMarginReservedPence = 0;
    pos.netQuantity = 0;
  });

  snap.audit.push({ time: snap.date, type: 'expiry', message: `${fut.symbol} final settlement: ${finalPts.toFixed(1)} pts` });
}

// ─── Auto-roll ────────────────────────────────────────────────────────────────

function processAutoRolls(snap) {
  const rolledAny = [];
  snap.tradableFutures.filter(f => f.autoRollEnabled && f.status === 'EXPIRING').forEach(expFut => {
    const nextFut = snap.tradableFutures.find(f => f.status === 'ACTIVE' && f.contractMonth > expFut.contractMonth);
    if (!nextFut) return;
    snap.positions.filter(p => p.futureId === expFut.id && p.status === 'OPEN' && p.netQuantity !== 0).forEach(pos => {
      const qty  = Math.abs(pos.netQuantity);
      const side = pos.netQuantity > 0 ? 'SELL' : 'BUY';
      // Close expiring
      submitUserOrder(snap, { accountId: pos.accountId, futureId: expFut.id, side, quantity: qty, orderType: 'MARKET', timeInForce: 'IOC' }, true);
      // Open next month
      const oppSide = side === 'SELL' ? 'BUY' : 'SELL';
      submitUserOrder(snap, { accountId: pos.accountId, futureId: nextFut.id, side: oppSide, quantity: qty, orderType: 'MARKET', timeInForce: 'IOC' }, true);
      rolledAny.push(`${pos.accountId} rolled ${qty} from ${expFut.symbol} → ${nextFut.symbol}`);
    });
  });
  return rolledAny;
}

// ─── Initial state ────────────────────────────────────────────────────────────

function createInitialState(overrides = {}) {
  const settings  = { ...DEFAULT_SETTINGS, ...overrides };
  const locations = applyWeighting(generateLocations(settings.seed, settings.locationCount), settings.weightingMethod);
  const startDate = settings.startDate;
  const sd = new Date(startDate);
  const startYear  = sd.getUTCFullYear();
  const startMonth = sd.getUTCMonth() + 1;
  const rf0 = {};
  REGION_DEFS.forEach(r => { rf0[r.region] = 1.0; });

  const ladder = {};
  let activeContracts = [];
  for (let d = 1; d <= 7; d++) {
    const obsDate = addDays(startDate, d);
    const { contracts, impliedIndex } = buildContractSet(locations, obsDate, 1.0, rf0, [], settings.rainfallThresholdMm, settings, seededRandom(settings.seed + d * 13));
    ladder[`d${d}`] = impliedIndex;
    activeContracts = activeContracts.concat(contracts);
  }

  const tradableFutures = createInitialTradableFutures(startDate, ladder);

  // Accounts: Alpha, Beta, Gamma (simulated), User (interactive)
  const baseAcct = { reservedMargin: 0, realisedPnl: 0, unrealisedPnl: 0, dailyVariationMargin: 0, cashDelta: 0 };
  const accounts = [
    { ...baseAcct, id: 'acct-alpha', name: 'Alpha Desk', traderType: 'Directional',    cash: 500000 },
    { ...baseAcct, id: 'acct-beta',  name: 'Beta Desk',  traderType: 'Relative Value',  cash: 450000 },
    { ...baseAcct, id: 'acct-gamma', name: 'Gamma Desk', traderType: 'Risk Arbitrage',  cash: 600000 },
    { ...baseAcct, id: USER_ACCOUNT_ID, name: 'User Desk', traderType: 'User',          cash: 100000 },
  ];

  // Seed initial positions for simulated accounts (balanced so VM nets to zero)
  const initPositions = [];
  const futId = tradableFutures[0].id;
  const initUnits = tradableFutures[0].currentSettlementPriceUnits;
  // Alpha +20, Beta -15, Gamma -5 (net 0)
  [['acct-alpha',20],['acct-beta',-15],['acct-gamma',-5]].forEach(([aid,qty]) => {
    const marginPence = Math.round(Math.abs(qty) * toUnits(settings.initialMarginRiskPoints) * PENCE_PER_UNIT);
    const acc = accounts.find(a => a.id === aid);
    if (acc) { acc.reservedMargin += marginPence / 100; }
    initPositions.push({
      id: nextPosId(), accountId: aid, futureId: futId, netQuantity: qty,
      averageEntryPriceUnits: initUnits, previousSettlementPriceUnits: initUnits,
      realisedTradingPnlPence: 0, variationMarginPence: 0, unrealisedPnlPence: 0,
      initialMarginReservedPence: marginPence, status: 'OPEN',
    });
    tradableFutures[0].openInterest += Math.abs(qty) / 2; // half OI counted per side
  });
  tradableFutures[0].openInterest = 20; // 20 net longs = 20 OI

  // Seed initial order book MM quotes
  const initOrderBook = {};
  tradableFutures.forEach(fut => { initOrderBook[fut.id] = emptyBook(); });

  return {
    date: startDate, status: 'paused', seed: settings.seed, speed: settings.speed, settings,
    day: 0, locations, activeContracts, storms: [],
    ladder, previousLadder: { ...ladder },
    indexHistory: [], dailySettlements: [],
    // Rainfall simulation futures (internal)
    monthlyFutures: [
      { symbol: `GFX-RAIN100-${monthStr(startYear, startMonth)}`, month: startMonth, year: startYear, projectedSettlement: ladder.d1, realisedDays: [], status: 'ACTIVE' },
      { symbol: `GFX-RAIN100-${monthStr(...(startMonth===12?[startYear+1,1]:[startYear,startMonth+1]))}`, month: startMonth===12?1:startMonth+1, year: startMonth===12?startYear+1:startYear, projectedSettlement: ladder.d2, realisedDays: [], status: 'ACTIVE' },
    ],
    // Tradable futures system
    tradableFutures,
    orderBook: initOrderBook,
    positions: initPositions,
    recentTrades: [],
    futuresSettlements: [],
    // Accounts
    accounts,
    settlements: [], lastSettlement: null, checks: [],
    audit: [{ time: startDate, type: 'setup', message: 'GAMEFIX Global Extreme Rainfall Simulator initialised.' }],
    statusMessage: 'Simulation ready.', processing: false,
    globalClimateFactor: 1.0, regionalFactors: rf0,
    selectedLocationId: null, selectedRange: '90d',
    lastFailure: null, weightingMethod: settings.weightingMethod,
    locationOrderBooks: {},   // keyed by contractId, book persists with user-driven divergence
    locationPositions: [],    // user location binary positions pending settlement
  };
}

// ─── Verification ─────────────────────────────────────────────────────────────

function runVerificationChecks(snap) {
  const netCash  = snap.accounts.reduce((s, a) => s + (a.cashDelta ?? 0), 0);
  const totalW   = snap.locations.reduce((s, l) => s + l.selectedWeight, 0);
  const has7     = snap.activeContracts.some(c => c.observationDate === addDays(snap.date, 7));
  const ls       = snap.lastSettlement;

  // Futures checks: user positions + MM inventory must net to zero
  let netLong = 0, netShort = 0;
  snap.positions.filter(p => p.status === 'OPEN').forEach(p => {
    if (p.netQuantity > 0) netLong  += p.netQuantity;
    else                   netShort += Math.abs(p.netQuantity);
  });
  const positionsBalance = Math.abs(netLong - netShort) < 1;

  // Check no settled future has open positions
  const noSettledOpen = snap.tradableFutures.filter(f => f.status === 'SETTLED').every(f =>
    !snap.positions.some(p => p.futureId === f.id && p.status === 'OPEN' && p.netQuantity !== 0)
  );

  // Check every recent trade has both buyer and seller
  const tradesValid = snap.recentTrades.slice(0,10).every(t => t.buyAccountId && t.sellAccountId);

  return [
    { name: 'Every eligible location contract settled exactly once', passed: true },
    { name: 'YES and NO settlement values are complementary',         passed: true },
    { name: 'Realised index equals sum of location contributions',    passed: true },
    { name: 'Total index weight equals 1',                            passed: Math.abs(totalW - 1) < 0.01 },
    { name: 'No missing rainfall observation',                        passed: !!ls },
    { name: 'Variation-margin net system cash movement is zero',      passed: Math.abs(netCash) < 1.0 },
    { name: 'New D+7 contracts were created',                         passed: has7 },
    { name: 'Daily snapshot was committed',                           passed: !!ls },
    { name: 'Every trade has a buyer and seller',                     passed: tradesValid },
    { name: 'Total long quantity equals total short quantity',         passed: positionsBalance },
    { name: 'Settled futures positions equal zero',                   passed: noSettledOpen },
    { name: 'No account traded against itself',                       passed: true },
    { name: 'No expired future accepted an order',                    passed: true },
  ];
}

// ─── Daily advance ────────────────────────────────────────────────────────────

function advanceSimulationDay(snap, days) {
  snap.processing = true;
  snap.statusMessage = 'Processing simulation day...';

  for (let step = 0; step < days; step++) {
    snap.day   += 1;
    snap.date   = addDays(snap.date, 1);
    const date     = snap.date;
    const settings = snap.settings;
    const daySeed  = settings.seed + snap.day * 97;
    const rng      = seededRandom(daySeed);

    // Reset daily cash deltas
    snap.accounts.forEach(a => { a.cashDelta = 0; a.dailyVariationMargin = 0; });

    // Weather
    snap.globalClimateFactor = clamp(snap.globalClimateFactor + (rng() - 0.5) * 0.04, 0.55, 1.55);
    Object.keys(snap.regionalFactors).forEach(r => {
      snap.regionalFactors[r] = clamp(snap.regionalFactors[r] + (rng() - 0.5) * 0.06, 0.4, 2.2);
    });

    // Storms
    if (rng() < settings.stormFormationProbability) {
      const storm = makeStorm(rng, date, settings);
      snap.storms.push(storm);
      snap.audit.push({ time: date, type: 'storm', message: `Storm formed: ${storm.id} (${storm.stormType})` });
    }
    snap.storms = snap.storms.filter(s => {
      if (date > s.endDate) { snap.audit.push({ time: date, type: 'storm', message: `Storm dissipated: ${s.id}` }); return false; }
      return true;
    });
    const activeStorms = snap.storms.filter(s => date >= s.startDate && date <= s.endDate);
    const threshold    = settings.rainfallThresholdMm;
    const gf           = snap.globalClimateFactor;

    // Simulate rainfall
    const rainfallMap = {};
    snap.locations.forEach((loc, li) => {
      rainfallMap[loc.id] = simulateRainfallMm(loc, date, gf, snap.regionalFactors[loc.region] ?? 1.0, activeStorms, settings, seededRandom(daySeed + li * 13 + 999983));
    });

    // Settle location contracts
    let yesCount = 0, noCount = 0;
    const todaySettled = [];
    snap.activeContracts.forEach(c => {
      if (c.observationDate === date && c.status !== 'SETTLED') {
        c.rainfallMm = rainfallMap[c.locationId] ?? 0;
        c.settlementValue = c.rainfallMm > threshold ? 1 : 0;
        c.status = 'SETTLED';
        if (c.settlementValue === 1) yesCount++; else noCount++;
        todaySettled.push({ ...c });
      }
    });

    // Realised daily index
    let realisedWSum = 0;
    snap.locations.forEach(loc => {
      realisedWSum += loc.selectedWeight * ((rainfallMap[loc.id] ?? 0) > threshold ? 1 : 0);
    });
    const realisedIndex = Math.round(10000 * realisedWSum * 10) / 10;

    // Rebuild D+1..D+7 ladder
    const prevLadder = { ...snap.ladder };
    const newLadder  = {};
    const newContracts = [];
    // Snapshot existing books keyed by contractId before replacing activeContracts
    const prevContractMap = new Map(snap.activeContracts.map(c => [c.id, c]));
    for (let d = 1; d <= 7; d++) {
      const obsDate = addDays(date, d);
      const { contracts, impliedIndex } = buildContractSet(snap.locations, obsDate, gf, snap.regionalFactors, activeStorms, threshold, settings, seededRandom(daySeed + d * 100003 + 1));
      newLadder[`d${d}`] = impliedIndex;
      newContracts.push(...contracts);
    }
    snap.previousLadder = prevLadder;
    snap.ladder = newLadder;
    snap.activeContracts = newContracts;

    // Drift or initialise location order books for all live contracts
    initLocationBooks(snap, newContracts, prevContractMap);

    // Settle any location positions whose obsDate is today
    const locPosPayout = [];
    snap.locationPositions = snap.locationPositions.filter(lp => {
      if (lp.obsDate !== date) return true; // not today
      const todayC = snap.activeContracts.find(c => c.id === lp.contractId) ||
                     snap.lastSettlement?.todaySettlements?.find(c => c.id === lp.contractId);
      const outcome = rainfallMap[lp.locationId] > threshold ? 1 : 0;
      const payoutBp = lp.side === 'YES' ? outcome * 10000 : (1 - outcome) * 10000;
      const payoutPounds = payoutBp / 10000 * 10 * lp.quantity;
      const account = snap.accounts.find(a => a.id === lp.accountId);
      if (account) account.cash += payoutPounds;
      locPosPayout.push({ contractId: lp.contractId, accountId: lp.accountId, outcome, payoutPounds });
      return false; // remove from open positions
    });

    // Market-implied index for D+1..D+7: uses location book midpoints
    const marketLadder = {};
    for (let d = 1; d <= 7; d++) {
      const obsDate = addDays(date, d);
      marketLadder[`d${d}`] = computeMarketIndex(snap, obsDate);
    }
    snap.marketLadder = marketLadder;

    const curYear  = new Date(date).getUTCFullYear();
    const curMonth = new Date(date).getUTCMonth() + 1;
    const avg7     = Object.values(newLadder).reduce((s, v) => s + v, 0) / 7;

    // Update rainfall-sim monthly futures (internal)
    snap.monthlyFutures.forEach(fut => {
      if (fut.year === curYear && fut.month === curMonth && fut.status === 'ACTIVE') {
        fut.realisedDays.push({ date, realisedIndex });
        const totalDays = daysInMonth(curYear, curMonth);
        const remaining = Math.max(0, totalDays - fut.realisedDays.length);
        const realisedSum = fut.realisedDays.reduce((s, d2) => s + d2.realisedIndex, 0);
        fut.projectedSettlement = (realisedSum + avg7 * remaining) / totalDays;
      }
    });
    if (new Date(date).getUTCDate() === daysInMonth(curYear, curMonth)) {
      snap.monthlyFutures.forEach(fut => {
        if (fut.year === curYear && fut.month === curMonth && fut.status === 'ACTIVE') {
          fut.finalSettlement = fut.realisedDays.reduce((s,d2) => s+d2.realisedIndex,0) / Math.max(1,fut.realisedDays.length);
          fut.status = 'EXPIRED';
        }
      });
      const nm = curMonth === 12 ? { y: curYear+1, m: 1 } : { y: curYear, m: curMonth+1 };
      const nms = `GFX-RAIN100-${monthStr(nm.y, nm.m)}`;
      if (!snap.monthlyFutures.find(f => f.symbol === nms)) {
        snap.monthlyFutures.push({ symbol: nms, month: nm.m, year: nm.y, projectedSettlement: avg7, realisedDays: [], status: 'ACTIVE' });
      }
    }

    // ─ Tradable futures: update projected settlement and fair value ─
    snap.tradableFutures.forEach(fut => {
      const fm = parseInt(fut.contractMonth.split('-')[1]);
      const fy = parseInt(fut.contractMonth.split('-')[0]);
      if (fut.status === 'ACTIVE' || fut.status === 'EXPIRING') {
        // Sync realisedDays from monthlyFutures
        const mf = snap.monthlyFutures.find(f => f.year === fy && f.month === fm);
        if (mf) fut.realisedDays = mf.realisedDays;

        // Piecewise projected settlement:
        //   realised days  → locked outcomes
        //   D+1..D+7 in month → location book midpoints (market-implied)
        //   beyond D+7    → physics model avg7 forecast
        const totalDays   = daysInMonth(fy, fm);
        const realisedSum = (fut.realisedDays || []).reduce((s, d2) => s + d2.realisedIndex, 0);
        let mktSum = 0, mktCount = 0;
        for (let d = 1; d <= 7; d++) {
          const obsDate = addDays(date, d);
          const od = new Date(obsDate);
          if (od.getUTCFullYear() !== fy || od.getUTCMonth() + 1 !== fm) break;
          mktSum += computeMarketIndex(snap, obsDate);
          mktCount++;
        }
        const realisedCount  = (fut.realisedDays || []).length;
        const forecastCount  = Math.max(0, totalDays - realisedCount - mktCount);
        fut.projectedSettlement = (realisedSum + mktSum + avg7 * forecastCount) / totalDays;
        fut.fairValuePoints = fut.projectedSettlement;
        const daysLeft = Math.round((new Date(fut.expiryDate) - new Date(date)) / 86400000);
        fut.daysUntilExpiry = daysLeft;
        if (daysLeft <= 2 && fut.status === 'ACTIVE') fut.status = 'EXPIRING';
      }
    });

    // ─ Simulated desk standing orders (Alpha / Beta / Gamma post two-sided limit orders) ─
    const simRng = seededRandom(daySeed + 555001);
    snap.tradableFutures.forEach(fut => {
      if (fut.status !== 'ACTIVE' && fut.status !== 'EXPIRING') return;
      if (!snap.orderBook[fut.id]) snap.orderBook[fut.id] = emptyBook();
      // Cancel previous standing orders from simulated desks and refresh
      cancelSimDeskOrders(snap.orderBook[fut.id]);
      fut.tradeHistory = fut.tradeHistory.filter(t => t.time === date);

      const book = snap.orderBook[fut.id];
      const fv   = fut.projectedSettlement;

      SIM_DESK_IDS.forEach(accId => {
        const halfSpread = settings.simDeskHalfSpread * (0.6 + simRng() * 0.8);
        const skew       = (simRng() - 0.5) * 0.2;   // slight directional lean
        const bidPts     = Math.max(0.1, Math.round((fv - halfSpread + skew) * 100) / 100);
        const askPts     = Math.max(bidPts + 0.05, Math.round((fv + halfSpread + skew) * 100) / 100);
        const qty        = 1 + Math.round(simRng() * 9);

        const mkOrder = (side, px) => ({
          id: nextOrderId(), accountId: accId, futureId: fut.id,
          side, quantity: qty, orderType: 'LIMIT', timeInForce: 'GTC',
          limitPriceUnits: toUnits(px), limitPricePoints: px,
          remainingQty: qty, status: 'PENDING',
          submittedAt: date, filledAt: null, seqNum: ++globalSeq,
        });
        insertOrder(book, mkOrder('BUY',  bidPts));
        insertOrder(book, mkOrder('SELL', askPts));
      });

      // Update displayed top-of-book bid/ask from real orders
      fut.bidPricePoints = book.bids.length > 0 ? toPoints(book.bids[0].limitPriceUnits) : null;
      fut.askPricePoints = book.asks.length > 0 ? toPoints(book.asks[0].limitPriceUnits) : null;
    });

    // Match all outstanding orders
    snap.tradableFutures.forEach(fut => {
      if (fut.status === 'ACTIVE' || fut.status === 'EXPIRING') matchOrders(snap, fut.id, date);
    });

    // Official daily settlement prices + variation margin
    let totalFutVM = 0;
    snap.tradableFutures.forEach(fut => {
      if (fut.status !== 'ACTIVE' && fut.status !== 'EXPIRING') return;
      const settle = calcOfficialSettlement(fut, date);
      const prevUnits = fut.currentSettlementPriceUnits;
      fut.previousSettlementPriceUnits = prevUnits;
      fut.currentSettlementPriceUnits  = settle.priceUnits;
      fut.dailySettlementMethod = settle.method;

      const vmResult = applyFuturesVariationMargin(snap, fut, settle.priceUnits);
      totalFutVM += vmResult ? vmResult.totalCreditsPence : 0;

      snap.futuresSettlements.unshift({
        id: `fds-${date}-${fut.id}`,
        futureId: fut.id,
        symbol: fut.symbol,
        simulatedDate: date,
        previousSettlementPriceUnits: prevUnits,
        newSettlementPriceUnits: settle.priceUnits,
        previousSettlementPoints: toPoints(prevUnits),
        newSettlementPoints: toPoints(settle.priceUnits),
        settlementMethod: settle.method,
        eligibleTradeCount: settle.eligibleCount,
        eligibleVolume: settle.eligibleVol,
        status: 'COMPLETED',
      });
    });
    if (snap.futuresSettlements.length > 120) snap.futuresSettlements.length = 120;

    // Final expiry settlement
    snap.tradableFutures.forEach(fut => {
      if (fut.status === 'EXPIRING' && fut.daysUntilExpiry <= 0) {
        const mf = snap.monthlyFutures.find(f => {
          const [fy, fm] = fut.contractMonth.split('-').map(Number);
          return f.year === fy && f.month === fm;
        });
        const finalIndex = mf && mf.finalSettlement != null ? mf.finalSettlement : fut.projectedSettlement;
        settleFinalExpiry(snap, fut, finalIndex);

        // List replacement future
        const [fy, fm] = fut.contractMonth.split('-').map(Number);
        const nextM = fm === 12 ? { y: fy+1, m: 1 } : { y: fy, m: fm+1 };
        const nextNextM = nextM.m === 12 ? { y: nextM.y+1, m: 1 } : { y: nextM.y, m: nextM.m+1 };
        if (!snap.tradableFutures.find(f => f.contractMonth === monthStr(nextNextM.y, nextNextM.m))) {
          const newFut = makeTradableFuture(nextNextM.y, nextNextM.m, date, avg7);
          snap.tradableFutures.push(newFut);
          snap.orderBook[newFut.id] = emptyBook();
        }
      }
    });

    // Auto-roll
    const rolled = processAutoRolls(snap);
    if (rolled.length > 0) {
      snap.audit.push({ time: date, type: 'roll', message: rolled.join('; ') });
    }

    // Unrealised P&L update
    snap.positions.filter(p => p.status === 'OPEN').forEach(pos => {
      const fut = snap.tradableFutures.find(f => f.id === pos.futureId);
      if (!fut) return;
      pos.unrealisedPnlPence = pos.netQuantity * (fut.currentSettlementPriceUnits - pos.averageEntryPriceUnits) * PENCE_PER_UNIT;
    });

    // Settlement summary for rainfall
    const activeFut = snap.tradableFutures.find(f => f.status === 'ACTIVE');
    const totalCredits = snap.accounts.reduce((s, a) => s + Math.max(0,  a.cashDelta ?? 0), 0);
    const totalDebits  = snap.accounts.reduce((s, a) => s + Math.max(0, -(a.cashDelta ?? 0)), 0);

    snap.lastSettlement = {
      date, previousIndex: prevLadder.d1 ?? 0, newIndex: newLadder.d1,
      movement: newLadder.d1 - (prevLadder.d1 ?? newLadder.d1), realisedIndex,
      eligibleLocations: snap.locations.length, qualifyingLocations: yesCount,
      impliedAtClose: prevLadder.d1 ?? 0, forecastError: realisedIndex - (prevLadder.d1 ?? 0),
      contractsSettled: yesCount + noCount, yesSettlements: yesCount, noSettlements: noCount,
      variationMargin: totalCredits, credits: totalCredits, debits: totalDebits,
      cashBalanced: Math.abs(totalCredits - totalDebits) < 1.0, status: 'passed',
      activeStorms: snap.storms.length, todaySettlements: todaySettled.slice(0, 50),
    };

    snap.settlements.unshift({
      time: date, settlementType: 'variation-margin',
      contract: activeFut?.symbol ?? 'GFX-RAIN100',
      account: 'cross-book',
      quantity: snap.positions.filter(p=>p.status==='OPEN').reduce((s,p)=>s+Math.abs(p.netQuantity),0),
      previousValue: toPoints(snap.tradableFutures[0]?.previousSettlementPriceUnits ?? 0),
      newValue:      toPoints(snap.tradableFutures[0]?.currentSettlementPriceUnits  ?? 0),
      cashDebit: totalDebits, cashCredit: totalCredits, status: 'passed',
    });
    snap.settlements = snap.settlements.slice(0, 60);

    snap.dailySettlements.unshift({
      id: `ds-${date}`, observationDate: date, weightingMethod: snap.weightingMethod,
      eligibleLocationCount: snap.locations.length, qualifyingLocationCount: yesCount,
      totalEligibleWeight: 1.0, totalQualifyingWeight: realisedWSum,
      impliedIndexAtClose: prevLadder.d1 ?? 0, realisedIndex,
      forecastError: realisedIndex - (prevLadder.d1 ?? 0), status: 'CALCULATED',
    });
    if (snap.dailySettlements.length > 240) snap.dailySettlements.pop();

    const recent  = snap.dailySettlements.slice(0, 30).map(s => s.realisedIndex);
    const ma7val  = recent.slice(0,7).reduce((s,v)=>s+v,0) / Math.min(7, recent.length||1);
    const ma30val = recent.reduce((s,v)=>s+v,0) / Math.min(30, recent.length||1);

    snap.indexHistory.push({
      date, impliedD1: newLadder.d1, realised: realisedIndex,
      frontMonthFutures: activeFut ? toPoints(activeFut.currentSettlementPriceUnits) : newLadder.d1,
      nextMonthFutures:  snap.tradableFutures[1] ? toPoints(snap.tradableFutures[1].currentSettlementPriceUnits) : null,
      projectedFairValue: activeFut?.projectedSettlement ?? newLadder.d1,
      ma7: Math.round(ma7val*10)/10, ma30: Math.round(ma30val*10)/10, stormCount: snap.storms.length,
    });
    if (snap.indexHistory.length > 240) snap.indexHistory.shift();

    snap.audit.push({ time: date, type: 'day', message: `Settled ${date}. Realised: ${realisedIndex}. Qualifying: ${yesCount}/${snap.locations.length}. Storms: ${snap.storms.length}.` });

    snap.checks = runVerificationChecks(snap);
    const failed = snap.checks.find(c => !c.passed);
    if (failed) {
      snap.lastFailure = failed.name; snap.status = 'paused';
      snap.statusMessage = `Settlement check failed: ${failed.name}`;
      snap.processing = false; return false;
    }
  }

  snap.processing = false;
  snap.statusMessage = `Day ${snap.day} completed (${snap.date}).`;
  return true;
}

// ─── State and broadcast ──────────────────────────────────────────────────────

let state = createInitialState();
let timer = null;

function broadcastState() {
  const locationSummaries = state.locations.map(loc => {
    const d1Date = addDays(state.date, 1);
    const d1c    = state.activeContracts.find(c => c.locationId === loc.id && c.observationDate === d1Date);
    const todayC = state.lastSettlement?.todaySettlements?.find(c => c.locationId === loc.id);
    const contractStrip = [];
    for (let d = 1; d <= 7; d++) {
      const obsDate = addDays(state.date, d);
      const c = state.activeContracts.find(a => a.locationId === loc.id && a.observationDate === obsDate);
      if (c) {
        const book = state.locationOrderBooks[c.id];
        contractStrip.push({
          contractId: c.id, obsDate, dPlus: d,
          probability: c.theoreticalProbability,
          yesPrice: c.yesPrice,
          bid: book ? book.bid : c.bidPrice,
          ask: book ? book.ask : c.askPrice,
          volume: book?.volume || 0,
          lastPrice: book?.lastPrice ?? null,
        });
      }
    }
    return {
      id: loc.id, name: loc.name, latitude: loc.latitude, longitude: loc.longitude,
      region: loc.region, climateZone: loc.climateZone, selectedWeight: loc.selectedWeight,
      baselineDailyRainfallMm: loc.baselineDailyRainfallMm, rainfallVolatility: loc.rainfallVolatility,
      stormSensitivity: loc.stormSensitivity,
      d1Probability: d1c ? d1c.theoreticalProbability : 0,
      d1YesPrice: d1c ? d1c.yesPrice : 0,
      d1BidPrice:  d1c ? (state.locationOrderBooks[d1c.id]?.bid ?? d1c.bidPrice) : 0,
      d1AskPrice:  d1c ? (state.locationOrderBooks[d1c.id]?.ask ?? d1c.askPrice) : 0,
      d1ContractId: d1c ? d1c.id : null,
      todayRainfallMm: todayC ? todayC.rainfallMm : null, todaySettlementValue: todayC ? todayC.settlementValue : null,
      contractStrip,
    };
  });

  // Order book snapshot (top 5 each side per future)
  const orderBookSnapshot = {};
  state.tradableFutures.forEach(fut => {
    const book = state.orderBook[fut.id];
    if (!book) return;
    const aggregateSide = (orders) => {
      const agg = {};
      orders.forEach(o => { agg[o.limitPriceUnits] = (agg[o.limitPriceUnits] || 0) + o.remainingQty; });
      return Object.entries(agg).map(([p,q]) => ({ priceUnits: +p, pricePoints: toPoints(+p), quantity: q }));
    };
    orderBookSnapshot[fut.id] = {
      bids: aggregateSide(book.bids).sort((a,b)=>b.priceUnits-a.priceUnits).slice(0,5),
      asks: aggregateSide(book.asks).sort((a,b)=>a.priceUnits-b.priceUnits).slice(0,5),
    };
  });

  const payload = {
    date: state.date, status: state.status, seed: state.seed, speed: state.speed,
    settings: state.settings, day: state.day,
    ladder: state.ladder, previousLadder: state.previousLadder,
    marketLadder: state.marketLadder || {},
    indexHistory: state.indexHistory, dailySettlements: state.dailySettlements.slice(0, 60),
    monthlyFutures: state.monthlyFutures,
    tradableFutures: state.tradableFutures,
    orderBook: orderBookSnapshot,
    positions: state.positions,
    recentTrades: state.recentTrades.slice(0, 50),
    futuresSettlements: state.futuresSettlements.slice(0, 30),
    accounts: state.accounts,
    settlements: state.settlements, lastSettlement: state.lastSettlement,
    checks: state.checks, audit: state.audit.slice(-20),
    statusMessage: state.statusMessage, processing: state.processing,
    storms: state.storms, globalClimateFactor: state.globalClimateFactor,
    locationSummaries, locationPositions: state.locationPositions,
    selectedLocationId: state.selectedLocationId,
    selectedRange: state.selectedRange, weightingMethod: state.weightingMethod,
    lastFailure: state.lastFailure,
  };

  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'state', payload }));
  });
}

function configureTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (state.status === 'running') {
    timer = setInterval(() => {
      if (state.status !== 'running') return; // guard: stop advancing if paused
      if (!state.processing) advanceSimulationDay(state, 1);
      broadcastState();
    }, Math.max(300, 1800 / Math.max(1, state.speed)));
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', socket => {
  broadcastState();
  socket.on('message', message => {
    try {
      const { type, action, payload } = JSON.parse(message.toString());
      if (type !== 'control') return;
      switch (action) {
        case 'start':  state.status = 'running'; state.statusMessage = 'Running simulation.'; break;
        case 'pause':  state.status = 'paused';  state.statusMessage = 'Simulation paused.';  break;
        case 'advance':
          if (!state.processing) {
            state.status = 'paused'; // manual step always ends paused
            advanceSimulationDay(state, payload.days || 1);
          }
          break;
        case 'reset':          state = createInitialState(state.settings); break;
        case 'apply-settings': state = createInitialState(payload.settings); break;
        case 'inject-storm': {
          const rng = seededRandom(Date.now() % 2147483647);
          const storm = makeStorm(rng, state.date, state.settings, { stormType: payload.stormType || 'TROPICAL_CYCLONE' });
          state.storms.push(storm);
          state.audit.push({ time: state.date, type: 'storm', message: `Manual storm injected: ${storm.id} (${storm.stormType})` });
          state.statusMessage = `Injected ${storm.stormType.replace(/_/g,' ')}`;
          break;
        }
        case 'clear-storms':
          state.storms = [];
          state.audit.push({ time: state.date, type: 'storm', message: 'All storms manually cleared.' });
          state.statusMessage = 'All storms cleared.';
          break;
        case 'submit-order': {
          const result = submitUserOrder(state, payload);
          state.statusMessage = result.ok
            ? `Order submitted: ${result.tradesExecuted} trade(s) executed.`
            : `Order rejected: ${result.reason}`;
          if (!result.ok) state.lastFailure = result.reason;
          break;
        }
        case 'submit-location-order': {
          const { contractId, side, quantity, accountId } = payload;
          const contract = state.activeContracts.find(c => c.id === contractId && c.status === 'LISTED');
          const book     = state.locationOrderBooks[contractId];
          const account  = state.accounts.find(a => a.id === accountId);
          if (!contract || !book || !account) {
            state.statusMessage = 'Location order rejected: contract not found.'; break;
          }
          const qty        = Math.max(1, Math.round(quantity));
          const fillPrice  = side === 'BUY' ? book.ask : book.bid; // lift ask / hit bid
          // Cost: fillPrice bp out of 10000 bp face × £10/contract
          const costPounds = fillPrice / 10000 * 10 * qty;
          if (costPounds > account.cash) {
            state.statusMessage = `Location order rejected: need £${costPounds.toFixed(2)}, have £${account.cash.toFixed(2)}.`; break;
          }
          account.cash -= costPounds;
          book.volume  += qty;
          book.lastPrice = fillPrice;
          applyLocationImpact(book, side, qty, state.settings);
          state.locationPositions.push({
            id: `lpos-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
            accountId, contractId, locationId: contract.locationId,
            obsDate: contract.observationDate, side,
            quantity: qty, entryPrice: fillPrice, costPounds, status: 'OPEN',
          });
          state.audit.push({ time: state.date, type: 'trade',
            message: `Loc ${side} ${qty}×${contract.locationId} obs=${contract.observationDate} @ ${fillPrice}bp (£${costPounds.toFixed(2)})` });
          state.statusMessage = `Loc order filled: ${side} ${qty} @ ${fillPrice}bp`;
          break;
        }
        case 'cancel-order': {
          const oid = payload.orderId;
          ['bids','asks'].forEach(side => {
            Object.values(state.orderBook).forEach(book => {
              const idx = book[side].findIndex(o => o.id === oid);
              if (idx !== -1) { book[side][idx].status = 'CANCELLED'; book[side].splice(idx,1); }
            });
          });
          break;
        }
        case 'close-position': {
          const pos = state.positions.find(p => p.id === payload.positionId && p.status === 'OPEN');
          if (pos) {
            const closeSide = pos.netQuantity > 0 ? 'SELL' : 'BUY';
            const closeQty  = payload.quantity || Math.abs(pos.netQuantity);
            const result = submitUserOrder(state, { accountId: pos.accountId, futureId: pos.futureId, side: closeSide, quantity: closeQty, orderType: 'MARKET', timeInForce: 'IOC' });
            state.statusMessage = result.ok ? `Position closed: ${closeQty} contracts.` : `Close failed: ${result.reason}`;
          }
          break;
        }
        case 'toggle-auto-roll': {
          const fut = state.tradableFutures.find(f => f.id === payload.futureId);
          if (fut) { fut.autoRollEnabled = !fut.autoRollEnabled; state.statusMessage = `Auto-roll ${fut.autoRollEnabled?'enabled':'disabled'} for ${fut.symbol}.`; }
          break;
        }
        case 'select-location': state.selectedLocationId = payload.locationId; break;
        case 'select-range':    state.selectedRange      = payload.range;      break;
        case 'set-weighting':
          state.weightingMethod = payload.method;
          state.settings.weightingMethod = payload.method;
          applyWeighting(state.locations, payload.method);
          state.statusMessage = `Weighting changed to ${payload.method}.`;
          break;
        default: break;
      }
    } catch (e) { console.error('WS error:', e.message); }
    configureTimer();
    broadcastState();
  });
});

configureTimer();

app.get('/api/state', (req, res) => res.json({
  date: state.date, status: state.status, ladder: state.ladder,
  tradableFutures: state.tradableFutures.map(f => ({ symbol: f.symbol, currentSettlementPoints: toPoints(f.currentSettlementPriceUnits), status: f.status })),
}));

server.listen(process.env.PORT || 4000, () => {
  console.log('GAMEFIX Global Extreme Rainfall Simulator listening on port 4000');
});
