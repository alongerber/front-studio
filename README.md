# FRONT · front-studio (v5)

אתר + שרת קטן על Vercel Functions ו-Postgres.
- `index.html`, `thanks.html`, `admin.html`, `assets/`: הדפים.
- `api/`: נקודות הקצה (הזמנה, PayPal, webhooks, מדידה, אדמין, cron).
- `lib/`: לוגיקה משותפת. `db/migrations/`: סכמה (רצה לבד).
- `docs/ANALYTICS_CONTRACT.md`: מה נמדד ואיך. `docs/DEPLOY.md`: התקנה. `docs/QA_RESULTS.md`: תוצאות בדיקה.
- בדיקות: `npm test` (שרת), `npm run e2e` (דפדפן, דורש Playwright).
