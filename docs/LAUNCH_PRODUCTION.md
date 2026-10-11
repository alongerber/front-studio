# מעבר לייצור — מה קיים ומה חסר (נבדק 11/10/2026, עודכן אחרי הכנת סוכנת הייצור)

**מצב Production היום:** הפרויקט `front-studio` מגיש את האתר הישן מ-`main` (commit `384324d`, פריסה `dpl_76YzovmsTUzQu7S5VZ4MJsdxRrS8`) בכתובת https://front-studio.vercel.app. ב-Production מוגדרים **0 משתני סביבה** (`hiddenProductionEnvCount: 0`). גרסת v5 קיימת רק ב-Preview.

הדשבורד (`/admin` → בריאות → "מוכנות לייצור") בודק את כל הסעיפים האלה בסביבה שבה הוא רץ, ומציג שמות בלבד, בלי ערכים.

| רכיב | Preview (v5) | Production | מה חסר |
|---|---|---|---|
| מסד נתונים | Neon `front-v5-preview` (DATABASE_URL ושות׳, Preview בלבד) | אין | מסד Neon **נפרד** לייצור, מחובר ל-Production בלבד. המיגרציות רצות אוטומטית בבקשה הראשונה. לא לחבר את מסד ה-Preview |
| PayPal | Sandbox: CLIENT_ID, CLIENT_SECRET, WEBHOOK_ID `2GM46818V44253024`, MERCHANT_ID `L5XMZ6WTKKV4A`, PAYPAL_ENV=sandbox | אין | אפליקציית **Live** ב-developer.paypal.com: CLIENT_ID + SECRET, MERCHANT_ID של חשבון Live, PAYPAL_ENV=live, ו-webhook Live אל `<כתובת סופית>/api/paypal/webhook` עם האירועים PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED / REVERSED ו-CHECKOUT.ORDER.APPROVED, ומזהה ה-webhook ב-PAYPAL_WEBHOOK_ID. הקוד מוגבל ל-Sandbox בכל סביבה שאינה Production |
| סוכנת | `agent_5801m4a74w3dfawt9hdjhbe1nrjc` (סוכנת בדיקה). `check_payment` (`tool_6901…`) וה-webhook `7cc2c509…` מצביעים לכתובת ה-Preview | **הוכנה 11/10:** `agent_8501m4mbsfasegqbr208yx71ctm7` ("FRONT — מיטל — Production (טרם הופעלה)"), אותו פרומפט וכלים, `check_payment` נפרד `tool_6001m4mbs795frybfr8j78xwg4m8` אל `https://front-studio.vercel.app/api/agent/payment-status`. ה-webhook של ה-Preview **נותק** ממנה, כדי ששיחות ייצור לא ייכנסו למסד הבדיקה | ב-ElevenLabs: webhook post-call חדש אל `https://front-studio.vercel.app/api/elevenlabs/webhook` ושיוכו לסוכנת 8501 (הסוד מוצג רק במסך). ב-Vercel Production: ELEVENLABS_AGENT_ID=`agent_8501m4mbsfasegqbr208yx71ctm7` ו-ELEVENLABS_WEBHOOK_SECRET. כל שינוי פרומפט עתידי ב-5801 צריך להיות מועתק גם ל-8501 |
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

## גישה זמנית ישנה (נבדק 11/10)
- ב-Preview, ADMIN_PASSWORD_HASH כבר הוחלף בערך לא תקין, כך שבכתובת ה-Preview אי אפשר להיכנס איתו.
- אבל הפריסה `dpl_Ag6EFeJiev57u9hspAzqxJyQQpES` (`front-studio-mfjerfz94-…vercel.app`, commit 6d4fbfe) נבנתה כ-20 שניות **אחרי** שהסיסמה הזמנית הוגדרה ו**לפני** שבוטלה, ולכן כנראה עדיין מקבלת אותה. היא READY, ובפרויקט אין הגנת Vercel על Preview. החשיפה: דשבורד של נתוני בדיקה בלבד, למי שיודע גם את הכתובת וגם את הסיסמה.
- לסגירה: מחיקת הפריסה הזו (דורש אישור אלון; אין לי כלי מחיקה). לא להפעיל הגנת Vercel על כל ה-Preview: היא תחסום את ה-webhooks של PayPal ו-ElevenLabs.
