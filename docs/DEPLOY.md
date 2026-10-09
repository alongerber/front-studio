# FRONT v5 · התקנה והעלאה

מסמך לאלון. בלי סיסמאות ובלי טוקנים: כל ערך סודי מוזן ישירות ב-Vercel ולא עובר בצ'אט.

## 0. מה לא לעשות עד שהבדיקות עוברות
- **לא להפעיל את תקציב ה-350 ₪ ליום** עד שבסביבת Preview עברו: תשלום sandbox מלא, webhook כפול, Purchase אחד ב-Meta (ב-Test Events), ואפיון שנשמר.
- לא להעלות ל-main לפני שה-Preview עבר. main = האתר החי.

## 1. העלאה ל-Preview (בלי לגעת באתר החי)
הפרויקט ב-Vercel מחובר ל-GitHub (`alongerber/front-studio`). כל ענף שאינו `main` מקבל כתובת Preview משלו, ולא משנה את האתר החי.
1. ב-GitHub, בריפו `front-studio`: **Add file → Upload files**.
2. לגרור את **תוכן** התיקייה `front-v5` (לא את התיקייה עצמה). בלי `node_modules`.
3. בתחתית: לבחור **Create a new branch for this commit**, ושם ענף: `v5`. ואז **Propose changes / Commit**.
4. Vercel בונה Preview לבד. הכתובת מופיעה ב-Vercel → front-studio → Deployments.

> קבצים שנמחקו מהגרסה הקודמת (כמו `live`-assets ישנים) לא נמחקים בהעלאה כזו. זה לא שובר כלום, אבל לפני המיזוג ל-main כדאי לנקות.

## 2. משתני סביבה
איפה: **Vercel → front-studio → Settings → Environment Variables**. לכל משתנה לבחור את הסביבה (Production / Preview).

| משתנה | Preview | Production | מאיפה מגיע |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | נוצר אוטומטית בחיבור Neon מה-Marketplace (סעיף 3) |
| `PAYPAL_ENV` | `sandbox` | `live` | ערך קבוע |
| `PAYPAL_CLIENT_ID` | sandbox | live | developer.paypal.com → Apps & Credentials (Sandbox / Live) → האפליקציה |
| `PAYPAL_CLIENT_SECRET` | sandbox | live | אותו מקום. **סודי** |
| `PAYPAL_WEBHOOK_ID` | sandbox | live | בתוך האפליקציה → Webhooks → אחרי שמוסיפים webhook (סעיף 4) |
| `PAYPAL_MERCHANT_ID` | sandbox | live | paypal.com → Account Settings → Business information → PayPal Merchant ID. בלעדיו בדיקת המוטב מדולגת ומסומנת בדשבורד |
| `META_PIXEL_ID` | `871649018702910` | `871649018702910` | לא סודי |
| `META_CAPI_TOKEN` | ✓ | ✓ | Events Manager → ה-Dataset → Settings → Conversions API → Generate access token. **סודי** |
| `META_TEST_EVENT_CODE` | ✓ | **לא להגדיר** | Events Manager → Test events. רק ב-Preview |
| `ELEVENLABS_WEBHOOK_SECRET` | ✓ | ✓ | ElevenLabs → Agents → Settings → Post-call webhook (סעיף 5). **סודי** |
| `ELEVENLABS_AGENT_ID` | לא חובה | לא חובה | ברירת מחדל: מיטל `agent_5801…` |
| `MAKE_NOTIFY_URL` | ✓ | ✓ | Make → תרחיש **FRONT v5 · מיילים מהשרת** → מודול ה-Webhook → Copy address. **סודי**: מי שיש לו את הכתובת יכול לשלוח מיילים בשמך |
| `ADMIN_USER` | ✓ | ✓ | שם משתמש לדשבורד, לבחירתך |
| `ADMIN_PASSWORD_HASH` | ✓ | ✓ | במחשב שלך: `node scripts/hash-password.js` (הסיסמה לא מוצגת ולא נשמרת). מדביקים את השורה שמתחילה ב-`scrypt$` |
| `CRON_SECRET` | ✓ | ✓ | מחרוזת אקראית ארוכה כלשהי. Vercel שולח אותה לבד לריצה היומית |
| `SITE_URL` | `https://front-studio-git-v5-alons-projects-65a14969.vercel.app` | `https://front-studio.vercel.app` | |

אחרי הזנה: **Redeploy** ל-Preview (Deployments → ⋯ → Redeploy), כי משתנים חדשים נכנסים רק לבנייה חדשה.

**מסד נתונים נפרד ל-Preview (מומלץ):** ב-Neon אפשר להצמיד ל-Preview ענף (branch) נפרד של מסד הנתונים. הקוד מסנן הכול לפי `environment`, כולל תורי Meta והמיילים, אבל הפרדה פיזית מונעת טעויות.
**Migrations:** רצות לבד בפנייה הראשונה. אפשר גם ידנית מהמחשב: `DATABASE_URL=... npm run migrate`.

הפרדת בדיקה/ייצור: כל שורה בטבלאות נשמרת עם `environment` (preview / production), והשרת מסנן לפיו. בדיקות ב-Preview לא מופיעות בדשבורד של Production, ו-PayPal ב-Preview הוא sandbox בלבד.

## 3. Postgres (Neon) · עלות לפני התחייבות
חיבור: Vercel → front-studio → **Storage** (או Marketplace) → Neon → Create → לחבר ל-Production ול-Preview. הטבלאות נוצרות לבד בפנייה הראשונה (migrations אוטומטיות).

| | Free | Launch |
|---|---|---|
| מחיר | 0 | $0.106 לשעת CU + $0.35 ל-GB בחודש, בלי מינימום |
| מחשוב | 100 שעות CU בחודש לפרויקט | לפי שימוש |
| אחסון | 1 GB לפרויקט | לפי שימוש |
| כשנגמר | **המחשוב מושהה עד החודש הבא** = האתר לא יכול ליצור הזמנות | אין עצירה |

הערכה שלי: עם קמפיין פעיל, ה-DB ער רוב שעות היום (נרדם רק אחרי 5 דקות בלי פניות). במינימום 0.25 CU זה בערך 3–6 שעות CU ביום, כלומר 90–180 בחודש. **על Free זה גבולי, ונפילה = הזמנות שלא נקלטות.** ב-Launch זה בערך $10–20 לחודש. המלצה: Free לבדיקות, ולעבור ל-Launch לפני הפעלת התקציב. ההחלטה שלך.

## 4. PayPal
1. developer.paypal.com → **Apps & Credentials** → מתג **Sandbox** → Create App. ממלאים את משתני ה-sandbox ב-Preview.
2. באפליקציה → **Add Webhook**: כתובת `https://<preview-url>/api/paypal/webhook`. אירועים: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`. מעתיקים את ה-Webhook ID ל-`PAYPAL_WEBHOOK_ID`.
3. Live: אותו דבר עם מתג **Live**. לפי התיעוד של PayPal, אישור אפליקציית Live יכול לקחת 24–72 שעות. **להתחיל את זה עכשיו.**
4. כתובת קבועה ל-Preview: לענף `v5` יש כתובת שלא משתנה בין העלאות, `https://front-studio-git-v5-alons-projects-65a14969.vercel.app` (לפי תבנית הכתובות של Vercel; לוודא ב-Deployments אחרי ההעלאה הראשונה). לה מכוונים את ה-webhooks של ה-sandbox. בדקתי: לפרויקט אין הגנת סיסמה או SSO על Preview, אז PayPal ו-ElevenLabs יוכלו להגיע אליו.

## 5. ElevenLabs (נתוני שיחה)
1. elevenlabs.io/app/agents/settings → **Post-call webhook** → יצירה עם הכתובת `https://<url>/api/elevenlabs/webhook`, סוג transcription.
2. את ה-secret שמוצג ביצירה מדביקים ישר ל-`ELEVENLABS_WEBHOOK_SECRET` ב-Vercel.
3. לוודא שהסוכנת מיטל (`agent_5801…`) משתמשת ב-webhook הזה.
כבר עשיתי בסוכנת: שדות Data Collection לפי החוזה (סוג עסק, מטרה, התנגדויות, שלב אחרון וכו'), סיכום בעברית, ו-placeholders למשתני הקישור (`front_link`, `session_id` וכו'). הסוכנת הזו לא מחוברת לאתר החי, אז זה לא שינה כלום שם.

## 6. Make
התרחיש `FRONT · הזמנות (API)` הוסב ל-**FRONT v5 · מיילים מהשרת**, עם כתובת webhook חדשה שלא פורסמה בשום קוד לקוח. יש בו רק שני מסלולים: `paid` (מייל אליך) ו-`finish` (מייל אליך, ומייל ללקוח רק ב-production). אין בו יותר data store ואין בו אישור תשלום. נבדק: שלוש ריצות הצליחו, ושני מיילי בדיקה נשלחו אליך (הזמנה `FR-TEST-V5P1`). במייל התשלום של הבדיקה התגית בנושא יצאה ריקה, כי שדה הסביבה עוד לא נשלח. תיקנתי את זה בקוד.
התרחיש הישן `תשלום נכנס` עדיין פעיל כי האתר החי משתמש בו. לכבות אותו אחרי ש-v5 עולה ל-main.

## 7. Vercel: תוכנית
לפי ה-Fair Use Guidelines של Vercel, תוכנית Hobby מיועדת לשימוש אישי לא מסחרי. גבייה מהגולשים ופרסום מכירה של שירות מוגדרים שם במפורש כשימוש מסחרי, וזה מחייב Pro. לא הצלחתי לראות דרך ה-API באיזו תוכנית החשבון שלך. אם זה Hobby, זה סיכון שהפרויקט יושהה באמצע קמפיין. כדאי לבדוק ב-Vercel → Settings → Billing.

## 8. בדיקות לפני main (ב-Preview)
1. תשלום sandbox מלא → הדף מראה "התשלום התקבל". בדשבורד יש רכישה אחת, וב-Meta Test Events יש Purchase אחד.
2. תשלום sandbox, ואז לסגור את הטאב מיד אחרי האישור → תוך דקה ההזמנה מופיעה כמשולמת (webhook).
3. PayPal developer → Webhooks → **Resend** לאותו אירוע → עדיין רכישה אחת.
4. שיחה עם מיטל → בתוך כמה דקות מופיעה בדשבורד בהזמנה הנכונה (עד אז: "ממתין לנתוני שיחה").
5. מכשיר אחר עם הקישור האישי → רואים את ההזמנה. קישור עם טוקן שגוי → "לא מצאנו הזמנה".
6. **בדפדפן של פייסבוק ושל אינסטגרם** (לפתוח את קישור ה-Preview מתוך הודעה בפייסבוק/אינסטגרם): לפתוח תשלום, לשלם ב-sandbox, ולחזור. **את זה לא בדקתי**: היה רק user-agent מדומה.
