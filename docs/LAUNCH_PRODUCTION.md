# סדר ההשקה — הוכן 13/10/2026 (לא בוצעה פריסה לייצור)

**מה כבר עבר ב-Preview:**
- תשלום Sandbox ואימות בשרת;
- webhook של PayPal, כולל Resend בלי כפילות;
- מייל אישור, קישור חזרה ואפיון (SNQA);
- **Meta Purchase ב-Test Events** (13/10, אחד לכל הזמנה, Processed).

**הסדר:** כל שלב מתחיל רק אחרי שהקודם עבר. שלבים 1–3 לא נוגעים בייצור.

### 1. שערים לפני ייצור (Preview)
| # | מה | מי | מצב |
|---|---|---|---|
| 1.1 | טופס "עזרה בהזמנה" חי: פנייה אמיתית אחת, מייל ודשבורד (`CHROME_LAUNCH_TASKS.md` ה6) | אלון או כרום | ממתין. נבדק 13/10: אין עדיין הרצות של Make מהטופס |
| 1.2 | מיטל: ארבעת התרחישים הידניים (`docs/agent/SUPPORT_2026-10-13.md`) | אלון | ממתין. נבדק 13/10: אין עדיין שיחות ב-5801 מאז העדכון |
| 1.3 | החלטות על הפרטים האישיים שנשארו: `terms.html` שורות 32 ו-57, `accessibility.html` שורה 44, ביט דרך וואטסאפ אישי, תסריט אחרי תשלום "בוואטסאפ" | אלון | פתוח |

### 2. סוכנת הייצור 8501 — השינויים מוכנים בענף נפרד, לא פורסמו (13/10)
**ענף:** `launch-v5-support` (`agtbrch_5501m4v936x8e869zhfw2595m7rx`), גרסה `agtvrsn_4501m4v95mk6fkgtk7kbkyk5gm7q`. **0% מהתנועה**, נבדק ברשימת הענפים. Main (`agtvrsn_2301…`) נשאר 100% ולא השתנה.

**מה בענף:**
- **פרומפט:** הטקסט של `docs/agent/meital-v5-prompt.md`, כלומר הפרומפט של 5801 בגרסה agtvrsn_6901.
- **כלים:** open_payment, **open_support** (`tool_9001…`, כלי לקוח בלי כתובת), save_brief_note, **check_payment של הייצור** (`tool_6001…`, נבדק: שולח ל-`https://front-studio.vercel.app/api/agent/payment-status`) ו-switch_ad. `show_whatsapp` הוסר מהענף.
- **בלי שינוי:** מודל claude-sonnet-5, reasoning low, max_tokens 700, ההודעה הפותחת `{{opening_line}}`, ואזור הזמן Asia/Jerusalem.
- **webhook:** הענף שומר את `post_call_webhook_id` = `4c94bcf659254ec5a9c93c30dcec0cf4`, כמו ב-Main.

**גיבוי:** הגרסה `agtvrsn_2301m4s1b8gzf66rzr1mz7k1k083` ב-ElevenLabs לא ניתנת לשינוי. הטקסט שלה תואם את `meital-v5-backup-agtvrsn_3301.md` בכל הקטעים שבדקתי. לא השוויתי תו מול תו.

**לתשומת לב (14/10):** 5801 נמצא עכשיו ב-`agtvrsn_8501m4xh…` (שלב 1 של ההחלטות). לפני מיזוג הענף צריך שלושה דברים:
- להעתיק את הפרומפט מ-`meital-v5-prompt-stage1.md`, או מ-`meital-v5-prompt.md` אם שלב 2 אושר;
- להחליף ב-tool_ids את `tool_4901` ב-`tool_3601m4vnkrqseahacgmy0frsyhy9`, ולהוסיף `tool_7601m4vnkn3hf7xayz0b0vn2smxg` רק אחרי שלב 2;
- לפרוס ל-Production את הקוד שמכיר את השדות החדשים ואת `send_summary`.

**סדר חובה:** קודם הקוד, אחר כך הסוכנת. אם הסוכנת תשמור שדה חדש מול קוד ישן, היא תקבל NOT SAVED.

**לתשומת לב (13/10, 21:50):** אחרי שיחת המספרה עודכן הפרומפט של 5801 ל-agtvrsn_4101. הענף הזה עדיין על 6901, ולכן לפני המיזוג צריך להעתיק אליו את `meital-v5-prompt.md` העדכני.

**הפרסום, רק באישור מפורש:** מיזוג `launch-v5-support` ל-Main ב-ElevenLabs, או העברת התנועה לענף. אחרי זה בודקים שב-Main מופיעים `tool_9001` ו-`tool_6001`, ש-`tool_7001` לא מופיע, ושה-webhook הוא `4c94…`.

**Webhook post-call:** השיוך אומת בקריאה (13/10). ב-Main של 8501 מוגדר `post_call_webhook_id` = `4c94bcf659254ec5a9c93c30dcec0cf4`, וב-5801 של ה-Preview מוגדר מזהה אחר (`7cc2c509…`). כך תוקן המסמך מ-12/10, שאמר שאין webhook. **כתובת היעד לא אומתה:** בכלים שיש לי אין קריאה של הגדרות ה-webhooks ב-ElevenLabs, ואין לי דרך אחרת לקרוא אותן בלי מפתח. לפי מה שדיווחת, הוא מוגדר ל-`https://front-studio.vercel.app/api/elevenlabs/webhook`. אישור סופי יגיע בקבלה (שלב 5): שיחת ייצור ראשונה שנקלטת בדשבורד.

### 3. Vercel Production — אומת בשמות בלבד (13/10, בלי לקרוא ערכים סודיים)
- **כל 14 משתני החובה קיימים עם יעד Production בלבד:** DATABASE_URL, SITE_URL, ADMIN_EMAIL, CRON_SECRET, PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PAYPAL_MERCHANT_ID, ELEVENLABS_AGENT_ID, ELEVENLABS_WEBHOOK_SECRET, MAKE_NOTIFY_URL, META_PIXEL_ID, META_CAPI_TOKEN. הסודות שמורים כ-sensitive.
- **אין אף משתנה אסור ב-Production:** NOTIFY_TEST_RECIPIENTS, META_TEST_EVENT_CODE, ADMIN_USER, ADMIN_PASSWORD_HASH ו-FRONT_ENV.
- **ערכים לא-סודיים שנבדקו:**
  - `PAYPAL_ENV=live`;
  - `SITE_URL=https://front-studio.vercel.app`;
  - `ADMIN_EMAIL` של אלון;
  - `META_PIXEL_ID=871649018702910`;
  - `ELEVENLABS_AGENT_ID=agent_8501…`;
  - `PAYPAL_WEBHOOK_ID` ו-`PAYPAL_MERCHANT_ID` שונים מאלה של ה-Sandbox.
- **מסד נתונים:** משתני ה-DB של Production (Neon, 15 משתנים) נוצרו ב-12/10, ושל Preview נוצרו ב-09/10. אלה רשומות נפרדות, ולכן כנראה מסד נפרד. **לא הוכח:** הערכים מוצפנים, וקריאת ה-store דרך ה-API החזירה 404.
- **לא נבדק:** שה-Client ID וה-Secret של PayPal שייכים לאפיליקציית Live, ושה-webhook של PayPal רשום לכתובת הייצור. זה ייבדק אחרי הפריסה בכרטיס "חיבור PayPal" (שלב 5.3).
- המשתנים לא משפיעים על Production עד פריסה חדשה. היום Production עדיין מריץ את `main`, האתר הישן.

### 4. מיזוג v5 → main (רק באישור מפורש) — זו הפריסה לייצור

### 5. קבלה אחרי פריסה (בלי תשלום אמיתי עד אישור)
1. `/api/config`:
   - `environment: production`;
   - PayPal ב-`live`;
   - `pixel_id` = `871649018702910`;
   - ב-`agent_client_tools` מופיע `open_support`.
2. דשבורד → "מוכנות לייצור": הכול ירוק.
3. דשבורד → "חיבור PayPal": אפליקציית Live, webhook באותה אפליקציה, כתובת תואמת, 6 אירועים.
4. טבלאות: הבקשה הראשונה מריצה את המיגרציות 001–008 על מסד הייצור החדש. לוודא שכרטיס "פניות עזרה" נטען בלי שגיאה.
5. פנייה אחת בטופס העזרה מכתובת של אלון:
   - המייל מגיע **בלי** "[preview]" ובלי הבאנר הצהוב. נבדק בתרחיש: הבאנר מותנה ב-`environment`;
   - הפנייה מופיעה בדשבורד → "טופל".
6. מיטל בייצור, שיחת טקסט אחת קצרה: "מי הבעלים?" צריך להחזיר "אלון" בלבד. "את AI?" צריך להחזיר תשובה כנה בלי וואטסאפ. **זו שיחה בתשלום, ולכן רק באישורך.**
7. **בלי רכישה אמיתית** עד אישור נפרד. אחרי רכישה אמיתית ראשונה: Purchase אמיתי ב-Events Manager (לא ב-Test Events).

---

# מעבר לייצור — מה קיים ומה חסר (נבדק שוב 12/10/2026)

**בדיקה 12/10 (קריאה בלבד; התיאור הזה עודכן ב-13/10, ראו "סדר ההשקה" שלב 3):**
- **משתני סביבה ב-Vercel:** ~~בפרויקט `front-studio` אין אף משתנה עם יעד Production~~. עודכן 13/10: כל 14 המשתנים קיימים ב-Production.
  - `hiddenProductionEnvCount: 0`.
  - גם משתני מסד הנתונים (אינטגרציית Neon, store `store_kFS6BrZ6i2imB1uk`) מחוברים ל-Preview בלבד.
- **פריסה:** Production (`front-studio.vercel.app`) עדיין מריץ את `main`, האתר הישן.
- **ElevenLabs:** ~~לסוכנת הייצור עדיין לא משויך webhook post-call~~. **עודכן 13/10:** משויך `4c94bcf659254ec5a9c93c30dcec0cf4`.
- **PayPal Live:** לא בדקתי. אין לי גישה לחשבון Live. האפליקציה, ה-webhook ומזהה המוכר נבדקים ב-developer.paypal.com.

### מה חסר ב-Production — לפי שירות
**14 משתני חובה.** תיקון: קודם כתבתי 13. ספרתי שורות בטבלה, ושורה אחת כללה שני משתנים (`PAYPAL_CLIENT_ID` ו-`PAYPAL_CLIENT_SECRET`).
**כלל לכל השלבים:** ערכים סודיים מוזנים ישירות במסך של Vercel, בסביבה **Production** בלבד. לא בצ׳אט, לא בקוד ולא במסמכים.
"מבצע: אלון" פירושו פעולה בחשבון של אלון. Claude in Chrome יכול לבצע אותה במקומו, בדפדפן של אלון ובאישורו.

#### 1. Vercel ו-Neon — מסד נתונים וכתובת (מבצע: אלון)
| # | משתנה | מה בדיוק |
|---|---|---|
| 1 | `DATABASE_URL` | ליצור מסד Neon **חדש** לייצור, דרך אינטגרציית Neon ב-Vercel (Storage → Create), ולחבר אותו ל-**Production בלבד**. לא לחבר את `front-v5-preview`. הטבלאות נוצרות אוטומטית בבקשה הראשונה |
| 2 | `SITE_URL` | הכתובת הסופית עם https. כרגע `https://front-studio.vercel.app`, כי אין דומיין מותאם מחובר. ממנה נבנים הקישורים במיילים |
| 3 | `ADMIN_EMAIL` | `alongerber@gmail.com` |
| 4 | `CRON_SECRET` | מחרוזת אקראית ארוכה. Vercel שולח אותה ל-cron היומי |

#### 2. PayPal Live (מבצע: אלון, ב-developer.paypal.com במצב Live)
| # | משתנה | מה בדיוק |
|---|---|---|
| 5 | `PAYPAL_ENV` | `live` |
| 6 | `PAYPAL_CLIENT_ID` | מאפליקציית REST במצב **Live** |
| 7 | `PAYPAL_CLIENT_SECRET` | מאותה אפליקציה (סוד) |
| 8 | `PAYPAL_WEBHOOK_ID` | באותה אפליקציה: Add Webhook אל `<SITE_URL>/api/paypal/webhook` עם 6 האירועים: CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED / REVERSED. מזינים את המזהה שנוצר |
| 9 | `PAYPAL_MERCHANT_ID` | מזהה חשבון העסק Live (Account Settings → Business information) |
אחרי הפריסה: לבדוק בדשבורד, ב"אבחון טכני" ← "חיבור PayPal": שההתחברות תקינה, שה-webhook באפליקציה, שהכתובת תואמת ושלא חסרים אירועים. **בלי תשלום אמיתי** עד שתאשר.

#### 3. ElevenLabs (מבצע: אלון)
| # | משתנה | מה בדיוק |
|---|---|---|
| 10 | `ELEVENLABS_AGENT_ID` | `agent_8501m4mbsfasegqbr208yx71ctm7` (סוכנת הייצור; הוכנה 11/10) |
| 11 | `ELEVENLABS_WEBHOOK_SECRET` | ב-ElevenLabs → Agents → Settings → Webhooks: webhook מסוג post-call אל `<SITE_URL>/api/elevenlabs/webhook`. **עודכן 13/10:** ה-webhook `4c94bcf659254ec5a9c93c30dcec0cf4` משויך לסוכנת 8501. השיוך אומת בקריאה, ואת הכתובת דיווח אלון. הסוד מוצג פעם אחת ומוזן ישר ל-Vercel |

#### 4. Make (מבצע: אלון; התרחיש עצמו כבר מוכן)
| # | משתנה | מה בדיוק |
|---|---|---|
| 12 | `MAKE_NOTIFY_URL` | כתובת ה-webhook של תרחיש 7867409, אותה כתובת כמו ב-Preview. התרחיש מבחין בין ייצור לבדיקה לפי `environment`: בייצור ללקוח נשלחים אישור תשלום ו"קיבלנו את האפיון", ובלי סימון בדיקה |

#### 5. Meta (מבצע: אלון)
| # | משתנה | מה בדיוק |
|---|---|---|
| 13 | `META_PIXEL_ID` | `871649018702910` |
| 14 | `META_CAPI_TOKEN` | Events Manager → הפיקסל → Settings → Conversions API → Generate access token |

#### אסור להגדיר ב-Production
`NOTIFY_TEST_RECIPIENTS`, `META_TEST_EVENT_CODE`, `ADMIN_USER`, `ADMIN_PASSWORD_HASH`, `FRONT_ENV`.
**לא חובה:** `DELIVERY_TIME_TEXT` (ברירת המחדל היא הנוסח המאושר) ו-`CONSENT_MODE` (ברירת המחדל `opt_in`).

#### מה Claude Code עושה (בלי סודות)
- אחרי שהמשתנים הוזנו: בודק ב-Vercel **שמות בלבד**, בלי ערכים, ומשווה לרשימה.
- מכין את בדיקות הקבלה לייצור.
- המיזוג ל-main **רק באישור מפורש**.
- הדשבורד ("מוכנות לייצור", `lib/readiness.js`) מסמן כל משתנה חסר או אסור.

---


**מצב Production היום:** הפרויקט `front-studio` מגיש את האתר הישן מ-`main` (commit `384324d`, פריסה `dpl_76YzovmsTUzQu7S5VZ4MJsdxRrS8`) בכתובת https://front-studio.vercel.app. ב-Production מוגדרים **0 משתני סביבה** (`hiddenProductionEnvCount: 0`). גרסת v5 קיימת רק ב-Preview.

הדשבורד (`/admin` → בריאות → "מוכנות לייצור") בודק את כל הסעיפים האלה בסביבה שבה הוא רץ, ומציג שמות בלבד, בלי ערכים.

| רכיב | Preview (v5) | Production | מה חסר |
|---|---|---|---|
| מסד נתונים | Neon `front-v5-preview` (DATABASE_URL ושות׳, Preview בלבד) | אין | מסד Neon **נפרד** לייצור, מחובר ל-Production בלבד. המיגרציות רצות אוטומטית בבקשה הראשונה. לא לחבר את מסד ה-Preview |
| PayPal | Sandbox: CLIENT_ID, CLIENT_SECRET, WEBHOOK_ID `2GM46818V44253024`, MERCHANT_ID `L5XMZ6WTKKV4A`, PAYPAL_ENV=sandbox | אין | אפליקציית **Live** ב-developer.paypal.com: CLIENT_ID + SECRET, MERCHANT_ID של חשבון Live, PAYPAL_ENV=live, ו-webhook Live אל `<כתובת סופית>/api/paypal/webhook` עם האירועים PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED / REVERSED ו-CHECKOUT.ORDER.APPROVED, ומזהה ה-webhook ב-PAYPAL_WEBHOOK_ID. הקוד מוגבל ל-Sandbox בכל סביבה שאינה Production |
| סוכנת | `agent_5801m4a74w3dfawt9hdjhbe1nrjc` (סוכנת בדיקה). `check_payment` (`tool_6901…`) וה-webhook `7cc2c509…` מצביעים לכתובת ה-Preview | **הוכנה 11/10:** `agent_8501m4mbsfasegqbr208yx71ctm7` ("FRONT — מיטל — Production (טרם הופעלה)"), אותו פרומפט וכלים, `check_payment` נפרד `tool_6001m4mbs795frybfr8j78xwg4m8` אל `https://front-studio.vercel.app/api/agent/payment-status`. ה-webhook של ה-Preview **נותק** ממנה, כדי ששיחות ייצור לא ייכנסו למסד הבדיקה | ב-ElevenLabs: webhook post-call חדש אל `https://front-studio.vercel.app/api/elevenlabs/webhook` ושיוכו לסוכנת 8501 (הסוד מוצג רק במסך). ב-Vercel Production: ELEVENLABS_AGENT_ID=`agent_8501m4mbsfasegqbr208yx71ctm7` ו-ELEVENLABS_WEBHOOK_SECRET. כל שינוי פרומפט עתידי ב-5801 צריך להיות מועתק גם ל-8501 |
| מיילים | MAKE_NOTIFY_URL (תרחיש 7867409). NOTIFY_TEST_RECIPIENTS=alongerber@gmail.com | אין | MAKE_NOTIFY_URL ל-Production. **לא** להגדיר NOTIFY_TEST_RECIPIENTS בייצור, אחרת לקוחות לא יקבלו מייל |
| דשבורד | ADMIN_EMAIL=alongerber@gmail.com. ADMIN_USER/ADMIN_PASSWORD_HASH זמניים (ערך "disabled") | אין | ADMIN_EMAIL בלבד. לא להעתיק את ADMIN_USER/ADMIN_PASSWORD_HASH |
| Meta | META_PIXEL_ID `871649018702910` | אין | META_PIXEL_ID ו-META_CAPI_TOKEN. **בלי** META_TEST_EVENT_CODE בייצור. ב-Preview: META_CAPI_TOKEN + META_TEST_EVENT_CODE כדי לראות Purchase ב-Test Events. הפיקסל בדפדפן נטען רק ב-Production. ב-Preview הוא נטען רק אם הוגדר פיקסל בדיקה נפרד (META_BROWSER_TEST_PIXEL_ID, לא חובה). ב-Production המשתנה הזה לא משפיע |
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
