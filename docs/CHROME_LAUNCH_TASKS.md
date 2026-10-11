# משימות ביצוע ל-Claude in Chrome · השקת FRONT v5

נכתב 11/10/2026 מתוך הקוד בענף `v5`. כל שם משתנה, כתובת ומזהה כאן נבדקו מול הקוד או מול השירות עצמו.

## כללים לביצוע
- **אין סודות בצ׳אט, בקבצים או בצילומי מסך.** ערך סודי עובר רק בהעתק-הדבק ישירות מהשירות שמייצר אותו לשדה ב-Vercel. בדוח החזרה כותבים רק "הוגדר" או "לא הוגדר".
- **לא ללחוץ Redeploy ב-Production, לא למזג ל-main ולא להפעיל קמפיין.** משתני Production נכנסים לתוקף רק בפריסה הבאה של main, והיא תקרה רק באישור אלון.
- **אין חיוב אמיתי.** כל בדיקת תשלום כאן נעשית ב-Sandbox, על הזמנה קיימת.
- אם מסך נראה אחרת מהמתואר כאן, עוצרים ומדווחים מה רואים. לא מנחשים.

## מזהים קבועים
| מה | ערך |
|---|---|
| פרויקט Vercel | `front-studio` · team `alons-projects-65a14969` |
| כתובת ייצור (SITE_URL) | `https://front-studio.vercel.app` |
| כתובת Preview (v5) | `https://front-studio-git-v5-alons-projects-65a14969.vercel.app` |
| סוכנת **ייצור** | `agent_8501m4mbsfasegqbr208yx71ctm7` ("FRONT — מיטל — Production (טרם הופעלה)") |
| סוכנת **בדיקה** (לא לייצור) | `agent_5801m4a74w3dfawt9hdjhbe1nrjc` |
| פיקסל / Dataset של Meta | `871649018702910` |
| תרחיש המיילים ב-Make | `7867409` "FRONT v5 · מיילים מהשרת" (משרת את שתי הסביבות; הסביבה עוברת בשדה `environment`) |
| הזמנת הבדיקה | `FR-Y7J2-SNQA` (שולמה ב-Sandbox, Capture `076940725B8327510`) |

---

## חלק א · Production ב-Vercel

מסך: https://vercel.com/alons-projects-65a14969/front-studio/settings/environment-variables
בכל משתנה כאן: **Environment = Production בלבד** (לא Preview ולא Development). סוד מסומן **Sensitive**.

### א1 · מסד נתונים נפרד לייצור
מסך: https://vercel.com/alons-projects-65a14969/front-studio/stores
1. Create Database → Neon → שם `front-v5-production`, אזור כמו ה-Preview (`iad1` / US East).
2. Connect Project → `front-studio` → **Environments: Production בלבד**. Custom prefix: `DATABASE` (כך נוצר `DATABASE_URL`, השם שהקוד קורא).
3. **לא** לחבר את המסד הקיים `front-v5-preview` ל-Production, ולא להעתיק ממנו נתונים. הטבלאות נוצרות לבד בבקשה הראשונה.

### א2 · משתנים שלא סודיים
| שם | ערך | סביבה |
|---|---|---|
| `SITE_URL` | `https://front-studio.vercel.app` | Production |
| `ELEVENLABS_AGENT_ID` | `agent_8501m4mbsfasegqbr208yx71ctm7` | Production |
| `ADMIN_EMAIL` | `alongerber@gmail.com` | Production |
| `META_PIXEL_ID` | `871649018702910` | Production |
| `PAYPAL_ENV` | `live` | Production |
| `PAYPAL_MERCHANT_ID` | Merchant ID של חשבון ה-PayPal **העסקי האמיתי** (ראו א3) | Production |
| `PAYPAL_WEBHOOK_ID` | מזהה ה-webhook שייווצר ב-א3 | Production |

`ELEVENLABS_AGENT_ID` חובה. בלעדיו הקוד חוזר לסוכנת הבדיקה, ושיחות של סוכנת הייצור נזרקות (`api/elevenlabs/webhook.js:155`).

### א3 · PayPal Live
מסך: https://developer.paypal.com/dashboard/applications/live
1. מצב **Live** (לא Sandbox) → Create App → שם `FRONT production`, סוג Merchant.
2. Client ID → `PAYPAL_CLIENT_ID` (Production, Sensitive). Secret → `PAYPAL_CLIENT_SECRET` (Production, Sensitive).
3. באותה אפליקציה → Live Webhooks → Add Webhook:
   - URL: `https://front-studio.vercel.app/api/paypal/webhook`
   - אירועים, בדיוק שישה: `Checkout order approved` (CHECKOUT.ORDER.APPROVED), `Payment capture completed`, `Payment capture pending`, `Payment capture denied`, `Payment capture refunded`, `Payment capture reversed`
   - מזהה ה-webhook שנוצר (Webhook ID) → `PAYPAL_WEBHOOK_ID`. זה מזהה, לא סוד; לדווח אותו בחזרה.
4. Merchant ID של החשבון העסקי: paypal.com (חשבון אמיתי) → Account Settings → Business information → PayPal Merchant ID → `PAYPAL_MERCHANT_ID`.
5. **לא** לבצע תשלום Live לבדיקה.

### א4 · מיילים
| שם | מאיפה | סביבה |
|---|---|---|
| `MAKE_NOTIFY_URL` (Sensitive) | Make → תרחיש 7867409 → המודול הראשון (Webhooks) → Copy address. אותה כתובת כמו ב-Preview: התרחיש מבחין בסביבה לפי השדה `environment` | Production |

**לא להגדיר** `NOTIFY_TEST_RECIPIENTS` ב-Production. ממילא הקוד מתעלם ממנו בייצור (`api/brief/contact.js:19`), ותרחיש Make שולח בייצור לכל כתובת שהלקוח מסר. ההגבלה ל-alongerber@gmail.com חלה רק מחוץ לייצור.

### א5 · Meta
מסך: https://business.facebook.com/events_manager2/list/pixel/871649018702910/settings
1. Settings → Conversions API → Generate access token → `META_CAPI_TOKEN` (Production, Sensitive).
2. **לא להגדיר** `META_TEST_EVENT_CODE` ב-Production. רכישת ייצור תישלח רק כשה-PayPal הוא Live.

### א6 · Cron
`CRON_SECRET` (Production, Sensitive): מחרוזת אקראית של 40 תווים לפחות, למשל מתוך מחולל סיסמאות. Vercel שולח אותה לבד לריצה היומית `/api/cron/meta-flush`.

### א7 · מה **לא** להגדיר ב-Production
`NOTIFY_TEST_RECIPIENTS`, `META_TEST_EVENT_CODE`, `ADMIN_USER`, `ADMIN_PASSWORD_HASH`, `FRONT_ENV`. את `DELIVERY_TIME_TEXT` לא צריך: ברירת המחדל בקוד היא הנוסח המאושר.

---

## חלק ב · ElevenLabs: webhook ייצור
מסך: https://elevenlabs.io/app/agents/settings (Agents → Settings → Webhooks). לא בדקתי את שמות התפריטים המדויקים.
1. Create webhook → URL: `https://front-studio.vercel.app/api/elevenlabs/webhook`, אימות HMAC.
2. הסוד מוצג פעם אחת → `ELEVENLABS_WEBHOOK_SECRET` ב-Vercel (Production, Sensitive).
3. לדווח בחזרה את **מזהה ה-webhook** (לא את הסוד). את השיוך לסוכנת 8501 Claude Code יעשה.
4. **לא לשנות** את ה-webhook הקיים `7cc2c509…` ולא את סוכנת הבדיקה 5801.

## חלק ג · Preview (ענף v5): Meta Test Events
מסך: https://business.facebook.com/events_manager2/list/pixel/871649018702910/test_events
1. מהעמוד Test Events: קוד הבדיקה (TEST…) → `META_TEST_EVENT_CODE`, **Environment = Preview, Git branch = `v5`**.
2. אותו טוקן מ-א5 → `META_CAPI_TOKEN`, **Preview, branch `v5`**, Sensitive.
3. לפתוח את ה-Preview פעם אחת כדי שתיבנה פריסה חדשה עם המשתנים: Vercel → Deployments → הפריסה האחרונה של v5 → Redeploy. **רק ב-Preview.**

## חלק ד · סגירת הגישה הזמנית הישנה
מסך: https://vercel.com/alons-projects-65a14969/front-studio/Ag6EFeJiev57u9hspAzqxJyQQpES
⋯ → Delete. זו הפריסה `front-studio-mfjerfz94-…`, שנבנתה עם הסיסמה הזמנית. **לא** למחוק פריסה אחרת, ובמיוחד לא את הפריסה האחרונה של v5 או את Production.

---

## חלק ה · בדיקות על הזמנת SNQA (Preview, בלי רכישה חדשה)

### ה1 · מצב לפני
1. https://front-studio-git-v5-alons-projects-65a14969.vercel.app/admin → כניסה (קישור למייל של אלון, עם "זכור אותי").
2. לפתוח את ההזמנה `FR-Y7J2-SNQA` ולרשום:
   - סטטוס ותשלום
   - "webhook של פייפאל": X משלוחים, מתוכם Y חוזרים
   - שורות המיילים (paid / receipt / finish): סטטוס, ניסיונות, שגיאה
   - מספר אירועי `purchase_verified`
   - האם האפיון כבר נשלח

### ה2 · מייל אישור + קישור אישי
- **אם יש שורת receipt בסטטוס sent:** ב-Gmail של alongerber@gmail.com לחפש `"התשלום התקבל" FR-Y7J2-SNQA`. לדווח אם נמצא, ובאיזו תיקייה (Inbox / Spam / Promotions).
- **אם אין שורת receipt:** לפתוח את עמוד ההזמנה של SNQA בדפדפן שבו שולם (בכתובת ה-Preview, `/thanks`). בטופס הפרטים: שם, טלפון, ואימייל `alongerber@gmail.com` → שמירה. ואז ב-Gmail כנ״ל. אם העמוד לא נפתח עם ההזמנה, כי הקישור לא שמור בדפדפן, לעצור ולדווח. **לא לבצע רכישה חדשה בלי אישור.**
- במייל: להעתיק את כתובת הכפתור "להמשיך לאפיון" ולפתוח אותה **בחלון גלישה בסתר / פרופיל אחר**. לבדוק שהיא פותחת את אותה הזמנה SNQA עם הפרטים שכבר נשמרו, ושהכתובת מתחילה ב-`https://front-studio-git-v5-…` (כתובת ה-Preview, כי זו סביבת בדיקה). לא להדביק את הקישור בדוח.

### ה3 · העברה להפקה
באותו חלון: אם האפיון עוד לא נשלח, ללחוץ "שליחת האפיון". לבדוק שהגיע ל-alongerber@gmail.com מייל `[preview] אפיון הושלם · FR-Y7J2-SNQA`. **לא** אמור להגיע מייל ללקוח, כי זו לא סביבת ייצור.

### ה4 · webhook חוזר
מסך: https://developer.paypal.com/dashboard/ → מצב **Sandbox** → Event Logs / Webhooks Events (לא בדקתי את שם התפריט המדויק).
1. לאתר אירוע `PAYMENT.CAPTURE.COMPLETED` של Capture `076940725B8327510`, ששייך ל-webhook `2GM46818V44253024`.
2. Resend.
3. בדשבורד, בהזמנת SNQA: מספר המשלוחים עלה ב-1, "חוזרים" עלה ב-1, מספר `purchase_verified` **לא** השתנה, ולא נוסף מייל paid נוסף.

---

## דוח חזרה (להעתיק ולמלא, בלי סודות)
```
א1 מסד ייצור: נוצר [כן/לא] · DATABASE_URL ב-Production בלבד [כן/לא]
א2–א6 משתנים ב-Production (הוגדר/לא): SITE_URL, ELEVENLABS_AGENT_ID, ELEVENLABS_WEBHOOK_SECRET, ADMIN_EMAIL,
   META_PIXEL_ID, META_CAPI_TOKEN, PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID,
   PAYPAL_MERCHANT_ID, MAKE_NOTIFY_URL, CRON_SECRET
PayPal Live webhook ID: ______   ·   ElevenLabs webhook ID (ייצור): ______
ג Preview: META_TEST_EVENT_CODE + META_CAPI_TOKEN על v5 [כן/לא] · Redeploy Preview [כן/לא]
ד הפריסה Ag6E… נמחקה [כן/לא]
ה1 לפני: משלוחים __ / חוזרים __ / purchase_verified __ / receipt: ____ / finish: ____
ה2 מייל אישור ב-Gmail: [נמצא בתיקייה __ / לא נמצא] · קישור בחלון אחר פתח את SNQA עם הפרטים [כן/לא]
ה3 מייל "אפיון הושלם" לאלון: [נמצא/לא]
ה4 אחרי Resend: משלוחים __ / חוזרים __ / purchase_verified __
חריגות: ______
```
