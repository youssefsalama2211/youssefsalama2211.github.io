/* ICG live sync — connects the app's in-memory data store (DB) to the platform server.
   Only active in the live build (window.ICG_LIVE = { url, anonKey, tables }); the demo build is untouched.

   load    : after sign-in, every table the account may read is fetched (the server's row security decides what that is)
             and replaces the demo data; config documents (settings, fines table…) come from the server too.
   push    : after every interaction the store is compared with what the server last confirmed; new, changed and removed rows
             are sent. If the server refuses a change (not allowed), the row is restored from the server copy.
   live    : changes made by anyone else arrive over realtime and are applied in place, then the screen refreshes.
   ids     : DB.d.seq hands out numbers from blocks reserved on the server, so ids and codes never collide between devices.
   time    : the clock and «today» follow real Cairo time instead of the demo day.
   offline : the account's data, the not-yet-sent changes and the screen state are kept on the phone (IndexedDB), so the gate
             keeps working without internet — also after the app is closed and reopened — and everything is sent when the
             connection returns. New rows made offline get ids no other phone can produce. Signing out wipes the copy. */
(function (root) {
  'use strict';
  var CFG = root.ICG_LIVE;
  if (!CFG || !root.ICGNet) { root.ICG_SYNC = null; return; }
  var TABLES = CFG.tables || [];
  /* public copies: a role reads some tables partly from «<table>_pub» — the rows of others without their private details
     (a technician's phone and national ID, a listing owner's phone). Those rows are shown, never written back (S.pub). */
  var PUB = CFG.pub || {};
  /* tables that only grow (the gate log, the activity log, notifications, visitor passes) are loaded for their last days
     only — a phone at the gate does not need last month's movements; counts come from gateDays. days per role ('*' = any) */
  // (thousands of units: a big site's gate logs thousands of movements a day — the gate keeps the last 12 hours, the desks
  // the last day; the counts come from gateDays)
  var WINDOW = { gatelog: { guard: 0.5, sup: 0.5, '*': 1 }, audit: { '*': 7 }, notifs: { '*': 21 }, passes: { guard: 7, sup: 7, cs: 14, admin: 14, udf: 14 },
                 dues: { cs: 186, admin: 186, udf: 186 },     // charges: staff keep every unpaid one and the last six months
                 orders: { guard: 14, sup: 14 } };            // the gate: requests still open, and the last two weeks of the rest
  var KEEP = { dues: 'status.neq.paid', orders: 'data->>stage.in.(new,offer,rej,acc,sched,gate,work,due,verifying)' };
  // how far back a growing table is read (ms), or null; the gate log always covers the whole of today (the day's counts)
  function backMs(t, role) {
    var w = WINDOW[t]; if (!w) return null; role = role || S.role;
    var n = w[role] != null ? w[role] : w['*']; if (n == null) return null;
    return t === 'gatelog' ? Math.max(n * 86400000, cairo().mins * 60000 + 60000) : n * 86400000;
  }
  function sinceOf(t) {
    var ms = backMs(t); if (ms == null) return '';
    var iso = new Date(Date.now() - ms).toISOString().slice(0, 19) + 'Z';
    return KEEP[t] ? 'or=(' + KEEP[t] + ',created_at.gte.' + encodeURIComponent(iso) + ')' : 'created_at=gte.' + encodeURIComponent(iso);
  }
  /* only the tables my role may read, asked the way the rules read them (my rows · my site · notifications to me), so the
     server goes straight to them through its indexes instead of looking through every row (row security still decides) */
  var READ = CFG.read || null, ANON = CFG.anon || [];
  function readable(t) { if (!READ || !READ[t]) return true; var r = READ[t][S.role || '']; return r != null; }
  function hintOf(t) {
    if (!READ || !READ[t] || !S.me) return '';
    var tok = [].concat(READ[t][S.role] || []), me = S.me.id, s = S.me.site, r = S.role;
    if (!tok.length || !me) return '';
    var only = function (x) { return tok.every(function (k) { return x.indexOf(k) >= 0; }); };
    if (only(['own', 'by']) && ANON.indexOf(t) < 0) return 'res_id=eq.' + encodeURIComponent(me);
    if (only(['to'])) return 'res_id=in.(' + [me, 'all', 'site:' + s, r + ':' + s, 'role:' + r].map(function (x) { return encodeURIComponent('"' + x + '"'); }).join(',') + ')';
    if (only(['site']) && s && s !== 'all') return 'site=in.(' + encodeURIComponent('"' + s + '"') + ',all)';
    return '';
  }
  function filterOf(t) { return [hintOf(t), sinceOf(t)].filter(Boolean).join('&'); }
  function pubFor(role) { return Object.keys(PUB).filter(function (t) { return (PUB[t] || []).indexOf(role) >= 0; }); }
  function isPub(t, id) { return !!(S.pub[t] && S.pub[t][String(id)]); }
  var DOC_KEYS = ['settings', 'specs', 'regsVer', 'fin', 'attendance'];   // (an order's conversation lives in the order itself — see chatView)
  var net = root.ICGNet({ url: CFG.url, anonKey: CFG.anonKey, storage: safeStorage() });
  var S = { snap: {}, docSnap: {}, pub: {}, ready: false, me: null, queue: [], pushing: false, blocks: {}, live: 'off', errors: [], listeners: [], docUrls: {} };
  function dataBlob(u) { var m = /^data:([^;]+);base64,(.*)$/.exec(String(u)), b = root.atob(m[2]), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return new root.Blob([a], { type: m[1] }); }
  function safeStorage() { try { var k = '__icg'; root.localStorage.setItem(k, '1'); root.localStorage.removeItem(k); return root.localStorage; } catch (e) { return undefined; } }
  function J(x) { return JSON.stringify(x); }
  function noop() {}

  /* ---------------- the copy kept on the phone (IndexedDB) ---------------- */
  var IDB = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        if (!root.indexedDB) return rej(new Error('no indexedDB'));
        var r = root.indexedDB.open('icg-live', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); };
      });
      dbp.catch(function () { dbp = null; });
      return dbp;
    }
    function tx(mode, fn) { return open().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('kv', mode), q = fn(t.objectStore('kv')); t.oncomplete = function () { res(q && q.result); }; t.onerror = t.onabort = function () { rej(t.error); }; }); }); }
    return { get: function (k) { return tx('readonly', function (st) { return st.get(k); }); }, set: function (k, v) { return tx('readwrite', function (st) { st.put(v, k); }); }, del: function (k) { return tx('readwrite', function (st) { st.delete(k); }); } };
  })();
  function saveSoon() { clearTimeout(S.svT); S.svT = setTimeout(saveNow, 1500); }
  function saveNow() {
    clearTimeout(S.svT);
    if (!S.ready || !S.me || !net.session || !net.session.user) return;
    var d = DBx().d, local = {}, docs = {};
    // the desks (customer service, admin, Fund) work online: only their unsent changes are kept (a full copy of thousands of
    // rows would stall the screen every time it is saved); residents' and the gate's phones keep everything for offline use
    if (!BUNDLE[S.role]) { try { IDB.set('cache', JSON.parse(J({ v: 1, desk: true, uid: net.session.user.id, me: S.me, at: Date.now(), queue: S.queue }))).catch(noop); } catch (e) {} return; }
    TABLES.forEach(function (t) { local[t] = (d[t] || []).filter(function (o) { return o && o.id != null; }).map(function (o) { return stored(t, o, true); }); });
    DOC_KEYS.forEach(function (k) { if (d[k] != null) docs[k] = d[k]; });
    try { IDB.set('cache', JSON.parse(J({ v: 1, uid: net.session.user.id, me: S.me, at: Date.now(), local: local, docs: docs, snap: S.snap, docSnap: S.docSnap, pub: S.pub, queue: S.queue, gate: S.gate || null, gateKeys: S.gateKeys || null }))).catch(noop); } catch (e) {}
  }
  // reopened without internet: the app comes back exactly as it was left, with its unsent changes
  async function fromCache() {
    var c = await IDB.get('cache').catch(function () { return null; });
    if (!c || c.v !== 1 || c.desk || !net.session || !net.session.user || c.uid !== net.session.user.id) return null;
    var D = DBx(), d = D.d;
    D.LIVE = true; clearSample(d);
    TABLES.forEach(function (t) { d[t] = (c.local[t] || []).map(function (o) { return relabel(o, t); }); });
    DOC_KEYS.forEach(function (k) { if (c.docs[k] != null) d[k] = c.docs[k]; });
    S.snap = c.snap || {}; S.docSnap = c.docSnap || {}; S.pub = c.pub || {}; S.queue = c.queue || []; S.gate = c.gate || null; S.gateKeys = c.gateKeys || null;
    d.trash = d.trash || []; D.SITES = d.sites; if (D.SPECS !== undefined) D.SPECS = d.specs;
    d.seq = seqProxy(); if (D.applyBrand) D.applyBrand(); D.ver++;
    S.ready = true; S.me = c.me; S.role = c.me && c.me.role; S.cachedAt = c.at; d.anonMine = anonOf(c.me);
    D.login(c.me.id); setStatus('offline'); startLive(); emit('ready', c.me);
    return { state: 'active', me: D.get('accounts', c.me.id) || c.me, offline: true };
  }
  function DBx() { return root.DB; }
  // a resident's anonymous complaints no longer name him: the server tells his app which they are (kept with the offline copy)
  function anonOf(me) { if (!me) return []; if (!Array.isArray(me.anonMine)) me.anonMine = []; return me.anonMine; }
  function emit(ev, x) { S.listeners.forEach(function (f) { try { f(ev, x); } catch (e) {} }); }
  function refresh() { var a = root.ICG_APP; if (a && a.bump) { clearTimeout(S.rt); S.rt = setTimeout(function () { try { if (a.cache && a.state.mode && a.state.mode !== 'auth') a.cache[a.state.mode] = null; a.bump(); } catch (e) {} }, 30); } }

  /* ---------------- real time (Cairo) ---------------- */
  function cairo(d) {
    var p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d || new Date()).forEach(function (x) { p[x.type] = x.value; });
    return { ymd: p.year + '-' + p.month + '-' + p.day, mins: (+p.hour % 24) * 60 + (+p.minute) };
  }
  root.ICG_TODAY = cairo().ymd;                                           // read by the data layer when it loads

  function installClock() {
    var D = DBx(); if (!D) return;
    D.TODAY = root.ICG_TODAY;
    var timeOf = function (m) { var h = Math.floor(m / 60) % 24, mi = m % 60, h12 = h % 12 || 12, pm = h >= 12, pad = mi < 10 ? '0' + mi : '' + mi; return D.L(h12 + ':' + pad + (pm ? ' م' : ' ص'), h12 + ':' + pad + (pm ? ' PM' : ' AM')); };
    D.now = function () { D.d.clock = cairo().mins; return timeOf(D.d.clock); };
    D.tick = function () { return D.now(); };
    /* a new day while the app is open (a night shift runs past midnight): «today» must move on. The app reopens itself on the
       new date once the person has not touched the screen for two minutes and every change has been sent (or kept offline). */
    if (!S.dayWatch && typeof setInterval === 'function' && typeof document !== 'undefined' && typeof document.addEventListener === 'function' && typeof location !== 'undefined') {
      S.dayWatch = true; S.touched = Date.now();
      ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function () { S.touched = Date.now(); }, { passive: true, capture: true }); });
      setInterval(function () {
        if (cairo().ymd === root.ICG_TODAY) return;
        if (Date.now() - S.touched < 120000 || S.inflight || S.pushing) return;
        S.touched = Date.now(); saveNow(); setTimeout(function () { try { location.reload(); } catch (e) {} }, 1500);   // the offline copy is written first
      }, 30000);
    }
  }

  /* ---------------- ids from reserved blocks ---------------- */
  function syncReserve(key, n) {                                           // rare fallback: first use of a counter
    var x = new XMLHttpRequest();
    x.open('POST', CFG.url + '/rest/v1/rpc/reserve_ids', false);
    x.setRequestHeader('apikey', CFG.anonKey); x.setRequestHeader('Content-Type', 'application/json');
    if (net.session) x.setRequestHeader('Authorization', 'Bearer ' + net.session.access_token);
    x.send(J({ p_key: key, p_n: n }));
    if (x.status !== 200) throw new Error('could not reserve ids for ' + key);
    return +JSON.parse(x.responseText);
  }
  function tryReserve(key) { try { return syncReserve(key, 20); } catch (e) { return null; } }
  // no connection and no reserved numbers left: a number from a range the server never hands out (reserved blocks start at
  // 10000 and grow by 20), random so two phones offline at the same time do not collide
  function offlineId() { return 900000000 + Math.floor(Math.random() * 99000000); }
  function refill(key) {
    var b = S.blocks[key]; if (!b || b.filling) return;
    b.filling = true;
    net.rpc('reserve_ids', { p_key: key, p_n: 20 }).then(function (start) { b.queue.push([+start, +start + 20]); }).catch(function () {}).then(function () { b.filling = false; });
  }
  function seqProxy() {
    return new Proxy({}, {
      get: function (o, key) {
        if (typeof key !== 'string') return undefined;
        if (!/^[A-Za-z]{1,6}$/.test(key)) return o[key];
        var b = S.blocks[key];
        if (!b) { var st = tryReserve(key); if (st == null) return offlineId(); b = S.blocks[key] = { next: st, end: st + 20, queue: [] }; }
        if (b.next >= b.end) { var nb = b.queue.shift(); if (!nb) { var s2 = tryReserve(key); if (s2 == null) return offlineId(); nb = [s2, s2 + 20]; } b.next = nb[0]; b.end = nb[1]; }
        if (b.end - b.next <= 5 && !b.queue.length) refill(key);
        return b.next;
      },
      set: function (o, key, v) { if (typeof key === 'string' && S.blocks[key]) S.blocks[key].next = +v; else o[key] = v; return true; }
    });
  }
  function prefetch(keys) {                                               // one request for every counter (older server: one each)
    keys = keys.filter(function (k) { var b = S.blocks[k]; return !b || b.end - b.next < 5; });
    if (!keys.length) return Promise.resolve();
    return net.rpc('reserve_many', { p_keys: keys, p_n: 20 }).then(function (m) {
      keys.forEach(function (k) { if (m && m[k] != null) S.blocks[k] = { next: +m[k], end: +m[k] + 20, queue: [] }; });
    }, function () {
      return Promise.all(keys.map(function (k) {
        return net.rpc('reserve_ids', { p_key: k, p_n: 20 }).then(function (st) { S.blocks[k] = { next: +st, end: +st + 20, queue: [] }; }).catch(function () {});
      }));
    });
  }

  /* ---------------- relative day labels («اليوم», «Today») follow the real date ---------------- */
  function dayLabel(ts) {
    var t = root.ICG_TODAY; if (!ts || ts === t) return null;
    var d0 = new Date(t + 'T00:00:00Z'), d1 = new Date(String(ts).slice(0, 10) + 'T00:00:00Z'), diff = Math.round((d0 - d1) / 86400000);
    if (diff === 1) return ['أمس', 'Yesterday'];
    var p = String(ts).slice(0, 10).split('-'); return [+p[2] + '/' + +p[1], +p[2] + '/' + +p[1]];
  }
  // The new label is for the screen only: the server keeps the stored value. LBL remembers, per row, what was relabelled so
  // that comparing and saving use the stored value (otherwise every relabelled row would look edited and be sent).
  var LBL = {};
  function relabel(o, t) {
    if (!o || o.id == null) return o;
    var key = t + '/' + o.id; delete LBL[key];
    var lab = dayLabel(o.ts); if (!lab) return o;
    var m = null;
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && /^اليوم/.test(v[0]) && /^Today/.test(v[1])) {
        var shown = [v[0].replace(/^اليوم/, lab[0]), v[1].replace(/^Today/, lab[1])];
        (m = m || {})[k] = { orig: v, shown: J(shown) }; o[k] = shown;
      }
    });
    if (m) LBL[key] = m;
    return o;
  }
  function stored(t, o, keepLocal) {                                       // the row as the server knows it
    var m = LBL[t + '/' + o.id]; if (!m && (keepLocal || !('pend' in o))) return o;
    var c = {}; Object.keys(o).forEach(function (k) { if (k === 'pend' && !keepLocal) return; c[k] = (m && m[k] && J(o[k]) === m[k].shown) ? m[k].orig : o[k]; });
    return c;                                                              // «pend» (waiting to sync) is a screen-only marker
  }

  /* ---------------- load ---------------- */
  /* the built-in sample world is only for the demo: in the real app nothing of it may survive the load. Tables are replaced
     by the server's rows; the stores and documents below are not tables, so they start empty (or from the server copy). */
  function clearSample(d) {
    d.ledger = [];                                                       // monthly history of the sample world (reports use real records)
    d.fin = { bySite: {} };                                              // sample money baselines (figures are computed from records)
    d.chats = chatView(); d.attendance = { req: {} };
    if (d.settings) { d.settings.priceList = { approved: false }; delete d.settings.feesPub; }   // no approval claim until an admin records one
  }
  /* the conversation of an order is kept in the order (order.chat, a list that only grows): the resident and the customer
     service of the site both see it through the order, under its rules. The screens keep using DB.d.chats[orderId]. */
  function chatView() {
    function ord(k) { var a = (DBx().d.orders || []); for (var i = 0; i < a.length; i++) if (a[i] && String(a[i].id) === String(k)) return a[i]; return null; }
    return new Proxy({}, {
      get: function (t, k) { if (typeof k !== 'string') return undefined; var o = ord(k); return o ? o.chat : undefined; },
      set: function (t, k, v) { var o = ord(k); if (o) o.chat = v; return true; },
      has: function (t, k) { var o = ord(k); return !!(o && o.chat); },
      deleteProperty: function () { return true; },
      ownKeys: function () { return (DBx().d.orders || []).filter(function (o) { return o && o.chat && o.chat.length; }).map(function (o) { return String(o.id); }); },
      getOwnPropertyDescriptor: function (t, k) { var o = ord(k); return o && o.chat ? { value: o.chat, writable: true, enumerable: true, configurable: true } : undefined; }
    });
  }
  /* everything this account reads. The roles with many phones (residents, the gate) ask in one request (public.my_rows:
     the same rows the rules allow, each table asked through its indexes); the desks ask table by table, in pages.
     → { rows: { table: [{id, data}] }, pub: { table: [{id, data}] }, docs: [{key, site, data}] } */
  var BUNDLE = { res: 1, guard: 1, sup: 1 };
  function sinceMap(role) {
    var o = {};
    TABLES.forEach(function (t) { var ms = backMs(t, role); if (ms != null) o[t] = new Date(Date.now() - ms).toISOString(); });
    return o;
  }
  async function fetchAll(given) {
    var role = S.role || '';
    if (BUNDLE[role]) {
      var b = given || null;
      if (!b) {
        try { b = await net.rpc('my_rows', { p_since: sinceMap() }); }
        catch (e) { if (!e.status || e.status >= 500) throw e; }              // (a server without it yet: table by table)
      }
      if (b && typeof b === 'object') {
        var out = { rows: {}, pub: {}, docs: b.docs || [] };
        TABLES.forEach(function (t) { out.rows[t] = b[t] || []; });
        pubFor(role).forEach(function (t) { out.pub[t] = b[t + '_pub'] || []; });
        return out;
      }
    }
    var res = { rows: {}, pub: {}, docs: [] };
    await Promise.all(TABLES.map(function (t) { return readable(t) ? net.select(t, { columns: 'id,data', order: 'created_at.desc,id', filter: filterOf(t) }).then(function (rows) { res.rows[t] = rows; }) : (res.rows[t] = []); }));
    await Promise.all(pubFor(role).map(function (t) { return net.select(t + '_pub', { columns: 'id,data', order: 'id' }).then(function (rows) { res.pub[t] = rows; }, function () { res.pub[t] = []; }); }));
    res.docs = await net.select('docs', { columns: 'key,site,data', order: 'key' });
    return res;
  }
  async function load(op) {
    var D = DBx(), d = D.d;
    D.LIVE = true; clearSample(d);
    var all = await fetchAll(op && op.rows);
    TABLES.forEach(function (t) {
      var rows = all.rows[t] || []; S.snap[t] = {};
      d[t] = rows.map(function (r) { S.snap[t][r.id] = J(r.data); return relabel(r.data, t); });
    });
    S.pub = {};
    var role = S.role || '';
    Object.keys(all.pub).forEach(function (t) { mergePub(t, all.pub[t]); });
    if (role === 'res') { if (op && op.listing) applyActivity(op.listing); else await ownerActivity(); }
    all.docs.forEach(function (r) { if (DOC_KEYS.indexOf(r.key) >= 0 && (r.site === 'all' || !d[r.key])) { d[r.key] = r.data; S.docSnap[r.key] = { site: r.site, j: J(r.data) }; } });
    d.trash = d.trash || [];
    D.SITES = d.sites; if (D.SPECS !== undefined) D.SPECS = d.specs;
    d.seq = seqProxy();
    if (D.applyBrand) D.applyBrand();
    D.ver++;
  }
  // rows of others, as the public copy shows them (a row of my own, from the table itself, always wins)
  function mergePub(t, rows) {
    var d = DBx().d, arr = d[t] || (d[t] = []), pb = S.pub[t] || (S.pub[t] = {});
    rows.forEach(function (r) {
      var id = String(r.id); if (S.snap[t] && S.snap[t][id] !== undefined) return;
      var o = find(arr, id); pb[id] = 1;
      if (o) replaceIn(o, r.data, t); else arr.push(relabel(r.data, t));
    });
  }
  /* the owner of a listing sees the viewings and offers on it (without anyone's phone number) — a server summary */
  async function ownerActivity() {
    var a = await net.rpc('my_listing_activity').catch(function () { return null; }); if (a) applyActivity(a);
  }
  function applyActivity(a) {
    var d = DBx().d;
    ['leads', 'viewings'].forEach(function (t) {
      var arr = d[t] || (d[t] = []), pb = S.pub[t] || (S.pub[t] = {});
      for (var i = arr.length - 1; i >= 0; i--) if (arr[i] && pb[String(arr[i].id)]) arr.splice(i, 1);
      (a[t] || []).forEach(function (x) { var id = String(x.id); if (S.snap[t] && S.snap[t][id] !== undefined) return; pb[id] = 1; arr.push(x); });
    });
    DBx().ver++;
  }
  // changes made offline before the app was closed are put back on top of the fresh server copy and sent again
  function replay(q) {
    var d = DBx().d;
    (q || []).forEach(function (x) {
      if (x.op === 'doc') { if (x.k) d[x.k] = JSON.parse(x.j); return; }
      var arr = x.t && d[x.t]; if (!arr) return;
      var o = find(arr, x.id);
      if (x.op === 'del') { if (o) arr.splice(arr.indexOf(o), 1); return; }
      var data = JSON.parse(x.j);
      if (o) replaceIn(o, data, x.t); else arr.unshift(relabel(data, x.t));
    });
  }

  /* ---------------- push ---------------- */
  function scan() {
    if (!S.ready) return;
    var d = DBx().d;
    TABLES.forEach(function (t) {
      var arr = d[t] || [], sn = S.snap[t] || (S.snap[t] = {}), seen = {};
      for (var i = 0; i < arr.length; i++) {
        var o = arr[i]; if (!o || o.id == null) continue;
        if (isPub(t, o.id) && sn[String(o.id)] === undefined) continue;   // (someone else's row as its public copy shows it: never written back)
        var id = String(o.id), j = J(stored(t, o)); seen[id] = 1;
        if (sn[id] === undefined) { sn[id] = j; S.queue.push({ op: 'ins', t: t, id: id, j: j }); }
        else if (sn[id] !== j) { var prev = sn[id]; sn[id] = j; S.queue.push({ op: 'upd', t: t, id: id, j: j, prev: prev }); }
      }
      Object.keys(sn).forEach(function (id) { if (!seen[id]) { var prev = sn[id]; delete sn[id]; delete LBL[t + '/' + id]; S.queue.push({ op: 'del', t: t, id: id, prev: prev }); } });
    });
    DOC_KEYS.forEach(function (k) {
      if (d[k] == null) return; var j = J(d[k]), s = S.docSnap[k];
      if (!s) { S.docSnap[k] = { site: 'all', j: j, fresh: true }; return; }   // documents the server doesn't hold yet stay local until an admin saves them
      if (s.j !== j) { s.j = j; S.queue.push({ op: 'doc', k: k, site: s.site, j: j, fresh: !!s.fresh }); }
    });
    if (S.queue.length) { saveSoon(); pump(); }
  }
  async function pump() {
    if (S.pushing) return; S.pushing = true;
    try {
      while (S.queue.length) {
        var q = S.queue.shift(); S.inflight = q;
        try {
          if (q.op === 'ins') {
            await net.insert(q.t, { id: q.id, data: JSON.parse(q.j) }, { minimal: true });   // (the writer may not be allowed to read it back: an alert to the guards)
            // the server's own copy right away (a pass with its signature, the filled-in site…), without waiting for realtime
            var back = await net.select(q.t, { columns: 'id,data', filter: 'id=eq.' + encodeURIComponent(q.id) }).catch(function () { return []; });
            if (back[0] && S.snap[q.t] && S.snap[q.t][q.id] === q.j) accept(q.t, back[0], q.j);   // (a newer change waiting to be sent brings it back itself)
          }
          else if (q.op === 'upd') { var u = await net.update(q.t, q.id, { data: JSON.parse(q.j) }); if (u) accept(q.t, u, q.j); else { report('refused', 'upd ' + q.t + ': not visible', q.id); await restore(q.t, q.id, 'not-visible'); } }
          else if (q.op === 'del') { await net.remove(q.t, q.id); }
          else if (q.op === 'doc') {                                             // only the roles the rules allow change a document (e.g. the admin)
            var dk = await net.updateDoc(q.k, q.site, JSON.parse(q.j)).catch(function () { return null; });
            if (!dk && q.fresh && S.me && S.me.role === 'admin') { await net.insertDoc(q.k, q.site, JSON.parse(q.j)).catch(function () {}); if (S.docSnap[q.k]) S.docSnap[q.k].fresh = false; }
          }
          S.inflight = null; emit('saved', q);
        } catch (e) {
          S.inflight = null;
          S.errors.push({ at: Date.now(), q: q, msg: e.message }); emit('refused', { q: q, msg: e.message, status: e.status });
          if (e.status && e.status !== 401) report('refused', (q.op || '') + ' ' + (q.t || q.k || '') + ': ' + e.message, q.id);
          if (e.status === 401 || e.status === 403 || e.status === 400 || e.status === 409) await restore(q.t, q.id, e.message);
          else { S.queue.unshift(q); setStatus('offline'); await wait(4000); }      // network trouble: keep the change and retry
        }
      }
    } finally { S.pushing = false; saveSoon(); }
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /* what goes wrong on real phones reaches us: screen errors and changes the server refused are written to «errors»
     (only the admin reads them; at most 20 different ones per session; no data of the record, only where and what) */
  var REP = { n: 0, seen: {} };
  function report(kind, msg, more) {
    try {
      if (!S.ready || !S.me || !net.session || REP.n >= 20) return;
      var m = String(msg == null ? '' : msg).slice(0, 300), k = kind + '|' + m; if (REP.seen[k]) return; REP.seen[k] = 1; REP.n++;
      var a = root.ICG_APP, st = (a && a.state) || {}, sub = a && a.subs && st.mode ? a.subs[st.mode] : null, ss = (sub && sub.state) || {};
      var id = 'ER' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      net.insert('errors', { id: id, data: { id: id, by: S.me.id, role: S.me.role, site: S.me.site, kind: kind, msg: m, more: String(more == null ? '' : more).slice(0, 600),
        app: st.mode || '', screen: String(ss.s || ss.page || '') + (ss.sheet ? '/' + ss.sheet : '') + (ss.modal ? '/' + ss.modal : ''), build: CFG.build || '',
        ua: String((root.navigator && root.navigator.userAgent) || '').slice(0, 160), at: new Date().toISOString() } }, { minimal: true }).catch(noop);
    } catch (e) {}
  }
  if (root.addEventListener) {
    root.addEventListener('error', function (e) { report('screen', e && e.message, ((e && e.filename) || '') + ':' + ((e && e.lineno) || '') + ' ' + String((e && e.error && e.error.stack) || '').split('\n').slice(0, 4).join(' | ')); });
    root.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; report('promise', (r && r.message) || r, r && r.stack ? String(r.stack).split('\n').slice(0, 4).join(' | ') : ''); });
  }
  function accept(t, row, sent) {                                          // the server may normalise a row (site, ids…): adopt its copy
    var j = J(row.data); S.snap[t][row.id] = j;
    var arr = DBx().d[t], o = find(arr, row.id);
    if (o && J(stored(t, o)) !== j) { replaceIn(o, merged(t, o, sent, row.data), t); refresh(); }
  }
  /* a row that comes back from the server while it was changed again here (the second tap came before the phone looked for
     changes, or a photo finished uploading): the server's copy, but every key changed here since `base` (what was sent)
     stays as it is here — the next look sends it. Without this a quick «reply, then resolve» lost the «resolve». */
  function merged(t, o, base, data) {
    if (base == null) return data;
    var cur = stored(t, o); if (J(cur) === base) return data;
    var b = JSON.parse(base), m = Object.assign({}, data);
    Object.keys(cur).forEach(function (k) { if (J(cur[k]) !== J(b[k])) m[k] = cur[k]; });
    Object.keys(b).forEach(function (k) { if (!(k in cur)) delete m[k]; });
    return m;
  }
  async function restore(t, id, why) {
    if (!t) return;
    var rows = await net.select(t, { columns: 'id,data', filter: 'id=eq.' + encodeURIComponent(id) }).catch(function () { return []; });
    var arr = DBx().d[t], o = find(arr, id);
    if (rows[0]) { S.snap[t][id] = J(rows[0].data); if (o) replaceIn(o, rows[0].data, t); else arr.unshift(relabel(rows[0].data, t)); }
    else { delete S.snap[t][id]; if (o) arr.splice(arr.indexOf(o), 1); }
    DBx().ver++; refresh();
    if (root.console) console.warn('[ICG] change not accepted by the server:', t, id, why);
  }
  function find(arr, id) { if (!arr) return null; for (var i = 0; i < arr.length; i++) if (arr[i] && String(arr[i].id) === String(id)) return arr[i]; return null; }
  function replaceIn(o, data, t) { Object.keys(o).forEach(function (k) { delete o[k]; }); Object.assign(o, data); relabel(o, t); }

  /* ---------------- gate QR: residents show a signed code that changes every 15 minutes; the gate checks it ---------------- */
  async function gateRefresh() {
    if (!S.ready || !S.me) return;
    try {
      if (S.me.role === 'res') S.gate = await net.rpc('gate_codes');
      else if (S.me.role === 'guard' || S.me.role === 'sup') S.gateKeys = await net.rpc('gate_keys');
      S.gateAt = Date.now(); saveSoon(); refresh();
    } catch (e) {}
  }
  function gateWindow() { return Math.floor(Date.now() / 900000); }
  function gateQr() {
    var g = S.gate, w = gateWindow(); if (!g || !g.sigs) return null;
    var i = w - (+g.from); return i >= 0 && i < g.sigs.length ? 'ICG1.' + g.acct + '.' + w + '.' + g.sigs[i] : null;
  }
  function hexBytes(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  async function gateLocal(acct, w, sig) {                                 // without internet: check with the day key of this site
    var keys = S.gateKeys && S.gateKeys.keys, day = cairo(new Date(w * 900000)).ymd, kh = keys && keys[day];
    if (!kh || !root.crypto || !root.crypto.subtle) return { ok: false, why: 'nokey', acct: acct, offline: true };
    var key = await root.crypto.subtle.importKey('raw', hexBytes(kh), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var mac = new Uint8Array(await root.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(acct + '|' + w)));
    var hex = Array.prototype.map.call(mac, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('').slice(0, 10);
    return { ok: hex === sig, why: hex === sig ? null : 'forged', acct: acct, offline: true };
  }
  /* a visitor pass: the server signs it for the day of the visit → QR  ICGP.<code>.<YYMMDD>.<sig>; a guard's phone that has
     not received the pass yet checks the signature with the day keys it holds */
  function passQr(p) { return p && p.code && p.sig && /^\d{4}-\d\d-\d\d$/.test(p.dayTs || '') ? 'ICGP.' + p.code + '.' + p.dayTs.slice(2).replace(/-/g, '') + '.' + p.sig : null; }
  async function passVerify(qr) {
    var p = String(qr || '').trim().split('.');
    if (p.length !== 4 || p[0] !== 'ICGP' || !/^[A-Za-z0-9-]{3,16}$/.test(p[1]) || !/^\d{6}$/.test(p[2]) || !/^[0-9a-f]{10}$/.test(p[3])) return { ok: false, why: 'format' };
    var code = p[1], day = '20' + p[2].slice(0, 2) + '-' + p[2].slice(2, 4) + '-' + p[2].slice(4, 6), keys = S.gateKeys && S.gateKeys.keys, kh = keys && keys[day];
    if (!kh || !root.crypto || !root.crypto.subtle) return { ok: false, why: 'nokey', code: code, day: day };
    var key = await root.crypto.subtle.importKey('raw', hexBytes(kh), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var mac = new Uint8Array(await root.crypto.subtle.sign('HMAC', key, new TextEncoder().encode('P|' + code + '|' + day)));
    var hex = Array.prototype.map.call(mac, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('').slice(0, 10);
    return { ok: hex === p[3], why: hex === p[3] ? null : 'forged', code: code, day: day, offline: true };
  }
  async function gateVerify(qr) {
    var p = String(qr || '').trim().split('.');
    if (p.length !== 4 || p[0] !== 'ICG1' || !/^\d{6,10}$/.test(p[2])) return { ok: false, why: 'format' };
    var acct = p[1], w = +p[2];
    if (Math.abs(gateWindow() - w) > 2) return { ok: false, why: 'expired', acct: acct };
    try { var r = await net.rpc('gate_check', { p_qr: p.join('.') }); if (r) return r; } catch (e) { if (e && e.status) return { ok: false, why: 'error' }; }
    return gateLocal(acct, w, p[3]);
  }

  /* ---------------- live updates ---------------- */
  function onChange(c) {
    var t = c.table, d = DBx().d;
    if (t === 'docs') { var r0 = c.row; if (r0 && DOC_KEYS.indexOf(r0.key) >= 0) { d[r0.key] = r0.data; S.docSnap[r0.key] = { site: r0.site, j: J(r0.data) }; if (r0.key === 'settings' && DBx().applyBrand) DBx().applyBrand(); DBx().ver++; refresh(); } return; }
    if (/_pub$/.test(t)) {                                                  // someone else's row, as its public copy
      var bt = t.slice(0, -4), ba = d[bt]; if (!ba) return;
      var bid = String((c.row && c.row.id) || (c.old && c.old.id) || ''); if (!bid || (S.snap[bt] && S.snap[bt][bid] !== undefined)) return;
      if (c.type === 'DELETE') { var bx = find(ba, bid); if (bx) ba.splice(ba.indexOf(bx), 1); if (S.pub[bt]) delete S.pub[bt][bid]; }
      else if (c.row && c.row.data) mergePub(bt, [c.row]);
      DBx().ver++; refresh(); return;
    }
    var arr = d[t]; if (!arr) return;
    if (c.type === 'DELETE') { var oid = c.old && c.old.id; if (oid == null) return; var x = find(arr, oid); if (x) arr.splice(arr.indexOf(x), 1); delete S.snap[t][oid]; DBx().ver++; refresh(); return; }
    var row = c.row; if (!row || !row.data) return;
    var j = J(row.data); if (S.snap[t][row.id] === j) return;               // our own change coming back
    var o = find(arr, row.id);
    if (o) replaceIn(o, merged(t, o, S.snap[t][row.id], row.data), t); else arr.unshift(relabel(row.data, t));   // (what is being changed here stays)
    S.snap[t][row.id] = j; DBx().ver++; refresh(); emit('remote', c); saveSoon();
  }
  function setStatus(s) { if (S.live !== s) { S.live = s; emit('status', s); } }
  /* the server sends a short signal for every change (table · id · I/U/D) to the topics of the people who may read the row:
     u:<me>, <my role>:<my site>, <my role>:* (an account of every site listens to each site). The phone fetches the changed
     rows itself — row level security decides what comes back; a row that no longer comes back is no longer mine to see. */
  function liveTopics() {
    var me = S.me || {}, r = me.role || S.role, s = me.site, t = ['u:' + me.id, r + ':*'];
    if (s === 'all') (DBx().d.sites || []).forEach(function (x) { if (x && x.id && t.indexOf(r + ':' + x.id) < 0) t.push(r + ':' + x.id); });
    else if (s) t.push(r + ':' + s);
    return t;
  }
  var SIG = { q: {}, docs: {}, t: null, at: 0 };
  function onSignal(s, topic) {
    if (!S.ready || !s || !s.t) return;
    if (s.t === 'docs') { if (DOC_KEYS.indexOf(s.key) >= 0) { SIG.docs[s.key + '|' + s.site] = s; sigSoon(topic); } return; }
    if (TABLES.indexOf(s.t) < 0 || s.id == null) return;
    if (s.op === 'D') { dropRow(s.t, s.id); return; }
    (SIG.q[s.t] || (SIG.q[s.t] = {}))[String(s.id)] = 1; sigSoon(topic);
  }
  // a signal to a crowd (all the residents of a site…) is fetched at a random moment of the next few seconds, so that
  // thousands of phones don't all ask the server in the same second; a signal to me alone at once
  function sigSoon(topic) {
    var ms = S.role === 'res' && !/^u:/.test(topic || '') ? 300 + Math.random() * 4000 : 200, at = Date.now() + ms;
    if (SIG.t && SIG.at <= at) return;
    clearTimeout(SIG.t); SIG.at = at; SIG.t = setTimeout(sigFetch, ms);
  }
  function idList(ids) { return 'id=in.(' + ids.map(function (id) { return encodeURIComponent('"' + String(id).replace(/"/g, '') + '"'); }).join(',') + ')'; }
  async function sigFetch() {
    SIG.t = null; var q = SIG.q, docs = SIG.docs; SIG.q = {}; SIG.docs = {};
    Object.keys(docs).forEach(function (k) {
      var s = docs[k];
      net.select('docs', { columns: 'key,site,data', order: 'key', filter: 'key=eq.' + encodeURIComponent(s.key) + '&site=eq.' + encodeURIComponent(s.site) })
        .then(function (rows) { if (rows[0]) onChange({ table: 'docs', type: 'UPDATE', row: rows[0] }); }, function () { resyncSoon(); });
    });
    await Promise.all(Object.keys(q).map(async function (t) {
      var ids = Object.keys(q[t]);
      for (var i = 0; i < ids.length; i += 80) {
        var part = ids.slice(i, i + 80), got = {};
        try {
          (await net.select(t, { columns: 'id,data', filter: idList(part) })).forEach(function (r) { got[r.id] = 1; onChange({ table: t, type: 'UPDATE', row: r }); });
          var rest = part.filter(function (id) { return !got[id]; });
          if (rest.length && pubFor(S.role || '').indexOf(t) >= 0)                // someone else's row, as its public copy
            (await net.select(t + '_pub', { columns: 'id,data', filter: idList(rest) })).forEach(function (r) { got[r.id] = 1; onChange({ table: t + '_pub', type: 'UPDATE', row: r }); });
          part.forEach(function (id) { if (!got[id]) dropRow(t, id); });
        } catch (e) { resyncSoon(); }
      }
    }));
  }
  function dropRow(t, id) {                                                // deleted, or no longer mine to see
    id = String(id); var arr = DBx().d[t]; if (!arr) return;
    if (S.snap[t] && S.snap[t][id] !== undefined) onChange({ table: t, type: 'DELETE', old: { id: id } });
    if (S.pub[t] && S.pub[t][id]) { var x = find(arr, id); if (x) arr.splice(arr.indexOf(x), 1); delete S.pub[t][id]; DBx().ver++; refresh(); }
  }
  function resyncSoon() { clearTimeout(SIG.rs); SIG.rs = setTimeout(function () { lastSync = 0; resync(); }, 8000 + Math.random() * 8000); }
  function startLive() { net.subscribe(liveTopics(), onSignal, function (s, info) { S.liveInfo = info || null; if (s === 'error' && root.console) console.warn('[ICG live]', JSON.stringify(info || {}).slice(0, 300)); setStatus(s); if (s === 'live') { resync(); pump(); } }); }
  var lastSync = 0;
  function resync() {                                                      // after a reconnect, catch up on anything missed
    if (Date.now() - lastSync < 5000 || !S.ready) { lastSync = Date.now(); return; }
    lastSync = Date.now();
    if (S.role === 'res') ownerActivity().then(refresh, noop);
    fetchAll().then(function (all) {
      Object.keys(all.pub).forEach(function (t) { mergePub(t, all.pub[t]); });
      TABLES.forEach(function (t) {
        if (!readable(t) || !all.rows[t]) return;
        var seen = {};
        all.rows[t].forEach(function (r) { seen[r.id] = 1; onChange({ table: t, type: 'UPDATE', row: r }); });
        Object.keys(S.snap[t] || {}).forEach(function (id) { if (!seen[id]) onChange({ table: t, type: 'DELETE', old: { id: id } }); });
      });
      (all.docs || []).forEach(function (r) { if (DOC_KEYS.indexOf(r.key) >= 0 && S.docSnap[r.key] && S.docSnap[r.key].site === r.site && S.docSnap[r.key].j !== J(r.data)) onChange({ table: 'docs', type: 'UPDATE', row: r }); });
      DBx().ver++; refresh();
    }).catch(function () {});
  }

  /* ---------------- hooks: when to look for local changes ---------------- */
  function hook() {
    var schedule = function () { clearTimeout(S.st); S.st = setTimeout(scan, 60); };
    ['click', 'change', 'input', 'keyup', 'submit', 'touchend'].forEach(function (ev) { root.addEventListener && root.addEventListener(ev, schedule, true); });
    var D = DBx(), lastVer = D.ver;
    setInterval(function () { if (D.ver !== lastVer) { lastVer = D.ver; scan(); } }, 700);
    // an app left in the background lets go of its live connection after a minute (the server holds one per open phone;
    // notifications still arrive as push messages) and takes it back, with everything missed, when it is opened again
    root.addEventListener && root.addEventListener('visibilitychange', function () {
      if (root.document.hidden) { scan(); saveNow(); clearTimeout(S.bgT); S.bgT = setTimeout(function () { if (root.document.hidden && net.live && !net.live.closed) { net.live.close(); S.liveAway = true; } }, 60000); return; }
      clearTimeout(S.bgT);
      if (S.ready) { root.ICG_TODAY = cairo().ymd; DBx().TODAY = root.ICG_TODAY; if (S.liveAway) { S.liveAway = false; startLive(); } else resync(); pump(); }
    });
    root.addEventListener && root.addEventListener('pagehide', function () { scan(); saveNow(); });
    var lastWin = gateWindow();
    setInterval(function () {
      if (!S.ready) return;
      if (gateWindow() !== lastWin) { lastWin = gateWindow(); refresh(); }                   // the resident's QR changes every 15 minutes
      if (!S.gateAt || Date.now() - S.gateAt > 6 * 3600000) gateRefresh();
    }, 20000);
    root.addEventListener && root.addEventListener('online', function () { setStatus('reconnecting'); pump(); });
    root.addEventListener && root.addEventListener('offline', function () { setStatus('offline'); });
  }

  /* ---------------- sign-in / out (called by the shell) ---------------- */
  /* opening the app: who am I, my rows, my listing's activity, my gate codes and my counters in ONE request
     (public.app_open; the phone does not know its role yet, so it sends the time windows of each role that reads in one go).
     An older server without it: null, and the app asks the old way. */
  var SEQ_KEYS = ['N', 'A', 'P', 'I', 'G', 'X'];
  async function openAll() {
    var since = {}; Object.keys(BUNDLE).forEach(function (r) { since[r] = sinceMap(r); });
    var keys = SEQ_KEYS.filter(function (k) { var b = S.blocks[k]; return !b || b.end - b.next < 5; });
    try { var op = await net.rpc('app_open', { p_since: since, p_keys: keys, p_n: 20 }); return op && typeof op === 'object' && 'me' in op ? op : null; }
    catch (e) { if (!e.status || e.status >= 500 || e.status === 401) throw e; return null; }
  }
  async function afterAuth() {
    var op = await openAll();
    var me = op ? op.me : await net.rpc('whoami');
    if (!me) return { state: 'noaccount' };
    if (me.status !== 'active') return { state: me.status, me: me };
    if (me.mfa === true) return { state: 'mfa', me: me };                     // management: the 6-digit code comes first
    var cached = await IDB.get('cache').catch(function () { return null; });
    S.role = me.role; S.me = me;                                          // (who I am narrows what is asked for)
    await load(op);
    if (op && op.seq) SEQ_KEYS.forEach(function (k) { if (op.seq[k] != null) S.blocks[k] = { next: +op.seq[k], end: +op.seq[k] + 20, queue: [] }; });
    await prefetch(SEQ_KEYS);                                             // (asks only for what is still missing)
    S.ready = true; S.me = me; DBx().d.anonMine = anonOf(me);
    if (cached && cached.queue && cached.queue.length && net.session && net.session.user && cached.uid === net.session.user.id) { replay(cached.queue); DBx().ver++; scan(); }
    DBx().login(me.id);
    startLive();
    emit('ready', me);
    if (op && (op.gate || op.gateKeys)) { if (op.gate) S.gate = op.gate; if (op.gateKeys) S.gateKeys = op.gateKeys; S.gateAt = Date.now(); saveNow(); refresh(); }
    else { saveNow(); gateRefresh(); }
    return { state: 'active', me: DBx().get('accounts', me.id) || me };
  }
  var API = {
    live: true, net: net, state: S,
    on: function (f) { S.listeners.push(f); },
    // a resident opens someone's published listing (one view), or likes an offer on his own listing
    seen: function (id) { return net.rpc('listing_seen', { p_id: String(id) }).catch(noop); },
    likeLead: function (id) { return net.rpc('lead_like', { p_id: String(id) }).then(function () { return ownerActivity(); }).then(refresh); },
    resume: async function () {
      if (!net.session) return null;
      try { return await afterAuth(); }
      catch (e) {
        if (e.status === 401 || e.status === 400) { await net.signOut(); await IDB.del('cache').catch(noop); return null; }
        return await fromCache();                                          // no connection: open from the copy on the phone
      }
    },
    signIn: async function (id, pw) { await net.signIn(id, pw); return afterAuth(); },
    sendCode: function (phone) { return net.sendCode(phone); },
    verifyCode: async function (phone, code) { await net.verifyCode(phone, code); return afterAuth(); },
    signupLookup: function () { return net.rpc('signup_lookup'); },
    // resident self sign-up through the server function (no session yet); then sign in to follow the review
    selfSignup: function (p) { return net.fn('signup', p); },
    whoami: function () { return net.rpc('whoami'); },
    // the resident corrects his sign-up: new photos go to his own folder first, then the server checks and saves
    selfFix: async function (p) {
      var uid = net.session && net.session.user && net.session.user.id; if (!uid) throw Object.assign(new Error('not signed in'), { status: 401 });
      var docs = [], q = Object.assign({}, p);
      for (var i = 0; i < (p.docs || []).length; i++) {
        var d = p.docs[i]; if (!d || !d.data) continue;
        var path = uid + '/' + d.k + '-' + Date.now().toString(36) + '.jpg';
        await net.upload('account-docs', path, dataBlob(d.data)); docs.push({ k: d.k, path: path });
      }
      delete q.docs; if (docs.length) q.docs = docs;
      return net.rpc('signup_fix', { p: q });
    },
    // a private photo for the screen (sign-up documents, line-up photos): '' until its one-hour link arrives (then the screen redraws)
    docUrl: function (path, bucket) {
      if (!path) return '';
      var b = bucket || 'account-docs', key = b + ':' + path, c = S.docUrls[key], now = Date.now();
      if (c && (c.busy || now - c.at < (c.url ? 50 : 1) * 60000)) return c.url || '';
      S.docUrls[key] = { busy: true, url: c && c.url, at: now };
      net.signedUrl(b, path, 3600).then(function (u) { S.docUrls[key] = { url: u || '', at: Date.now() }; DBx().ver++; refresh(); },
        function () { S.docUrls[key] = { url: '', at: Date.now() }; });
      return (c && c.url) || '';
    },
    // a photo attached to a record (payment proof, request or complaint photo, violation evidence…): the private store
    // «uploads/<site>/<subject>/<day>-<random>.jpg» — subject = the resident it concerns (he can see it) or 'staff'
    upload: async function (dataUrl, site, subject) {
      var path = String(site || (S.me && S.me.site) || 'all') + '/' + String(subject || 'staff').replace(/[^A-Za-z0-9_-]/g, '') + '/' + root.ICG_TODAY + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.jpg';
      await net.upload('uploads', path, dataBlob(dataUrl));
      return path;
    },
    // the supervisor's line-up photo goes to the private bucket under his site's folder; the roll call keeps only its path
    rollPhoto: async function (dataUrl, site, shift) {
      var path = site + '/' + root.ICG_TODAY + '-' + shift + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.jpg';
      await net.upload('rollcall-photos', path, dataBlob(dataUrl));
      return path;
    },
    signupRequest: function (acc) { return net.rpc('signup_request', { p: acc }); },
    setPassword: function (pw) { return net.setPassword(pw); },
    mfaFactors: function () { return net.mfaFactors(); },
    /* the second sign-in step: the code from an authenticator app (management). First time: a new factor to add to the app
       (QR + key); later: the one already set up. → { mode: 'verify' | 'enroll', id, secret?, uri? } */
    mfaStart: async function () {
      var all = await net.mfaAll(), ok = all.filter(function (f) { return f.status === 'verified' && f.factor_type === 'totp'; })[0];
      if (ok) return { mode: 'verify', id: ok.id };
      for (var i = 0; i < all.length; i++) if (all[i].status !== 'verified') await net.mfaDelete(all[i].id).catch(noop);   // an unfinished set-up
      var f = await net.mfaEnroll('ICG ' + new Date().toISOString().slice(0, 16));
      return { mode: 'enroll', id: f.id, secret: f.totp && f.totp.secret, uri: f.totp && f.totp.uri };
    },
    mfaConfirm: async function (fid, code) { await net.mfaVerify(fid, code); return afterAuth(); },
    // logins managed from the app (server function «staff»): a temporary password, or reset someone's two-step verification
    staff: async function (action, id) { await Promise.race([API.flush().catch(noop), new Promise(function (r) { setTimeout(r, 15000); })]); return net.fnAuth('staff', { action: action, id: id }); },
    mfaEnroll: function () { return net.mfaEnroll('ICG'); },
    mfaVerify: function (fid, code) { return net.mfaVerify(fid, code); },
    aal: function () { return net.claims().aal; },
    signOut: async function () {
      if (root.ICG_PUSH_TOKEN) await net.rpc('unregister_device', { p_token: root.ICG_PUSH_TOKEN }).catch(function () {});   // this phone stops getting the account's notifications
      S.ready = false; clearTimeout(S.svT); await IDB.del('cache').catch(noop); await net.signOut(); setStatus('off');
    },
    gateQr: gateQr, gateVerify: gateVerify, gateRefresh: gateRefresh, passQr: passQr, passVerify: passVerify,
    pending: function () { return S.queue.length + (S.inflight ? 1 : 0); },
    flush: function () { scan(); return new Promise(function (r) { (function w() { if (!S.queue.length && !S.pushing) r(); else setTimeout(w, 50); })(); }); },
    scan: scan
  };
  root.ICG_SYNC = API;
  // the data layer is created by the same bundle before the apps; install the clock and hooks as soon as it exists
  (function wait() { if (DBx() && DBx().d) { installClock(); hook(); } else setTimeout(wait, 20); })();
})(typeof window !== 'undefined' ? window : globalThis);
