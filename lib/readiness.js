// What production needs before it takes real orders. Shown in the dashboard; names only, never values.
import { cfg } from './config.js';

const TEST_AGENT = 'agent_5801m4a74w3dfawt9hdjhbe1nrjc';   // the v5 test agent: never the production agent
const has = (k) => !!(process.env[k] || '').trim();

export function readiness() {
  const prod = cfg.environment === 'production';
  const checks = [
    ['database', has('DATABASE_URL'), 'DATABASE_URL — מסד נתונים נפרד לייצור'],
    ['paypal_live', !prod || (process.env.PAYPAL_ENV === 'live'), 'PAYPAL_ENV=live'],
    ['paypal_keys', has('PAYPAL_CLIENT_ID') && has('PAYPAL_CLIENT_SECRET'), 'PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET (Live)'],
    ['paypal_webhook', has('PAYPAL_WEBHOOK_ID'), 'PAYPAL_WEBHOOK_ID — webhook Live אל ' + cfg.siteUrl + '/api/paypal/webhook'],
    ['paypal_payee', has('PAYPAL_MERCHANT_ID'), 'PAYPAL_MERCHANT_ID — חשבון המוכר Live'],
    ['agent', has('ELEVENLABS_AGENT_ID') && (!prod || process.env.ELEVENLABS_AGENT_ID !== TEST_AGENT), 'ELEVENLABS_AGENT_ID — סוכנת ייצור (לא סוכנת הבדיקה)'],
    ['agent_webhook', has('ELEVENLABS_WEBHOOK_SECRET'), 'ELEVENLABS_WEBHOOK_SECRET — webhook שיחות אל ' + cfg.siteUrl + '/api/elevenlabs/webhook'],
    ['emails', has('MAKE_NOTIFY_URL'), 'MAKE_NOTIFY_URL — מיילים'],
    ['admin', has('ADMIN_EMAIL'), 'ADMIN_EMAIL — כניסה לדשבורד'],
    ['no_test_recipients', !prod || !has('NOTIFY_TEST_RECIPIENTS'), 'NOTIFY_TEST_RECIPIENTS לא מוגדר בייצור'],
    ['meta_pixel', has('META_PIXEL_ID'), 'META_PIXEL_ID'],
    ['meta_capi', has('META_CAPI_TOKEN'), 'META_CAPI_TOKEN — רכישות לשרת של Meta'],
    ['meta_no_test_code', !prod || !has('META_TEST_EVENT_CODE'), 'META_TEST_EVENT_CODE לא מוגדר בייצור'],
    ['site_url', has('SITE_URL') && /^https:\/\//.test(cfg.siteUrl), 'SITE_URL — כתובת האתר הסופית (בקישורים במיילים)'],
    ['cron', has('CRON_SECRET'), 'CRON_SECRET — ריצת שחזור יומית'],
  ];
  return { environment: cfg.environment, site_url: cfg.siteUrl, ok: checks.every(c => c[1]),
           checks: checks.map(([key, ok, what]) => ({ key, ok, what })) };
}
