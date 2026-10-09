# FRONT v5 — מסמך העברה (מקור אחד לשני הסשנים)

עודכן: 2026-10-09 22:10 UTC · ענף `v5` · Preview בלבד · אין מיזוג ל-main.

## איפה בודקים
- Preview קבוע של הענף: https://front-studio-git-v5-alons-projects-65a14969.vercel.app
- פריסה אחרונה: ראו טבלת "פריסות" למטה. Vercel project `prj_rWYhxn7MbfTYJD0Utets1yYWtnlo`.
- סוכנת: `agent_5801m4a74w3dfawt9hdjhbe1nrjc` (רק v5. האתר החי משתמש ב-`agent_1101…` ולא נגעו בה).

## משתני סביבה ב-Vercel (נבדק 2026-10-09 ~22:00 UTC, בלי ערכים)
| משתנה | קיים | היקף | הערה |
|---|---|---|---|
| PAYPAL_ENV | כן | Preview · v5 | sandbox. הקוד ממילא כופה sandbox מחוץ ל-production |
| PAYPAL_WEBHOOK_ID | כן | Preview · v5 | נוצר 22:01 UTC, עותק יחיד |
| PAYPAL_MERCHANT_ID | כן | Preview · v5 | נוצר 22:01 UTC, עותק יחיד |
| PAYPAL_CLIENT_ID | **חסר** | — | חוסם תשלום Sandbox |
| PAYPAL_CLIENT_SECRET | **חסר** | — | חוסם תשלום Sandbox (לסמן Sensitive) |
| DATABASE_URL (+ DATABASE_*) | כן | Preview (כל הענפים) | Neon front-v5-preview. אין ב-production |
| MAKE_NOTIFY_URL | כן | Preview · v5 | |
| META_PIXEL_ID, SITE_URL | כן | Preview · v5 | |
| META_CAPI_TOKEN, META_TEST_EVENT_CODE | **חסר** | — | בלעדיהם Purchase נשאר בתור ולא נשלח |
| ELEVENLABS_WEBHOOK_SECRET | **חסר** | — | בלעדיו נתוני שיחה נדחים |
| ADMIN_USER, ADMIN_PASSWORD_HASH, CRON_SECRET | **חסר** | — | |

אין כפילויות. אין משתנים ב-production בפרויקט.

## מה נבדק בפועל
| נושא | סטטוס | איך |
|---|---|---|
| ביט חסום ב-Preview, באנר "סביבת בדיקה — אין להעביר כסף" | ✅ | בדיקות דפדפן T1–T4, ובדיקה על ה-Preview |
| PayPal תמיד sandbox מחוץ ל-production | ✅ | בדיקת שרת F9 (נכשלת בלי התיקון) |
| הסוכנת מקבלת אמצעי תשלום לפי סביבה (Preview: רק בדיקה, בלי ביט) | ✅ בקוד | T5/T6. **לא נבדק בשיחה עם הסוכנת** |
| קבצי בדיקה ותיעוד לא נחשפים | ✅ | ‎/test, ‎/docs → 404; ‎/lib, ‎/db → הפניה |
| שיחות טקסט (סימולציה): הבנת עסק, תיקון, מחיר, הזמנה מיידית | ✅ 4/4 | ElevenLabs, גרסת סוכנת ישנה (לפני תיקוני היום) |
| שיחה אחרי תשלום (סימולציה 5) | ⚠️ לא חד-משמעי | נגמרו התורות. **לא להריץ שוב לפני השלמת החיבורים** |
| שיחה קולית | ❌ לא נבדק | דורש אדם |
| תשלום Sandbox מקצה לקצה | ❌ | חסרים CLIENT_ID/SECRET |
| webhook כפול, שמירת אפיון באותה הזמנה | ❌ | תלוי בתשלום Sandbox |
| נתוני שיחה מ-ElevenLabs, Purchase במצב בדיקה ל-Meta | ❌ | חסרים סודות |

בדיקות אוטומטיות על commit `e5db74d`: שרת 35/35, דפדפן 72/72.

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
1. **זמן אספקה** — חייב להיות ברור ללקוח לפני התשלום. כרגע לא מוגדר; הסוכנת מפנה לאלון.
2. תנאי ביטול, זכויות שימוש, גרסאות נוספות.

## הצעד הבא (לפי הסדר)
1. אלון: להוסיף PAYPAL_CLIENT_ID ו-PAYPAL_CLIENT_SECRET (Sensitive) ל-Preview, ענף v5 בלבד, מאותה אפליקציית Sandbox ‏front-v5-preview.
2. Redeploy ל-v5 (push או Redeploy ב-Vercel). לוודא ש-`/api/config` מחזיר `paypal_client_id` ו-`paypal_env: sandbox`.
3. תשלום Sandbox מקצה לקצה בחשבון קונה Sandbox → לוודא הזמנה מסומנת paid בבסיס הנתונים.
4. שליחה כפולה של אותו webhook → אין כפילות תשלום/Purchase/מייל.
5. אפיון אחרי תשלום → נשמר על אותו order_id.
6. רק אז: סימולציה 5 מחדש (עלות משוערת 250–400 קרדיטים, דורש אישור).

## פריסות
| זמן (UTC) | commit | deployment | הערה |
|---|---|---|---|
| 2026-10-09 21:53 | 0743e92 | dpl_GPowmzuqjBbs77zUxvakDehd4b2m | חסימת ביט, הסתרת קבצים |
| 2026-10-09 22:07 | e5db74d | dpl_6ua7TVTdWnhLtnXe7VM6barvkikc | payment_methods לסוכנת. נבדק 22:08: /api/config → preview, sandbox, test_mode:true, paypal_client_id ריק |
