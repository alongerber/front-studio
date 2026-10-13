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

`ELEVENLABS_AGENT_ID` חובה. בלעדיו השיחה באתר מוצגת כ"לא זמינה" (עם וואטסאפ), נרשמת שגיאת הגדרה בלוג, ושיחות לא נקלטות. בייצור אין חזרה לסוכנת הבדיקה.

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
4. ההמשך (שליחת ה-Purchase הממתין של SNQA ובדיקה ב-Test Events) — סעיף ה5.

## חלק ד · סגירת הגישה הזמנית הישנה — ✅ בוצע ואומת (11/10)
מסך: https://vercel.com/alons-projects-65a14969/front-studio/Ag6EFeJiev57u9hspAzqxJyQQpES
⋯ → Delete. זו הפריסה `front-studio-mfjerfz94-…`, שנבנתה עם הסיסמה הזמנית. **לא** למחוק פריסה אחרת, ובמיוחד לא את הפריסה האחרונה של v5 או את Production.

---

## חלק ה · בדיקות על הזמנת SNQA (Preview, בלי רכישה חדשה)

**הכלל:** לא מבצעים רכישה חדשה. את ה-Resend של PayPal מבצע רק Claude in Chrome (Claude Code לא שולח Resend). "Make הצליח" פירושו שהמייל **נשלח**, לא שהוא **הגיע**. הגעה מאשרים רק מתוך תיבת Gmail עצמה.

### ה0 · בדיקת חיבור PayPal (קריאה בלבד) — הרצה חוזרת אחרי התיקון (12/10)
ריצה קודמת: ההתחברות, ה-webhook, הכתובת והאירועים תקינים. חיפוש האירועים נכשל ב-PayPal 400.
1. דשבורד → "אבחון טכני" → "חיבור PayPal (קריאה בלבד)" → `FR-Y7J2-SNQA` → "בדיקת חיבור".
2. לדווח את שורת **"חיפוש אירועים"**. היא אחת משתיים:
   - "החיפוש הצליח" עם מספר האירועים, או "לא נמצאו אירועים".
   - "החיפוש נכשל — לא ידוע אם יש אירועים".
3. לדווח את כל שורות **"ניסיון"**, כולל HTTP, name, message, `debug_id` ו-details. אין בהן סודות.
4. אם נמצאו אירועים, לדווח לכל מזהה אירוע: סוג, התקבל/לא, מספר משלוחים, ואם נדחה בחתימה.
לא משנים הגדרות ולא שולחים Resend.

### ה1 · כניסה ומצב לפני
1. https://front-studio-git-v5-alons-projects-65a14969.vercel.app/admin → "כניסה ראשונה או שכחתי סיסמה: שלחו לי קישור למייל" (לסמן "לזכור אותי"). אחרי הכניסה מהמייל מופיע למעלה "הגדרת סיסמה" ל-15 דקות. מגדירים אותה כדי לא לצטרך מייל בפעם הבאה. לא כותבים את הסיסמה בדוח.
2. חיפוש `FR-Y7J2-SNQA` → בכרטיס, תחת "אבחון טכני", לרשום:
   - "webhook של פייפאל": לכל **מזהה אירוע** — סוג האירוע ומספר המשלוחים שלו
   - `purchase_verified`
   - "מיילים בתור": האם יש שורה "ללקוח: אישור תשלום + קישור", ובאיזה סטטוס
   - אם האפיון כבר הושלם

### ה2 · קישור המשך, אישור תשלום וקישור חזרה — ✅ עבר (אלון אימת ידנית, 12/10: המייל הגיע, הקישור פתח את SNQA עם התשלום והפרטים, גם בגלישה בסתר)
1. בכרטיס SNQA: "יצירת קישור המשך ללקוח" → "פתיחה בחלון חדש". הקישור תקף 30 יום, ולא מבטל את הקישור המקורי של הלקוח. לא מדביקים אותו בדוח.
2. בעמוד ההזמנה שנפתח: שם, טלפון, ואימייל `alongerber@gmail.com` → שמירה.
3. מייל האישור יוצא **פעם אחת להזמנה**. אם בשלב ה1 כבר הייתה שורת "אישור תשלום" בסטטוס sent, לא יישלח מייל חדש, ובודקים את המייל הקודם.
4. ב-Gmail של alongerber@gmail.com: לחפש `"התשלום התקבל" FR-Y7J2-SNQA` (כולל Spam ו-Promotions). לדווח נמצא/לא נמצא, ובאיזו תיקייה.
5. במייל: "להמשיך לאפיון" → לפתוח **בפרופיל אחר או בחלון גלישה בסתר**. לבדוק שנפתחה SNQA עם הפרטים שכבר נשמרו, ושהכתובת היא כתובת ה-Preview.

### ה3 · השלמת אפיון והעברה להפקה — ✅ עבר (כרום, 12/10: האפיון הושלם, השדות נשמרו, השלב "כתיבת תסריט", רשומת finish אחת sent; תשלום אחד, capture אחד, purchase_verified אחד)
בעמוד ההזמנה של SNQA (מקישור ההמשך):
1. בשלב 02 לבחור **"מילוי עצמאי"**. לבדוק שפרטים שכבר נשמרו מופיעים בשדות.
2. ללחוץ "שמירה ושליחת האפיון" **בלי למלא**. אמורים להופיע ליד השדות "איזה עסק" ו"מה לקדם" הודעות "חסר: …", והאפיון לא אמור להיות מושלם.
3. למלא את שני השדות (מותר גם שדות נוספים) ולשלוח. האישור "קיבלנו את האפיון" אמור להופיע רק אחרי שהשרת שמר.
4. לבדוק ב-Gmail שהגיע לאלון `[preview] אפיון הושלם · FR-Y7J2-SNQA`, ורק פעם אחת. לפי תרחיש Make, במסלול finish ב-Preview **אין** מייל ללקוח, גם לא לכתובת הבדיקה (ראו "נמעני Make לפי מסלול" ב-HANDOFF_V5).
5. בדשבורד, בכרטיס: "אפיון: הושלם". התשלום לא השתנה.
6. אם משהו נכשל: לצלם את ההודעה ליד הכפתור ולדווח את הטקסט שלה. מעכשיו השרת רושם ביומן של Vercel כל דחייה עם הסיבה שלה (`[brief/finish] refused`).

### ה4 · Resend אחד (רק Claude in Chrome, פעם אחת, לא במקביל) — ✅ עבר (כרום, 12/10): משלוחי האירוע 1→2, משלוחים חוזרים בהזמנה 0→1, תשלום אחד, purchase_verified אחד, מייל "תשלום מאומת" אחד, סך המיילים נשאר 3
אירוע: `WH-17S883833T449544V-5X776969DC421502L` · `PAYMENT.CAPTURE.COMPLETED` · SNQA.
**מצב התחלתי (לתעד לפני השליחה):**
1. דשבורד → אבחון טכני → חיבור PayPal → `FR-Y7J2-SNQA` → בדיקת חיבור. לרשום **לשורת האירוע הזה בלבד**:
   - "משלוחים של מזהה זה" (צפוי 1).
   - "עובד" ומתי.
   - שגיאה, אם יש.
   - "משויך / לא משויך להזמנה".
   - לרשום גם את שורת האירוע השני (CHECKOUT.ORDER.APPROVED).
2. אם מופיע "לא משויך" ויש כפתור "שיוך N אירועים להזמנה": ללחוץ פעם אחת ולרשום את התוצאה. הפעולה לא מעבדת מחדש ולא שולחת דבר. לבדוק שבכרטיס SNQA, "webhook של פייפאל", המונה עלה בהתאם.
3. בכרטיס SNQA, תחת "אבחון טכני", לרשום:
   - מספר התשלומים (צפוי 1).
   - `purchase_verified` (צפוי 1).
   - "מיילים בתור": כמה שורות "הודעה לאלון: תשלום מאומת" (צפוי 1).
**השליחה:** developer.paypal.com → Sandbox → אירועי ה-webhook → האירוע הזה → Resend, **פעם אחת**.
**אחרי (להמתין דקה ולהריץ שוב את בדיקת החיבור):**
- לאותו מזהה אירוע, "משלוחים של מזהה זה": **2**.
- תשלומים: 1. `purchase_verified`: 1. שורות "תשלום מאומת" בתור: 1.
- אין מייל "תשלום מאומת" חדש ב-Gmail.
- אם לפני כן האירוע לא היה משויך, ה-Resend עצמו משייך אותו להזמנה (לפי `custom_id`). המונה בכרטיס יכול אז לקפוץ מ-0 ל-2. זה תקין.
**אם המונה לא עלה ל-2:** לא לשלוח שוב. לדווח מה הופיע, כולל שורת "נדחה באימות חתימה" אם יש.

### ה5 · Meta Purchase של SNQA ב-Test Events (Preview בלבד, בלי רכישה ובלי Resend) — ✅ עבר (אלון, צילום Events Manager, 13/10)
**התוצאה:** ב-Test Events של הפיקסל FRONT Pixel יש שני אירועי Purchase מהשרת, כל אחד פעם אחת, שניהם בסטטוס Processed. הסכום בשניהם 1290 ILS, ו-content_ids הוא `ad_1290`. ה-URL הוא כתובת ה-Preview.
- `FR-Y7J2-SNQA`: user data עם Email, External id, IP, Phone ו-User agent.
- `FR-9E48-HKS8`: user data עם External id, IP ו-User agent.

**לא לשלוח שוב.** השרת גם לא ישלח שוב אירוע שכבר נשלח.

<details><summary>ההוראות המקוריות (לתיעוד)</summary>

**מועד אחרון קשיח:** 7 ימים משעת התשלום של SNQA. אחרי זה השרת מסמן את האירוע "פג" ולא שולח, וגם Meta לא מקבלת אירוע ישן מ-7 ימים. אין דרך לפצות על זה בלי רכישה חדשה.
**מצב לפני (לרשום, בלי לשנות דבר):** כרטיס SNQA → אבחון טכני:
- "שולם" (תאריך ושעה) → המועד האחרון = אותה שעה + 7 ימים.
- "Meta Purchase": הסטטוס, מספר הניסיונות והשגיאה. צפוי: "ממתין לשליחה (… ניסיונות) not_configured".
- "הסכמה": מה כתוב אחרי "פרסום".
**לעצור ולדווח בלי להמשיך אם:**
- "פרסום: denied" או "ממתין להסכמה לפרסום": השרת לא שולח Purchase בלי הסכמה לפרסום, וזה לפי התכנון. לדווח בלבד.
- "נכשל", "פג" או "בוטל (החזר)": האירוע הזה לא יישלח שוב. לדווח בלבד.
**ההגדרה (רק Preview, ענף `v5`, בלי להעתיק ערכים לצ׳אט):**
1. Events Manager → הפיקסל `871649018702910` → Test Events → להעתיק את קוד הבדיקה → Vercel: `META_TEST_EVENT_CODE`, Environment = **Preview**, Git branch = **`v5`**.
2. Events Manager → Settings → Conversions API → Generate access token → Vercel: `META_CAPI_TOKEN`, **Preview**, branch **`v5`**, Sensitive.
3. לא לגעת במשתני Production. לא להגדיר `META_BROWSER_TEST_PIXEL_ID` (לא נדרש לבדיקה הזו).
4. לדווח "המשתנים הוגדרו". Claude יבנה פריסת Preview חדשה (משתנים נכנסים רק בבנייה חדשה). אפשר גם Redeploy ידני לפריסה האחרונה של v5.
**השליחה (פעם אחת):**
1. לפתוח את עמוד Test Events של הפיקסל ולהשאיר אותו פתוח.
2. דשבורד ה-Preview → "לנסות שוב עכשיו", **פעם אחת**. אירוע שחיכה רק להגדרות נשלח מיד (לא מחכה שעה).
3. לרשום את הודעת הסיום ("… Meta נשלחו").
**אחרי:**
- כרטיס SNQA → "Meta Purchase": "נשלח · כ-test_event_code". הכיתוב הזה נגזר ממה שנשלח בפועל, כלומר מהבקשה ששמורה בשרת.
- ב-Test Events: אירוע **Purchase אחד** מסוג Server, עם מזהה האירוע `FR-Y7J2-SNQA`, סכום 1290 ILS.
- **הבדיקה עוברת רק אם ה-Purchase נראה ב-Test Events.** הסטטוס "נשלח" בדשבורד לבדו לא מספיק.
- אם הדשבורד אומר "נשלח" ו-Test Events ריק: לא ללחוץ שוב (השרת לא ישלח שוב אירוע שנשלח). לדווח מה מופיע, כולל השגיאה אם יש.
- אם הסטטוס נשאר "ממתין" עם שגיאה `http_…`: לרשום אותה בדיוק ולא ללחוץ שוב.
**מה בדפדפן:** ב-Preview לא נטען הפיקסל האמיתי בכלל (מתוקן בקוד, פריסה של 12/10). לכן אירועי PageView, Contact ו-InitiateCheckout של Preview לא יופיעו ב-Test Events ולא ייספרו כנתוני אמת. ה-Purchase מגיע מהשרת בלבד.

---

</details>

### ה6 · טופס "עזרה בהזמנה" ב-Preview — פנייה אמיתית אחת (רק לכתובת של אלון)
המטרה: לוודא את המסלול החי (שמירה בשרת, מייל מ-Make ודשבורד). בלי רכישה ובלי שיחה עם מיטל.
1. בכתובת ה-Preview, בפוטר: "עזרה בהזמנה". אימייל: alongerber@gmail.com. תיאור: "בדיקת טופס עזרה, Preview". מספר הזמנה: להשאיר ריק.
2. ללחוץ "שליחה" **פעמיים מהר**. **צפוי:**
   - מופיע "הפנייה התקבלה. מספר הפנייה: P-…". לרשום את המספר.
   - בדשבורד מופיעה פנייה אחת בלבד.
3. לפתוח את SNQA מקישור ההזמנה (`/thanks#o=…`) → בפוטר "עזרה בהזמנה". **צפוי:** "ההזמנה FR-Y7J2-SNQA מצורפת לפנייה." ואין שדה להקליד מספר. לשלוח: "בדיקה מעמוד הזמנה".
4. Gmail: שני מיילים "[preview] פנייה P-… · עזרה בהזמנה" עם הבאנר הצהוב. בשני כתוב "FR-Y7J2-SNQA (מאומתת מעמוד ההזמנה)".
5. דשבורד → הכרטיס 'פניות "עזרה בהזמנה" (2 פתוחות)'. **צפוי:**
   - שתי פניות.
   - אחת מסומנת "מאומתת" ואחת "לא צוינה". מצב ההתראה: "נשלח".
   - אחרי "טופל" על שתיהן, השורה מסומנת "טופל", ואחרי רענון הכותרת מראה 0 פתוחות.

**לעצור ולדווח אם:**
- מופיע "הפנייה לא נשלחה" (לרשום את הנוסח);
- מופיעות שתי פניות מהלחיצה הכפולה;
- המייל לא הגיע תוך 5 דקות, והסטטוס בדשבורד הוא "ממתין לשליחה" או "נכשל".

## דוח חזרה (להעתיק ולמלא, בלי סודות)
```
א1 מסד ייצור: נוצר [כן/לא] · DATABASE_URL ב-Production בלבד [כן/לא]
א2–א6 משתנים ב-Production (הוגדר/לא): SITE_URL, ELEVENLABS_AGENT_ID, ELEVENLABS_WEBHOOK_SECRET, ADMIN_EMAIL,
   META_PIXEL_ID, META_CAPI_TOKEN, PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID,
   PAYPAL_MERCHANT_ID, MAKE_NOTIFY_URL, CRON_SECRET
PayPal Live webhook ID: ______   ·   ElevenLabs webhook ID (ייצור): ______
ג Preview: META_TEST_EVENT_CODE + META_CAPI_TOKEN על v5 [כן/לא] · Redeploy Preview [כן/לא]
ד הפריסה Ag6E… נמחקה [כן/לא]
ה0 חיבור PayPal: חיפוש אירועים [הצליח · נמצאו __ / הצליח · לא נמצאו / נכשל] · ניסיונות: [label → HTTP / name / debug_id] __ · אירועים ל-SNQA: [מזהה · סוג · התקבל · משלוחים] __
ה1 סיסמה הוגדרה [כן/לא] · לפני: [מזהה אירוע: משלוחים] __ / purchase_verified __ / שורת אישור תשלום: ____ / אפיון הושלם: ____
ה2 ✅ עבר (אלון, 12/10): מייל האישור הגיע; הקישור ממנו פתח את SNQA עם התשלום והפרטים, גם בגלישה בסתר
ה3 ✅ עבר (כרום, 12/10) · מילוי עצמאי: שדות חסרים סומנו [כן/לא] · נשלח והוצג אישור [כן/לא] · מייל "אפיון הושלם" לאלון: [נמצא פעם אחת/לא/יותר מפעם] · תשלום לא השתנה [כן/לא]
ה4 ✅ עבר (12/10) · Resend WH-17S883833T449544V-5X776969DC421502L: לפני — משלוחים __ / משויך __ / תשלומים __ / purchase_verified __ / "תשלום מאומת" בתור __ · אחרי — משלוחים __ / תשלומים __ / purchase_verified __ / "תשלום מאומת" בתור __ / מייל תשלום חדש ב-Gmail [כן/לא]
חריגות: ______
```
