const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const results = document.getElementById('results');
const assumptionsCard = document.getElementById('assumptionsCard');
const outputCard = document.getElementById('outputCard');
const calculateBtn = document.getElementById('calculateBtn');
const statusEl = document.getElementById('status');
const companyTitle = document.getElementById('companyTitle');
const valuationSummary = document.getElementById('valuationSummary');
const forecastBody = document.getElementById('forecastBody');

let selectedTicker = null;

const formatUsd = (value) => new Intl.NumberFormat('cs-CZ', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
}).format(value);

const setStatus = (text, isError = false) => {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#b91c1c' : '#047857';
};

const renderResults = (items) => {
  results.innerHTML = '';
  if (!items.length) {
    setStatus('Nic jsme nenašli, zkus jiný dotaz.', true);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = `${item.symbol} — ${item.shortname} (${item.exchDisp})`;
    li.addEventListener('click', () => {
      selectedTicker = item.symbol;
      assumptionsCard.classList.remove('hidden');
      setStatus(`Vybráno: ${item.symbol}. Teď uprav předpoklady a klikni na výpočet.`);
    });
    results.appendChild(li);
  });
};

const search = async () => {
  const query = searchInput.value.trim();
  if (query.length < 2) {
    setStatus('Napiš alespoň 2 znaky.', true);
    return;
  }

  setStatus('Vyhledávám...');
  results.innerHTML = '';

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Chyba vyhledávání');
    }
    renderResults(data);
    setStatus('Vyber firmu ze seznamu.');
  } catch (error) {
    setStatus(error.message, true);
  }
};

const getAssumptions = () => {
  const value = (id) => Number(document.getElementById(id).value);
  const optional = (id) => document.getElementById(id).value.trim();

  const params = new URLSearchParams({
    growthRate: (value('growthRate') / 100).toString(),
    discountRate: (value('discountRate') / 100).toString(),
    terminalGrowthRate: (value('terminalGrowthRate') / 100).toString(),
    forecastYears: value('forecastYears').toString()
  });

  const customFcf = optional('startingFcf');
  if (customFcf) {
    params.append('startingFcf', customFcf);
  }
  return params;
};

const renderValuation = ({ company, sourceData, dcf }) => {
  outputCard.classList.remove('hidden');
  companyTitle.textContent = `${company.name} (${company.ticker})`;

  const upside = ((dcf.intrinsicValuePerShare - company.marketPrice) / company.marketPrice) * 100;

  valuationSummary.innerHTML = [
    ['Aktuální cena', formatUsd(company.marketPrice)],
    ['Vnitřní hodnota / akcie', formatUsd(dcf.intrinsicValuePerShare)],
    ['Potenciál', `${upside.toFixed(1)} %`],
    ['Enterprise value', formatUsd(dcf.enterpriseValue)],
    ['Startovní FCF', formatUsd(sourceData.startingFcf)]
  ].map(([label, val]) => `<div class="metric"><strong>${label}</strong><br>${val}</div>`).join('');

  forecastBody.innerHTML = dcf.yearlyForecast.map((row) => `
    <tr>
      <td>${row.year}</td>
      <td>${formatUsd(row.projectedFcf)}</td>
      <td>${formatUsd(row.discountedFcf)}</td>
    </tr>
  `).join('');
};

const calculate = async () => {
  if (!selectedTicker) {
    setStatus('Nejdřív vyber firmu ze seznamu.', true);
    return;
  }

  setStatus(`Počítám DCF pro ${selectedTicker}...`);
  try {
    const params = getAssumptions();
    const response = await fetch(`/api/valuation/${selectedTicker}?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Chyba výpočtu');
    }
    renderValuation(data);
    setStatus('Hotovo. Můžeš upravit předpoklady a přepočítat.');
  } catch (error) {
    setStatus(error.message, true);
  }
};

searchBtn.addEventListener('click', search);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    search();
  }
});
calculateBtn.addEventListener('click', calculate);
