import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import companies from './data/us_companies.json' with { type: 'json' };

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const safeNum = (value, fallback = null) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return fallback;
  return Number(value);
};

const discountedCashFlow = ({ startingFcf, growthRate, discountRate, terminalGrowthRate, forecastYears, sharesOutstanding, cash, debt }) => {
  let projectedFcf = startingFcf;
  let presentValue = 0;
  const yearlyForecast = [];

  for (let year = 1; year <= forecastYears; year += 1) {
    projectedFcf *= (1 + growthRate);
    const discounted = projectedFcf / ((1 + discountRate) ** year);
    presentValue += discounted;
    yearlyForecast.push({ year, projectedFcf, discountedFcf: discounted });
  }

  const terminalValue = (projectedFcf * (1 + terminalGrowthRate)) / (discountRate - terminalGrowthRate);
  const discountedTerminalValue = terminalValue / ((1 + discountRate) ** forecastYears);
  const enterpriseValue = presentValue + discountedTerminalValue;
  const equityValue = enterpriseValue + cash - debt;

  return {
    yearlyForecast,
    terminalValue,
    discountedTerminalValue,
    enterpriseValue,
    equityValue,
    intrinsicValuePerShare: equityValue / sharesOutstanding
  };
};

const fromRaw = (v, fallback = 0) => {
  if (v && typeof v === 'object' && 'raw' in v) return safeNum(v.raw, fallback);
  return safeNum(v, fallback);
};

const fetchJson = async (url) => {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (IntrinsicValueCalculator/1.0)',
      'Accept': 'application/json'
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const searchOnline = async (query) => {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
  const data = await fetchJson(url);

  return (data?.quotes || [])
    .filter((item) => ['NYSE', 'NMS', 'NasdaqGS', 'NasdaqGM', 'NasdaqCM'].includes(item.exchange))
    .map((item) => ({
      symbol: item.symbol,
      shortname: item.shortname || item.longname || item.symbol,
      exchDisp: item.exchDisp || item.exchange,
      source: 'realtime'
    }));
};

const searchOffline = (query) => companies
  .filter((item) => item.ticker.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
  .slice(0, 10)
  .map((item) => ({ symbol: item.ticker, shortname: item.name, exchDisp: item.exchange, source: 'offline' }));

app.get('/api/search', async (req, res) => {
  const query = req.query.q?.toString().trim().toLowerCase() || '';
  if (query.length < 2) return res.status(400).json({ error: 'Zadejte alespoň 2 znaky.' });

  try {
    const items = await searchOnline(query);
    return res.json({ items, source: 'realtime' });
  } catch {
    const items = searchOffline(query);
    return res.json({
      items,
      source: 'offline',
      warning: 'Realtime zdroj je dočasně nedostupný, proto byla použita lokální data.'
    });
  }
});

const valuationFromRealtime = async (ticker) => {
  const [quoteData, summaryData] = await Promise.all([
    fetchJson(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`),
    fetchJson(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics`) 
  ]);

  const quote = quoteData?.quoteResponse?.result?.[0];
  const summary = summaryData?.quoteSummary?.result?.[0];
  if (!quote) throw new Error('Ticker nebyl nalezen.');

  const sharesOutstanding = safeNum(quote.sharesOutstanding || fromRaw(summary?.defaultKeyStatistics?.sharesOutstanding));
  if (!sharesOutstanding || sharesOutstanding <= 0) throw new Error('Chybí data o počtu akcií.');

  const financialData = summary?.financialData || {};
  const freeCashFlow = fromRaw(financialData.freeCashflow, null);

  return {
    ticker,
    name: quote.longName || quote.shortName || ticker,
    marketPrice: safeNum(quote.regularMarketPrice),
    currency: quote.currency || 'USD',
    sharesOutstanding,
    freeCashFlow,
    cash: fromRaw(financialData.totalCash, 0),
    debt: fromRaw(financialData.totalDebt, 0),
    source: 'realtime'
  };
};

const valuationFromOffline = (ticker) => {
  const company = companies.find((item) => item.ticker === ticker);
  if (!company) throw new Error(`Ticker ${ticker} nebyl nalezen ani v lokální databázi.`);

  return {
    ticker: company.ticker,
    name: company.name,
    marketPrice: company.marketPrice,
    currency: company.currency,
    sharesOutstanding: company.sharesOutstanding,
    freeCashFlow: company.freeCashFlow,
    cash: company.cash,
    debt: company.debt,
    source: 'offline'
  };
};

app.get('/api/valuation/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const assumptions = {
    growthRate: safeNum(req.query.growthRate, 0.08),
    discountRate: safeNum(req.query.discountRate, 0.1),
    terminalGrowthRate: safeNum(req.query.terminalGrowthRate, 0.025),
    forecastYears: Math.max(3, Math.min(20, Math.round(safeNum(req.query.forecastYears, 10))))
  };

  if (assumptions.discountRate <= assumptions.terminalGrowthRate) {
    return res.status(400).json({ error: 'Diskontní sazba musí být vyšší než terminální růst.' });
  }

  try {
    let info;
    let warning;
    try {
      info = await valuationFromRealtime(ticker);
      if (!info.freeCashFlow || info.freeCashFlow <= 0) throw new Error('Chybí realtime FCF');
    } catch {
      info = valuationFromOffline(ticker);
      warning = 'Realtime data nebyla dostupná, byla použita lokální data.';
    }

    const sourceData = {
      startingFcf: safeNum(req.query.startingFcf, info.freeCashFlow),
      sharesOutstanding: info.sharesOutstanding,
      cash: info.cash,
      debt: info.debt
    };

    if (!sourceData.startingFcf || sourceData.startingFcf <= 0) {
      return res.status(422).json({ error: 'Nelze spočítat valuaci: chybí validní volné cash flow.' });
    }

    return res.json({
      company: {
        ticker: info.ticker,
        name: info.name,
        marketPrice: info.marketPrice,
        currency: info.currency
      },
      source: info.source,
      warning,
      sourceData,
      assumptions,
      dcf: discountedCashFlow({ ...sourceData, ...assumptions })
    });
  } catch (error) {
    return res.status(500).json({ error: `Výpočet selhal pro ${ticker}.`, details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server běží na http://localhost:${port}`);
});
