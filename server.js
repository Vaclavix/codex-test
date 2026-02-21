import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import companies from './data/us_companies.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const safeNum = (value, fallback = null) => {
  if (value === undefined || value === null || Number.isNaN(Number(value))) {
    return fallback;
  }
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

app.get('/api/search', (req, res) => {
  const query = req.query.q?.toString().trim().toLowerCase() || '';
  if (query.length < 2) {
    return res.status(400).json({ error: 'Zadejte alespoň 2 znaky.' });
  }

  const matches = companies
    .filter((item) => item.ticker.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
    .slice(0, 10)
    .map((item) => ({
      symbol: item.ticker,
      shortname: item.name,
      exchDisp: item.exchange
    }));

  return res.json(matches);
});

app.get('/api/valuation/:ticker', (req, res) => {
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

  const company = companies.find((item) => item.ticker === ticker);
  if (!company) {
    return res.status(404).json({ error: `Ticker ${ticker} nebyl nalezen v lokální databázi.` });
  }

  const sourceData = {
    startingFcf: safeNum(req.query.startingFcf, company.freeCashFlow),
    sharesOutstanding: company.sharesOutstanding,
    cash: company.cash,
    debt: company.debt
  };

  return res.json({
    company: {
      ticker: company.ticker,
      name: company.name,
      marketPrice: company.marketPrice,
      currency: company.currency
    },
    sourceData,
    assumptions,
    dcf: discountedCashFlow({ ...sourceData, ...assumptions })
  });
});

app.listen(port, () => {
  console.log(`Server běží na http://localhost:${port}`);
});
