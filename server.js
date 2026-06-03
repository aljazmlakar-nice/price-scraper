const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
  }
  return browser;
}

function parsePrice(text) {
  if (!text) return null;
  // Handle formats like "419,99 €", "€ 419.99", "1.234,56"
  let clean = text.replace(/[^\d,.]/g, '');
  // German format: 1.234,56 -> 1234.56
  if (/,\d{2}$/.test(clean)) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else {
    clean = clean.replace(/,/g, '');
  }
  const num = parseFloat(clean);
  return isNaN(num) || num < 1 ? null : num;
}

async function scrapePage(url) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'de-AT',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    // Wait for JS prices to render (ZooRoyal etc need longer)
    await page.waitForTimeout(4500);

    // Accept cookie banners if present (common German/Austrian buttons)
    const cookieButtons = ['Alle akzeptieren', 'Akzeptieren', 'Alle Cookies akzeptieren', 'Zustimmen', 'Accept all', 'Einverstanden'];
    for (const label of cookieButtons) {
      try {
        const btn = page.getByRole('button', { name: new RegExp(label, 'i') });
        if (await btn.count() > 0) { await btn.first().click({ timeout: 2000 }); await page.waitForTimeout(800); break; }
      } catch {}
    }

    let priceNum = null;
    let available = null;
    let shippingNum = null;

    // 1) JSON-LD structured data
    const jsonLds = await page.$$eval('script[type="application/ld+json"]', els =>
      els.map(e => e.textContent).filter(Boolean)
    ).catch(() => []);
    for (const raw of jsonLds) {
      try {
        const data = JSON.parse(raw);
        const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const item of items) {
          const offers = item.offers || (Array.isArray(item.offers) ? item.offers[0] : null);
          const off = Array.isArray(offers) ? offers[0] : offers;
          if (off?.price) {
            priceNum = parseFloat(off.price);
            available = off.availability?.includes('InStock') ?? null;
            const ship = off.shippingDetails?.shippingRate?.value;
            if (ship !== undefined) shippingNum = parseFloat(ship);
          }
        }
      } catch {}
    }

    // 2) Meta tags
    if (priceNum === null) {
      const meta = await page.$$eval('meta[property="product:price:amount"], meta[itemprop="price"], meta[name="price"]',
        els => els.map(e => e.getAttribute('content')).filter(Boolean)
      ).catch(() => []);
      if (meta.length) { const n = parseFloat(meta[0]); if (n > 1) priceNum = n; }
    }

    // 3) Visible price selectors
    if (priceNum === null) {
      const selectors = [
        '[data-testid="price"]', '[itemprop="price"]', '.price--current', '.price__regular',
        '.product-price', '.product-detail-price', '.price-box .price', '[class*="currentPrice"]',
        '[class*="finalPrice"]', '[class*="ProductPrice"]', '.price'
      ];
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            const text = await el.textContent();
            const n = parsePrice(text);
            if (n) { priceNum = n; break; }
          }
        } catch {}
      }
    }

    // 4) Shipping - look in body text. Be conservative: shipping for these
    // bulky goods is typically 20-80 €. We reject values close to the product
    // price (those are mis-matches) and values outside a sane shipping range.
    if (shippingNum === null) {
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const patterns = [
        /Versandkosten\s*(?:von|:|betragen|in H\u00f6he von)?\s*(\d{1,3}[,.]\d{2})\s*€/i,
        /zzgl\.?\s*(\d{1,3}[,.]\d{2})\s*€\s*(?:Versand|Sperrgut|Speditions)/i,
        /(?:Sperrgut|Speditionsversand|Speditionskosten)[^\d]{0,40}?(\d{1,3}[,.]\d{2})\s*€/i,
        /Versand\s*ab\s*(\d{1,3}[,.]\d{2})\s*€/i,
      ];
      for (const p of patterns) {
        const m = bodyText.match(p);
        if (m) {
          const n = parseFloat(m[1].replace(',', '.'));
          // Sane shipping range, and must be clearly less than product price
          if (n >= 0 && n <= 150 && (priceNum === null || n < priceNum * 0.5)) {
            shippingNum = n; break;
          }
        }
      }
      // Explicit free shipping phrases (only trust near "Versand" word)
      if (shippingNum === null && /versandkostenfrei|kostenloser\s+versand|gratisversand/i.test(bodyText)) {
        shippingNum = 0;
      }
    }

    await context.close();

    if (priceNum === null) return { error: 'Cena ni najdena' };
    return { price_num: priceNum, available, shipping_num: shippingNum };
  } catch (err) {
    await context.close().catch(() => {});
    return { error: err.message };
  }
}

// Auth middleware - checks secret key
const SECRET = process.env.SCRAPER_SECRET || '';
function checkAuth(req, res) {
  if (!SECRET) return true; // no secret set = open (not recommended)
  const provided = req.headers['x-scraper-key'] || req.body?.key;
  if (provided !== SECRET) {
    res.status(401).json({ error: 'Nepooblaščen dostop' });
    return false;
  }
  return true;
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'price-scraper' }));

app.post('/scrape', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Manjka URL' });
  const result = await scrapePage(url);
  res.json(result);
});

app.post('/scrape-many', async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { urls } = req.body; // { key: url }
  if (!urls) return res.status(400).json({ error: 'Manjkajo URL-ji' });

  const entries = Object.entries(urls).filter(([_, u]) => u && u.trim());
  const results = {};
  // Sequential to avoid overloading free tier
  for (const [key, url] of entries) {
    results[key] = await scrapePage(url.trim());
  }
  res.json({ results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
