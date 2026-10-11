# מעבר לייצור — מה קיים ומה חסר (נבדק 11/10/2026)

**מצב Production היום:** הפרויקט `front-studio` מגיש את האתר הישן מ-`main` (commit `384324d`, פריסה `dpl_76YzovmsTUzQu7S5VZ4MJsdxRrS8`) בכתובת https://front-studio.vercel.app. ב-Production מוגדרים **0 משתני סביבה** (`hiddenProductionEnvCount: 0`). גרסת v5 קיימת רק ב-Preview.

הדשבורד (`/admin` → בריאות → "מוכנות לייצור") בודק את כל הסעיפים האלה בסביבה שבה הוא רץ, ומציג שמות בלבד, בלי ערכים.

| רכיב | Preview (v5) | Production | מה חסר |
|---|---|---|---|
| מסד נתונים | Neon `front-v5-preview` (DATABASE_URL ושות׳, Preview בלבד) | אין | מסד Neon **נפרד** לייצור, מחובר ל-Production בלבד. המיגרציות רצות אוטומטית בבקשה הראשונה. לא לחבר את מסד ה-Preview |
| PayPal | Sandbox: CLIENT_ID, CLIENT_SECRET, WEBHOOK_ID `2GM46818V44253024`, MERCHANT_ID `L5XMZ6WTKKV4A`, PAYPAL_ENV=sandbox | אין | אפליקציית **Live** ב-developer.paypal.com: CLIENT_ID + SECRET, MERCHANT_ID של חשבון Live, PAYPAL_ENV=live, ו-webhook Live אל `<כתובת סופית>/api/paypal/webhook` עם האירועים PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED / REVERSED ו-CHECKOUT.ORDER.APPROVED, ומזהה ה-webhook ב-PAYPAL_WEBHOOK_ID. הקוד מוגבל ל-Sandbox בכל סביבה שאינה Production |
| סוכנת | `agent_5801m4a74w3dfawt9hdjhbe1nrjc` (סוכנת בדיקה). הכלי `check_payment` וה-webhook שלה מצביעים לכתובת ה-Preview | אין | סוכנת ייצור: שכפול של 5801 עם `check_payment` אל `<כתובת סופית>/api/agent/payment-status`, ו-webhook post-call אל `<כתובת סופית>/api/elevenlabs/webhook` עם סוד חדש. ב-Vercel: ELEVENLABS_AGENT_ID (הדף מקבל את המזהה מהשרת) ו-ELEVENLABS_WEBHOOK_SECRET. הדשבורד מסמן אם בייצור מוגדרת סוכנת הבדיקה |
| מיילים | MAKE_NOTIFY_URL (תרחיש 7867409). NOTIFY_TEST_RECIPIENTS=alongerber@gmail.com | אין | MAKE_NOTIFY_URL ל-Production. **לא** להגדיר NOTIFY_TEST_RECIPIENTS בייצור, אחרת לקוחות לא יקבלו מייל |
| דשבורד | ADMIN_EMAIL=alongerber@gmail.com. ADMIN_USER/ADMIN_PASSWORD_HASH זמניים (ערך "disabled") | אין | ADMIN_EMAIL בלבד. לא להעתיק את ADMIN_USER/ADMIN_PASSWORD_HASH |
| Meta | META_PIXEL_ID `871649018702910` | אין | META_PIXEL_ID ו-META_CAPI_TOKEN. **בלי** META_TEST_EVENT_CODE בייצור. ב-Preview: META_CAPI_TOKEN + META_TEST_EVENT_CODE כדי לראות Purchase ב-Test Events |
| כתובת | SITE_URL = כתובת ה-Preview | אין (ברירת המחדל בקוד: https://front-studio.vercel.app) | SITE_URL = הכתובת הסופית. ממנה נבנים הקישור האישי במייל, קישור הכניסה לדשבורד וקישורי ההזמנה. דומיין מותאם לא מחובר לפרויקט (קיים רק `front-studio.vercel.app`) |
| Cron | — | אין | CRON_SECRET (ריצת השחזור היומית `/api/cron/meta-flush`) |
| קוד | ענף `v5` | `main` (אתר ישן) | מיזוג v5 → main **רק באישור אלון**, אחרי שכל המשתנים למעלה מוגדרים |

## הפרדה מנתוני הבדיקה
- המסדים נפרדים לפי סביבה, וכל שורה נושאת `environment`. השאילתות מסננות לפיה.
- מחוץ ל-Production: PayPal תמיד Sandbox, ביט חסום, באנר "סביבת בדיקה", מיילים ללקוח רק לנמען הבדיקה, ו-Purchase ל-Meta רק עם קוד בדיקה.
- בייצור, Purchase נשלח כאירוע אמיתי רק כש-PayPal הוא Live.

## קישורים במיילים ובהזמנה
כולם נבנים מ-`SITE_URL`: `cfg.siteUrl + '/thanks#o=…&t=…'`, `cfg.siteUrl + '/admin#login=…'`. אם SITE_URL חסר, הקישורים מפנים ל-https://front-studio.vercel.app. לכן חובה להגדיר אותו לכתובת הסופית לפני ההשקה.
