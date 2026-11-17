/* ICG native glue — only in the phone app build (ICG_NATIVE). The app itself is unchanged; this adds what a phone expects:
   - Android back button: closes an open sheet, then walks back screen by screen, and from a home screen sends the app to
     the background (the session stays signed in) instead of closing it.
   - update notice: when a newer test build is published, a small bar offers to download it.
   - notifications: after sign-in the phone is registered for the account's notifications (SOS on a loud channel);
     tapping one opens the app on the right screen; signing out unregisters the phone (sync.js). */
(function (root) {
  'use strict';
  var CAP = root.Capacitor; if (!CAP || !CAP.isNativePlatform || !CAP.isNativePlatform()) return;
  var BUILD = root.ICG_BUILD || {};
  function plugin(n) { return (CAP.Plugins && CAP.Plugins[n]) || (CAP.registerPlugin ? CAP.registerPlugin(n) : null); }
  var App = plugin('App');

  function onBack() {
    var a = root.ICG_APP; if (!a) return away();
    var m = a.state && a.state.mode, sub = m && m !== 'auth' && a.subs ? a.subs[m] : null;
    if (sub && sub.state) {
      var st = sub.state;
      if (st.sheet) { sub.setState({ sheet: '' }); return; }
      if (st.s && ['home', 'auto', 'bye'].indexOf(st.s) < 0 && sub.back) { sub.back(); return; }
      return away();
    }
    var s = a.state && a.state.a;
    if (s && ['welcome', 'splash', 'detect'].indexOf(s) < 0) { a.setState({ a: 'welcome' }); return; }
    away();
  }
  function away() { try { App && App.minimizeApp ? App.minimizeApp() : (App && App.exitApp && App.exitApp()); } catch (e) {} }
  if (App && App.addListener) App.addListener('backButton', onBack);
  root.ICG_NATIVE_BACK = onBack;                                        // for the automated phone test

  /* notifications on the lock screen (only in builds that carry the Firebase config) */
  var Push = BUILD.push ? plugin('PushNotifications') : null, pushToken = null;
  function lang() { var a = root.ICG_APP; return a && a.state && a.state.lang === 'en' ? 'en' : 'ar'; }
  function registerDevice() {
    var S = root.ICG_SYNC; if (!pushToken || !S || !S.state.ready) return;
    S.net.rpc('register_device', { p_token: pushToken, p_platform: CAP.getPlatform ? CAP.getPlatform() : 'android', p_lang: lang() }).catch(function (e) { console.warn('[ICG push] register', e && e.message); });
  }
  function askPush() {
    Push.checkPermissions().then(function (p) { return /prompt/.test(p.receive) ? Push.requestPermissions() : p; })
      .then(function (p) { if (p.receive === 'granted') return Push.register(); })
      .catch(function (e) { console.warn('[ICG push] permission', e && e.message); });
  }
  function openFrom(n) {                                                 // tapping a notification opens the right screen
    var d = (n && n.notification && n.notification.data) || {}, a = root.ICG_APP; if (!a) return;
    var m = a.state && a.state.mode, sub = m && a.subs ? a.subs[m] : null, link = null;
    try { link = JSON.parse(d.link || 'null'); } catch (e) {}
    if (!sub) return;
    if (m === 'guard' && d.urgent === '1') sub.setState({ s: 'home', hist: [], sheet: '' });
    else if (m === 'res' && link && link.s) sub.setState({ s: link.s, hist: ['home'], sheet: '' });
    if (root.ICG_SYNC && root.ICG_SYNC.flush) root.ICG_SYNC.flush();
  }
  if (Push) {
    Push.createChannel({ id: 'sos', name: 'استغاثات عاجلة', description: 'استغاثات السكان وتنبيهات الطوارئ', importance: 5, visibility: 1, vibration: true, lights: true, lightColor: '#E5484D' }).catch(function () {});
    Push.createChannel({ id: 'general', name: 'إشعارات التطبيق', description: 'الطلبات والتصاريح والمخالفات وأخبار الموقع', importance: 4, visibility: 0, vibration: true }).catch(function () {});
    Push.addListener('registration', function (t) { pushToken = t && t.value; root.ICG_PUSH_TOKEN = pushToken; registerDevice(); });
    Push.addListener('registrationError', function (e) { console.warn('[ICG push] registration', JSON.stringify(e)); });
    Push.addListener('pushNotificationActionPerformed', function (n) { var go = function () { root.ICG_APP && root.ICG_APP.state.mode !== 'auth' ? openFrom(n) : setTimeout(go, 500); }; go(); });
    (function waitSync() {
      var S = root.ICG_SYNC; if (!S) return setTimeout(waitSync, 300);
      S.on(function (ev) { if (ev === 'ready') { askPush(); registerDevice(); } });
      if (S.state.ready) askPush();
    })();
  }

  /* the gate's camera: Google's code scanner (no camera permission needed, works offline once installed) */
  var hasScan = CAP.isPluginAvailable ? CAP.isPluginAvailable('BarcodeScanner') : !!(CAP.Plugins && CAP.Plugins.BarcodeScanner);
  var Scan = hasScan ? plugin('BarcodeScanner') : null;
  if (Scan) root.ICG_NATIVE_SCAN = function () {
    function go() { return Scan.scan({ formats: ['QR_CODE'] }).then(function (r) { var b = r && r.barcodes && r.barcodes[0]; return b ? (b.rawValue || b.displayValue || '') : null; }); }
    return go().catch(function (e) {
      var m = String((e && (e.message || e.code)) || e);
      if (/cancel/i.test(m)) return null;
      if (/module|install|unavailable/i.test(m) && Scan.installGoogleBarcodeScannerModule)          // first use on this phone: fetch the scanner once
        return Scan.installGoogleBarcodeScannerModule().then(function () { return new Promise(function (ok) { setTimeout(ok, 3000); }); }).then(go);
      throw e;
    });
  };

  /* update notice */
  function checkUpdate() {
    if (!BUILD.site || !BUILD.n) return;
    fetch(BUILD.site + '/download/version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!v || !(+v.build > +BUILD.n) || document.getElementById('icgUpd')) return;
      var d = document.createElement('div'); d.id = 'icgUpd'; d.setAttribute('role', 'status'); d.dir = 'rtl';
      d.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 10px);z-index:2147483500;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:16px;background:#0D2740;color:#fff;font:600 14px/1.5 "IBM Plex Sans Arabic",system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.35)';
      d.innerHTML = '<span style="flex:1">نسخة أحدث من التطبيق متاحة</span><a id="icgUpdGo" style="color:#061629;background:#FDB515;border-radius:999px;padding:5px 14px;text-decoration:none;font-weight:700">تحديث</a><button type="button" aria-label="إغلاق" style="border:0;background:transparent;color:#9FB6CF;font:inherit;font-size:18px;cursor:pointer">×</button>';
      d.querySelector('#icgUpdGo').href = BUILD.site + '/download/';
      d.querySelector('button').onclick = function () { d.remove(); };
      document.body.appendChild(d);
    }).catch(function () {});
  }
  setTimeout(checkUpdate, 4000);
  if (App && App.addListener) App.addListener('resume', checkUpdate);
})(typeof window !== 'undefined' ? window : globalThis);
