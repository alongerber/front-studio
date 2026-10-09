# FRONT v5 — מסמך העברה (מקור אחד לשני הסשנים)

עודכן: 2026-10-09 22:25 UTC · ענף `v5` · Preview בלבד · אין מיזוג ל-main.

## איפה בודקים
- Preview קבוע של הענף: https://front-studio-git-v5-alons-projects-65a14969.vercel.app
- פריסה אחרונה: ראו טבלת "פריסות" למטה. Vercel project `prj_rWYhxn7MbfTYJD0Utets1yYWtnlo`.
- סוכנת: `agent_5801m4a74w3dfawt9hdjhbe1nrjc` (רק v5. האתר החי משתמש ב-`agent_1101…` ולא נגעו בה).

## משתני סביבה ב-Vercel (נבדק 2026-10-09 22:18 UTC, בלי ערכים)
| משתנה | רשומות | היקף | הערה |
|---|---|---|---|
| PAYPAL_ENV | 1 | Preview · v5 | sandbox; הקוד כופה sandbox מחוץ ל-production |
| PAYPAL_WEBHOOK_ID | 1 | Preview · v5 | |
| PAYPAL_MERCHANT_ID | 1 | Preview · v5 | |
| PAYPAL_CLIENT_ID | **2** | `359PsDmtRGQy4wqx` Preview · v5 ✅ · `hz0A1jU0PkqJnNYd` Preview בלי ענף ⚠️ | נוצרו 22:10 UTC |
| PAYPAL_CLIENT_SECRET | **2** | `2yjDeNus6TFUZIp0` Preview · v5 ✅ · `74aN5RShUGkpG9Gl` Preview בלי ענף ⚠️ | נוצרו 22:11 UTC, Sensitive |
| DATABASE_URL (+ DATABASE_*) | 1 כל אחד | Preview (כל הענפים) | Neon front-v5-preview. מכוון — נוצר ע״י האינטגרציה |
| MAKE_NOTIFY_URL, META_PIXEL_ID, SITE_URL | 1 | Preview · v5 | |
| META_CAPI_TOKEN, META_TEST_EVENT_CODE, ELEVENLABS_WEBHOOK_SECRET, ADMIN_*, CRON_SECRET, DELIVERY_TIME_TEXT | 0 | — | חסרים |

### כפילויות — מי מטפל
- למחוק רק את שתי הרשומות **בלי ענף**: `hz0A1jU0PkqJnNYd` (PAYPAL_CLIENT_ID) ו-`74aN5RShUGkpG9Gl` (PAYPAL_CLIENT_SECRET). הן חושפות את מפתחות ה-Sandbox גם לפריסות של ענפים אחרים (ci/*). לא לגעת ברשומות של v5 ולא ב-DATABASE_*.
- **אחראי: סשן קלוד בכרום (או אלון), לא סשן הקוד.** סשן הקוד לא מוחק משתנים ולא עורך אותם — רק קורא. מי שמוחק מעדכן כאן שורה "בוצע" עם שעה.
- אחרי המחיקה אין צורך ב-Redeploy ל-v5: הפריסה שלו משתמשת ברשומות הענף.
- סטטוס: ⏳ טרם בוצע.

## מה נבדק בפועל
| נושא | סטטוס | איך |
|---|---|---|
| ביט חסום ב-Preview, באנר "סביבת בדיקה — אין להעביר כסף" | ✅ | בדיקות דפדפן T1–T4 + Preview |
| PayPal תמיד sandbox מחוץ ל-production | ✅ | בדיקת שרת F9 |
| הסוכנת מקבלת אמצעי תשלום לפי סביבה | ✅ בקוד | T5/T6. לא נבדק בשיחה |
| זמן אספקה כחסם השקה בכל מסלולי ההזמנה | ✅ בקוד | F10 (שרת), T7–T9 (דפדפן). ב-production בלי DELIVERY_TIME_TEXT: PayPal create מחזיר 409, חלון התשלום סגור עם הסבר, ביט נחסם, הסוכנת לא פותחת תשלום. ב-Preview: מוצג "טרם נקבע (חסם להשקה)", התשלום פתוח |
| פריסה עם מפתחות PayPal | ✅ | dpl_4eomAjJYKZq9AfYFQ3wSk9sBfe5v נוצרה 22:19, אחרי הוספת המשתנים (22:10–22:11). ‎/api/config מאותה פריסה: preview, sandbox, client id קיים, checkout_open |
| בדיקות Sandbox בצד שרת (GitHub Actions, run 37998723985) | ✅ 8/8 | הזמנה נוצרת · הערת אפיון נשמרת לפני תשלום · השרת יוצר הזמנת PayPal Sandbox (המפתחות עובדים) · יצירה שנייה ממחזרת את אותה הזמנת PayPal · capture בלי אישור קונה לא מסמן שולם · webhook מזויף נדחה · ההזמנה נשארת לא-שולמה וההערה עליה. הזמנת בדיקה: FR-3NEX-5FUB |
| שיחות טקסט (סימולציה) 1–4 | ✅ | גרסת סוכנת לפני תיקוני היום |
| שיחה אחרי תשלום (סימולציה 5) | ⏸ | לא להריץ לפני תשלום Sandbox אמיתי |
| שיחה קולית | ❌ | דורש אדם |
| **תשלום Sandbox מלא עם אישור קונה** | ❌ | דורש התחברות כקונה Sandbox — ראו "בדיקה ידנית" |
| webhook כפול אמיתי, אפיון אחרי תשלום באותה הזמנה | ❌ | תלוי בתשלום המלא |
| ElevenLabs webhook, Meta Purchase במצב בדיקה | ❌ | חסרים סודות |

בדיקות אוטומטיות על commit `2ea4990`: שרת 36/36, דפדפן 75/75.

## בדיקה ידנית — תשלום Sandbox מלא (אלון או קלוד בכרום)
1. לפתוח https://front-studio-git-v5-alons-projects-65a14969.vercel.app (תמיד הפריסה האחרונה של v5). לוודא פס צהוב "סביבת בדיקה".
2. "להזמנה" → כפתור PayPal → להתחבר עם **חשבון קונה Sandbox** (Personal) מ-developer.paypal.com → Sandbox accounts. לא חשבון אמיתי. לא להקליד סיסמאות בצ׳אט.
3. אחרי התשלום: עמוד התודה צריך להראות "התשלום התקבל" ומספר הזמנה FR-XXXX-XXXX. לשלוח לסשן הקוד **רק את מספר ההזמנה** (לא את הקישור — יש בו טוקן).
4. באותו עמוד: לפתוח את מיטל, לענות על 2–3 שאלות אפיון.
5. webhook כפול: developer.paypal.com → Apps → front-v5-preview → Webhooks → Webhook events → לבחור את PAYMENT.CAPTURE.COMPLETED של ההזמנה → Resend. פעם אחת.
6. סשן הקוד יאמת בלוגים של Vercel: תשלום אחד, אין Purchase/מייל כפול, הערות האפיון על אותו order_id.

## ממצא VIDEO_WHY_QUESTION
- הופיע פעם אחת, בתחילת תשובה בסימולציה 5 (suite_5801m4hagtb8ebwsxdmkj4d2e5bq, תור 6).
- נבדק ולא נמצא: בפרומפט, בתיאורי הכלים, ב-data collection, בווידג׳ט, במשתנים, בהגדרות הבדיקות (5 החדשות ו-3 הישנות), בהיסטוריית השיחות. לסוכנת אין מאגר ידע מחובר ו-RAG כבוי. באותו תור לא היו קריאות כלים ולא תוצאות כלים.
- מסקנה: מקור לא אותר. ההשערה הסבירה היא שהמודל יצר את התווית, אבל זה לא הוכח.
- תיקון: נוסף לפרומפט סעיף "מה הלקוח רואה" שאוסר שמות שדות, כלים, משתנים, תוויות באנגלית והוראות פנימיות. גם תיאור save_brief_note עודכן.

## שינויים בסוכנת היום (agent_5801)
- `agtvrsn_1401m4hb77rrf35t8r32w6267976`: משתנה `payment_methods` (ברירת מחדל: פייפאל בלבד).
- `agtvrsn_0701m4hb8p8aeqyvrf8x9hevryvb`: פרומפט — איסור תוויות פנימיות; אמצעי תשלום רק לפי `payment_methods`; זמן אספקה: לא "ייקבע אחרי התשלום", אלא הפניה לאלון בוואטסאפ לפני תשלום, ובלי open_payment כל עוד השאלה פתוחה.
- כלי open_payment: הוסר "זמן האספקה" כתנאי ו"לשונית חדשה". כלי save_brief_note: נוסף customer_questions (השרת כבר תמך).
- הכלים משמשים רק את agent_5801 (נבדק).

## החלטות עסקיות שחסרות להשקה
1. **זמן אספקה** — חסם השקה. נאכף בקוד: ב-production אין תשלום (PayPal, ביט, דרך הסוכנת או הזמנה ישירה) עד שמוגדר DELIVERY_TIME_TEXT, והוא מוצג בחלון התשלום לפני התשלום.
2. תנאי ביטול, זכויות שימוש, גרסאות נוספות.

## הצעד הבא (לפי הסדר)
1. קלוד בכרום / אלון: למחוק את שתי רשומות ה-PayPal בלי ענף (מזהים למעלה) ולעדכן כאן.
2. אלון / קלוד בכרום: "בדיקה ידנית" למעלה, ולשלוח לסשן הקוד את מספר ההזמנה.
3. סשן הקוד: אימות בלוגים — תשלום, webhook כפול, אפיון באותה הזמנה.
4. רק אז: סימולציה 5 (עלות משוערת 250–400 קרדיטים, דורש אישור).
5. לפני השקה: להגדיר זמן אספקה מאושר ב-DELIVERY_TIME_TEXT (production) ולעדכן את פרומפט הסוכנת.

## פריסות
| זמן (UTC) | commit | deployment | הערה |
|---|---|---|---|
| 2026-10-09 21:53 | 0743e92 | dpl_GPowmzuqjBbs77zUxvakDehd4b2m | חסימת ביט, הסתרת קבצים |
| 2026-10-09 22:19 | 2ea4990 | dpl_4eomAjJYKZq9AfYFQ3wSk9sBfe5v | חסם זמן אספקה; ראשונה עם מפתחות PayPal. נבדק 22:20: client id קיים, sandbox |
| 2026-10-09 22:07 | e5db74d | dpl_6ua7TVTdWnhLtnXe7VM6barvkikc | payment_methods לסוכנת. נבדק 22:08: /api/config → preview, sandbox, test_mode:true, paypal_client_id ריק |
