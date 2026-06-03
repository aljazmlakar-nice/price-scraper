# Price Scraper (Playwright)

Scraping server ki uporablja pravi brskalnik (Playwright/Chromium) za branje cen s spletnih strani — tudi JavaScript strani.

## Render deploy

1. Ustvari GitHub repozitorij `price-scraper` in naloži te datoteke
2. Na [render.com](https://render.com) → **New Web Service**
3. Izberi repozitorij `price-scraper`
4. Nastavitve:
   - **Runtime:** Docker
   - **Instance Type:** Free
5. **Create Web Service**

Render bo zaznal `Dockerfile` in samodejno postavil Playwright.

## API

- `GET /` — health check
- `POST /scrape` — `{ "url": "https://..." }` → `{ price_num, available, shipping_num }`
- `POST /scrape-many` — `{ "urls": { "key": "url" } }` → `{ results: { key: {...} } }`

## URL strežnika

Po deployu dobiš URL kot `https://price-scraper-xxxx.onrender.com` — tega vneseš v price-monitor-v2 aplikacijo.
