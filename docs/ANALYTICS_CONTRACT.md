# ANALYTICS_CONTRACT — FRONT (v5)

גרסה: 1.0 · 09/10/2026 · נכתב **לפני** המימוש. כל שינוי באירוע = עדכון כאן קודם.

## 1. עקרונות
1. **פעולה ≠ תוצאה.** לחיצה על תשלום אינה רכישה. פתיחת הסוכנת אינה ליד. לחיצה על וואטסאפ אינה הודעה.
2. **מקור האמת להזמנות, לתשלומים ולאפיון הוא Postgres.** localStorage משמש רק לרציפות בממשק.
3. **אירוע שלא ניתן למדוד מסומן כך.** לא ממציאים לו ערך, וכשאין מידע מציגים `unknown`.
4. **מידע מאוחר מוצג כ"ממתין לנתוני שיחה", לא כאפס.**
5. **אין פרטים אישיים באירועי אנליטיקה.** אין תמלול, תוכן אפיון, שם, טלפון או אימייל בטבלת `events`.
6. **כשל מדידה לא חוסם קנייה.** שליחת אירועים היא fire-and-forget, וכל קוד המדידה עטוף ב-try/catch.

## 2. מזהים
| מזהה | נוצר ע"י | איך | אורך חיים | הערות |
|---|---|---|---|---|
| `anonymous_id` | דפדפן | UUIDv4. Cookie `front_aid` מאותו דומיין, ועותק ב-localStorage | 13 חודשים | נוצר **רק** אחרי הסכמה למדידה. בלי הסכמה, מסלול ההזמנה פועל בלעדיו |
| `session_id` | דפדפן | UUIDv4 | מתחלף אחרי 30 דקות בלי פעילות, או כשמגיע UTM חדש | |
| `event_id` | שולח האירוע | UUIDv4 בדפדפן. בשרת: מחרוזת דטרמיניסטית, למשל `purchase_verified:FR-XXXX-XXXX` | | מפתח ייחודי ב-DB, וכפילות נדחית בשקט |
| `order_id` | **שרת בלבד** | `FR-XXXX-XXXX` מ-alphabet בלי תווים דומים | קבוע | הדפדפן לא קובע מספר הזמנה |
| `order_token` | שרת | 32 בתים אקראיים, ובשרת נשמר רק hash מסוג SHA-256 | | נמסר לדפדפן פעם אחת. ב-URL הוא רק ב-fragment (`#t=`), ולכן לא נשלח לשרתים ולא מופיע ב-Referer. בלעדיו אין גישה להזמנה |
| `conversation_id` | ElevenLabs | | | ידוע לשרת **רק** מה-webhook שאחרי השיחה, כי הווידג'ט לא חושף אותו לדף |
| `front_link` | דפדפן | 24 בתים אקראיים, אחד לכל טאב | הטאב | עובר לסוכנת כמשתנה דינמי. **רק אחרי שהשיחה התחילה** הדפדפן מצמיד אותו להזמנה, וזה דורש את ה-token. ה-webhook משייך שיחה להזמנה רק דרכו. `order_id` שהסוכנת או הדפדפן טוענים לו לא משמש לשיוך |
| `lead_id` | שרת | זהה ל-`order_id` | | כרגע אין באתר טופס ליד לפני רכישה, לכן ליד נוצר רק אחרי הזמנה |
| `paypal_order_id`, `capture_id` | PayPal | | | `capture_id` ייחודי ב-DB ומונע רכישה כפולה |

**שיוך שיחה להזמנה:** הדפדפן מעביר לסוכנת `anonymous_id`, `session_id` ו-`order_id` כמשתנים דינמיים. ה-webhook מחזיר אותם ב-`conversation_initiation_client_data.dynamic_variables`, והשרת מקשר רק אם `order_id` קיים ותואם ל-session. ערך שהסוכנת או הדפדפן מוסרים לא נחשב הוכחה למצב תשלום.

## 3. שדות האירוע (חוזה אחיד)
| שדה | חובה | מקור | הערה |
|---|---|---|---|
| `event_id` | כן | שולח | ייחודי |
| `event_name` | כן | שולח | רק משמות שבטבלה 4. שם אחר נדחה |
| `occurred_at` | כן | שולח | ISO. שעון הדפדפן לא אמין, ולכן נשמר גם `received_at` |
| `received_at` | כן | שרת | |
| `anonymous_id`, `session_id` | בדפדפן | דפדפן | null אם אין הסכמה למדידה |
| `order_id`, `lead_id`, `conversation_id` | כשקיים | שרת | הדפדפן יכול להצהיר על `order_id` רק יחד עם token תקף |
| `page_path` | בדפדפן | דפדפן | בלי query string. UTM נשמרים בנפרד |
| `cta_location` | ב-cta | דפדפן | `hero` · `offer` · `final` · `dock` · `topbar` · `agent` |
| `channel` | כן | | `web` · `server` · `paypal` · `elevenlabs` · `admin` · `meta` |
| `site_version` | כן | build | למשל `v5.0.0+<git sha>` |
| `agent_version` | בסוכנת | | `version_id` של ElevenLabs |
| `environment` | כן | שרת | `production` · `preview` · `test`. נקבע לפי `VERCEL_ENV`, לא לפי הדפדפן |
| `consent_state` | כן | | `{analytics: granted\|denied\|unset, ads: ...}` |
| `props` | לפי אירוע | | רק מפתחות מרשימה מותרת לכל אירוע. ערך מעבר ל-500 תווים נחתך, **חוץ מ-fbclid** |

**ייחוס** (טבלת `sessions`, לא בכל אירוע):
- `first_touch` ו-`last_touch`, כל אחד עם `utm_source/medium/campaign/content/term`, `fbclid` (לא נחתך, עד 1,000 תווים), `fbc`, `campaign_id`, `adset_id`, `ad_id`, `referrer_host`, `landing_path` ו-`ts`.
- מזהי הקמפיין מגיעים מפרמטרי URL במודעה: `fb_campaign_id={{campaign.id}}&fb_adset_id={{adset.id}}&fb_ad_id={{ad.id}}`. **צריך להוסיף אותם להגדרת המודעה.**
- כשאין ראיה, הערך הוא `unknown`.

## 4. אירועים
מקרא לעמודת "זמן": **RT** = בזמן אמת, **D** = מאוחר (webhook או עיבוד).

### התנהגות באתר (דפדפן, רק עם הסכמה למדידה)
| אירוע | מה מפעיל אותו | מזהים | כפילות | זמן | מה לא נמדד |
|---|---|---|---|---|---|
| `landing_view` | הדף נטען בדפדפן (DOMContentLoaded) | anon, session | פעם אחת לטעינה | RT | בוטים שלא מריצים JS. כניסה בלי JS |
| `section_view` | לפחות 50% מהאזור גלוי ברציפות 1 שנייה | + `section` | פעם אחת לאזור לטעינה | RT | גלילה מהירה שלא עצרה |
| `cta_click` | לחיצה על כפתור מסומן `data-cta` | + `cta_location`, `cta_target` (`agent`/`checkout`/`whatsapp`/`bit`/`offer_anchor`) | event_id | RT | |
| `video_start` / `video_progress` (25/50/75) / `video_complete` | סרטון הפרסומת (#adv) בלבד | + `video`, `pct` | פעם אחת לכל סף בטעינה | RT | **לופ ה-hero לא נמדד כצפייה**, כי הוא אוטומטי ומושתק |
| `time_summary` | דלתות מצטברות: כל 30 שניות, ובמעבר לרקע או בסגירה (sendBeacon) | + `open_ms`, `visible_ms`, `active_ms` | event_id לכל מנה | RT | **אומדן.** "פעיל" = טאב גלוי, ואינטראקציה ב-30 השניות האחרונות (גלילה, הקשה, מקלדת או מצביע). סרטון שרץ ברקע לא נספר. סגירה קשה של הדפדפן עלולה לאבד עד 30 שניות |
| `whatsapp_click` | לחיצה על קישור וואטסאפ | + `cta_location` | event_id | RT | **לא הודעה.** אין לנו דרך לדעת אם נשלחה |
| `consent_updated` | בחירה בבאנר | + `analytics`, `ads` | event_id | RT | נשלח רק אם למדידה ניתנה הסכמה. סירוב לא נרשם באירוע; הוא נשמר רק בדפדפן |

### סוכנת (מיטל)
| אירוע | מה מפעיל אותו | שולח | זמן | הערות ומה לא נמדד |
|---|---|---|---|---|
| `agent_opened` | הווידג'ט נבנה ונפתח בעקבות לחיצה שלנו | דפדפן | RT | **לא ליד** |
| `agent_start_requested` | הווידג'ט שלח `elevenlabs-convai:call` (הכנת שיחה) | דפדפן | RT | **לא הוכחה שהשיחה התחברה.** זה האירוע היחיד שהווידג'ט חושף (נבדק בקוד המקור, v0.19.0) |
| `agent_tool_result` | כלי צד-לקוח רץ (`open_payment`, `show_whatsapp`, `save_brief_note`) | דפדפן | RT | + `tool`, `ok` (true/false) |
| `agent_connected` | ב-webhook ‏status ≠ failed, ויש לפחות תור אחד של הסוכנת | שרת | **D** | לא זמין בזמן אמת. עד שה-webhook מגיע: "ממתין לנתוני שיחה" |
| `agent_first_user_message` | בתמלול יש תור `user` ראשון | שרת | **D** | + `mode`: `text`/`voice` אם ניתן להסיק, אחרת `unknown` |
| `agent_error` | ב-webhook ‏status = failed, או termination_reason של שגיאה. או `agent_tool_result` עם ok=false | שרת/דפדפן | D/RT | חסימת מיקרופון לא נמדדת ישירות. הווידג'ט מטפל בה בתוכו |
| `agent_conversation_summary` | webhook אחרי השיחה | שרת | **D** | נשמר בטבלת `conversations`, לא ב-`events`: משך, מספר תורות, Data Collection (ראה סעיף 6). התמלול נשמר בטבלה מוגנת בלבד |

### ליד, תשלום ואפיון (שרת, תמיד, כי הם חלק מהשירות עצמו)
| אירוע | מה מפעיל אותו | שולח | כפילות | זמן |
|---|---|---|---|---|
| `order_created` | ‏`/api/order` יצר הזמנה (לפני המעבר לתשלום) | שרת | event_id = `order_created:<order_id>` | RT |
| `checkout_presented` | כפתורי PayPal רונדרו וגלויים לפחות 50% למשך שנייה | דפדפן | פעם אחת לטעינה | RT |
| `checkout_clicked` | ‏`onClick` של כפתור PayPal: הלקוח לחץ, והחלון של PayPal עוד לא נפתח | דפדפן | event_id | RT |
| `checkout_created` | השרת יצר order ב-PayPal (`/v2/checkout/orders`) | שרת | `checkout_created:<paypal_order_id>` | RT |
| `payment_approved` | הלקוח אישר ב-PayPal: ‏`CHECKOUT.ORDER.APPROVED`, או onApprove שהגיע לשרת. **לא חיוב** | שרת | `payment_approved:<paypal_order_id>` | RT |
| `purchase_verified` | capture במצב `COMPLETED`. ‏amount = ‏1290.00, ‏currency = ‏ILS, ‏payee.merchant_id = `PAYPAL_MERCHANT_ID`, ו-custom_id = order_id | שרת (capture או webhook) | `purchase_verified:<order_id>`, ו-`capture_id` ייחודי | RT, וגם אם הלקוח לא חזר |
| `payment_pending` | capture במצב `PENDING` | שרת | לפי capture | RT/D |
| `payment_failed` | capture במצב `DECLINED`/`FAILED`, או `PAYMENT.CAPTURE.DENIED` | שרת | לפי capture | RT/D |
| `payment_cancelled` | ‏`onCancel` של PayPal SDK: הלקוח סגר את חלון PayPal | דפדפן | event_id | RT. סגירת טאב **לא** נחשבת ביטול |
| `payment_refunded` | `PAYMENT.CAPTURE.REFUNDED`/`REVERSED` | שרת | event id של PayPal | D |
| `purchase_manual_verified` | אדמין אישר תשלום ביט. נשמרים מי, מתי ואסמכתה | שרת (admin) | אחד להזמנה | RT |
| `lead_captured` | פרטי קשר נשמרו בשרת (טופס בעמוד ההזמנה) | שרת | אחד להזמנה | RT |
| `lead_qualified` | לפי כללים: תחום עסק ידוע, צורך שנאמר, וגם שאל על מחיר או תשלום, או הביע כוונה. מקור: Data Collection | שרת | אחד להזמנה או שיחה | **D** · `basis`: `stated`/`inferred` |
| `brief_started` | הערת אפיון ראשונה נשמרה בשרת אחרי הזמנה | שרת | אחד להזמנה | RT |
| `brief_completed` | ‏`/api/brief/finish` שמר, והחזיר ok | שרת | אחד להזמנה | RT |
| `asset_uploaded` | **לא ניתן למדוד כרגע.** קבצים מועלים בתוך שיחת ElevenLabs. בדיקה האם ה-webhook כולל אותם: פתוח | — | — | — |
| `consent_changed` | הדפדפן שינה הסכמה אחרי שההזמנה נוצרה (`/api/consent`) | שרת | לפי שינוי | RT · + `analytics`, `ads`. ההזמנה מתעדכנת: בלי פרסום נמחקים נתוני ההתאמה, בלי מדידה נמחקים מזהים וייחוס |
| `meta_purchase_sent` / `meta_purchase_failed` | תוצאת שליחת CAPI | שרת | לפי order | RT, וניסיון חוזר יומי |

## 5. מיפוי ל-Meta (Pixel + CAPI)
| אירוע Meta | מקור | event_id | תנאי הסכמה | הערה |
|---|---|---|---|---|
| PageView | Pixel | אוטומטי | ads | |
| InitiateCheckout | Pixel, ב-`checkout_clicked` | event_id של checkout_clicked | ads | value=1290, currency=ILS |
| Contact | Pixel, ב-`whatsapp_click` | event_id | ads | **לחיצה בלבד. לא כמטרת אופטימיזציה** |
| Purchase | **CAPI בלבד**, ב-`purchase_verified` | `order_id` | ads, לפי ההסכמה שנשמרה בהזמנה | ‏`user_data`: ‏em ו-ph (SHA-256 אחרי נרמול), fbc, fbp, IP ו-User-Agent מרגע יצירת ההזמנה. Purchase מהדפדפן **לא נשלח** |
| Lead | לא נשלח | — | — | עד שתהיה הגדרת ליד לפני רכישה |

אם CAPI נכשל, השליחה נשמרת ב-outbox ונשלחת שוב בריצה יומית (cron ב-Hobby מוגבל לפעם ביום). כשל CAPI לא משפיע על ההזמנה או על האפיון.
שורת ה-outbox נוצרת יחד עם סימון התשלום, באותה טרנזקציה. ה-payload נבנה **בזמן השליחה** מההזמנה העדכנית:
- בלי הסכמה לפרסום: לא נשלח, והשורה ממתינה (`no_consent`) עד 7 ימים.
- אחרי החזר מלא: מבוטל (`cancelled_refund`).
- מעל 7 ימים: פג (`expired`).
**ייחוס Meta נפרד מייחוס האתר.** הדשבורד מציג את שניהם בשמות שונים, ולא מכריחים אותם להתאים.

## 6. סיכום שיחה מובנה (ElevenLabs Data Collection)
שדות שיוגדרו בסוכנת. כל אחד כולל `value` ו-`basis` (`stated` = נאמר במפורש, `inferred` = הערכה):
`business_type`, `promote_goal`, `customer_goal`, `objections` (רשימה מתוך: `price`, `trust`, `fit`, `timing`, `examples`, `other`), `asked_price`, `asked_examples`, `asked_delivery_time`, `asked_payment`, `question_answered`, `last_stage` (`intro`/`need`/`offer`/`objection`/`close`/`payment`/`brief`), `confusion_or_repeat`.
- **שתיקה לא מסווגת כהתנגדות.**
- זמן עד תגובה ראשונה ומעבר בין קול לטקסט: רק אם התמלול מכיל חותמות זמן ומצב. אחרת `unknown`.

## 7. מה לא ניתן למדוד (במוצהר)
- מי ראה את המודעה בפייסבוק ולא נכנס: נתון מצרפי בלבד מ-Meta.
- חיבור שיחה בזמן אמת, הודעה ראשונה בזמן אמת וחסימת מיקרופון: הווידג'ט לא חושף אותם.
- טעינת עמוד PayPal: נמדדים הלחיצה (`checkout_clicked`) ויצירת ההזמנה בשרת (`checkout_created`). לא נמדד "צפה בעמוד התשלום".
- שליחת הודעת וואטסאפ.
- חיבור בין מכשירים בלי `order_token` (קישור אישי).
- מבקרים שסירבו למדידה: רק אירועי הזמנה ותשלום נשמרים עבורם.

## 8. פרטיות ושמירה
- `events`: בלי פרטים אישיים. IP לא נשמר. נשמר רק User-Agent מקוצר (משפחת דפדפן ומכשיר).
- `orders.contact`: מוצפן במנוחה ברמת הספק. נגיש רק דרך admin.
- `conversations.transcript`: טבלה נפרדת. נגיש רק דרך admin. **הצעה** למדיניות שמירה: 180 יום, ואז מחיקה. ההחלטה של אלון.
- Clarity: מסכה על כל השדות, על טקסט הצ'אט (shadow DOM של הווידג'ט) ועל אזור פרטי הקשר. נטען רק עם הסכמה למדידה.
- סודות: רק במשתני סביבה בשרת. שום סוד לא מופיע בקוד לקוח או במסמכים.

## 9. מקור אמת לכל מספר בדשבורד
| מספר | מקור |
|---|---|
| כניסות, אזורים, זמן פעיל, פתיחות סוכנת, לחיצות | `events` (רק מבקרים שהסכימו). בתצוגה: "מבוסס על N מבקרים שהסכימו למדידה" |
| הזמנות, תשלומים, אפיון | `orders` + `payments` (כולם) |
| שיחות | `conversations` (webhook, מאוחר) |
| הוצאה, חשיפות, צפיות וידאו, הקלקות | Meta Marketing API (ייחוס Meta). חיבור קריאה נפרד; לא חוסם |
