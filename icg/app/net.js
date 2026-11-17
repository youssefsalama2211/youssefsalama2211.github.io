/* ICG network client — a small, dependency-free client for the platform's Supabase backend.
   auth  : phone OTP, phone/login + password, refresh, sign-out, password change, TOTP two-step (MFA)
   rest  : select (paged) · insert · update · delete · rpc     (row level security applies on the server)
   live  : short change signals on private broadcast topics over one WebSocket, re-authorised whenever the session refreshes
   Works in browsers, the mobile apps and Node 22 (global fetch + WebSocket). No secrets: only the public anon key. */
(function (root) {
  'use strict';
  function ICGNet(opts) {
    if (!(this instanceof ICGNet)) return new ICGNet(opts);
    this.url = String(opts.url || '').replace(/\/+$/, '');
    this.key = opts.anonKey;
    this.store = opts.storage || memStore();
    this.storeKey = opts.storageKey || 'icg.session';
    this.session = readJSON(this.store, this.storeKey);
    this.onAuth = [];
    this.fetch = opts.fetch || root.fetch.bind(root);
    this.WS = opts.WebSocket || root.WebSocket;
    this.live = null;
    this._refreshing = null;
  }
  function isJWT(k) { return typeof k === 'string' && k.split('.').length === 3; }
  function memStore() { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; }
  function readJSON(s, k) { try { var v = s.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function NetError(status, body) {
    var msg = body && (body.msg || body.message || body.error_description || body.error) || ('HTTP ' + status);
    var e = new Error(msg); e.status = status; e.code = body && (body.code || body.error_code) || null; e.body = body; return e;
  }
  var P = ICGNet.prototype;

  /* ---------------- http ---------------- */
  P._req = async function (method, path, body, o) {
    o = o || {};
    if (!o.noAuth && this.session && this._expiring()) await this.refresh().catch(function () {});
    var h = { apikey: this.key, 'Content-Type': 'application/json' };
    var tok = !o.noAuth && this.session ? this.session.access_token : (o.bearer || (isJWT(this.key) ? this.key : null));
    if (tok) h.Authorization = 'Bearer ' + tok;                          // new-style publishable keys are not JWTs: apikey header only
    for (var k in (o.headers || {})) h[k] = o.headers[k];
    var r = await this.fetch(this.url + path, { method: method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    var txt = await r.text(), data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (r.status === 401 && !o.noAuth && !o.retried && this.session) {     // token expired between the check and the call
      await this.refresh();
      return this._req(method, path, body, Object.assign({}, o, { retried: true }));
    }
    if (!r.ok) throw NetError(r.status, data);
    return { data: data, headers: r.headers, status: r.status };
  };
  P._expiring = function () { var s = this.session; return s && s.expires_at && (s.expires_at * 1000 - Date.now() < 60000); };
  P._setSession = function (s) {
    if (s && s.access_token && !s.expires_at) s.expires_at = Math.floor(Date.now() / 1000) + (s.expires_in || 3600);
    this.session = s && s.access_token ? s : null;
    try { if (this.session) this.store.setItem(this.storeKey, JSON.stringify(this.session)); else this.store.removeItem(this.storeKey); } catch (e) {}
    if (this.live) this.live.setToken(this.session ? this.session.access_token : null);
    var self = this; this.onAuth.forEach(function (f) { try { f(self.session); } catch (e) {} });
    return this.session;
  };

  /* ---------------- auth ---------------- */
  P.sendCode = function (phone) { return this._req('POST', '/auth/v1/otp', { phone: phone }, { noAuth: true }).then(function () { return true; }); };
  P.verifyCode = async function (phone, code) { var r = await this._req('POST', '/auth/v1/verify', { type: 'sms', phone: phone, token: String(code) }, { noAuth: true }); return this._setSession(r.data); };
  // Everyone signs in with a password on an internal e-mail identity, so password sign-in works without an SMS provider:
  // residents type their phone (→ p<last 10 digits>@res.icg), staff their login ID (→ <id>@staff.icg). SMS codes are used
  // separately to verify a phone at sign-up and to reset a forgotten password.
  P.signIn = async function (idOrPhone, password) {
    var id = String(idOrPhone || '').trim(), body = { email: /^[+0-9\s-]+$/.test(id) ? ICGNet.phoneEmail(id) : ICGNet.loginEmail(id), password: password };
    var r = await this._req('POST', '/auth/v1/token?grant_type=password', body, { noAuth: true });
    return this._setSession(r.data);
  };
  P.refresh = function () {
    var self = this;
    if (!this.session || !this.session.refresh_token) return Promise.reject(NetError(401, { msg: 'no session' }));
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._req('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: this.session.refresh_token }, { noAuth: true })
      .then(function (r) { return self._setSession(r.data); }, function (e) { if (e.status === 400 || e.status === 401) self._setSession(null); throw e; })
      .finally(function () { self._refreshing = null; });
    return this._refreshing;
  };
  P.signOut = async function () { try { if (this.session) await this._req('POST', '/auth/v1/logout?scope=local'); } catch (e) {} if (this.live) this.live.close(); this._setSession(null); };
  P.user = function () { return this._req('GET', '/auth/v1/user').then(function (r) { return r.data; }); };
  P.setPassword = function (pw) { return this._req('PUT', '/auth/v1/user', { password: pw }).then(function (r) { return r.data; }); };
  P.claims = function () { try { var b = this.session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(b)))); } catch (e) { return {}; } };
  // two-step verification (authenticator app, TOTP)
  P.mfaEnroll = function (name) { return this._req('POST', '/auth/v1/factors', { factor_type: 'totp', friendly_name: name || 'ICG' }).then(function (r) { return r.data; }); };
  P.mfaVerify = async function (factorId, code) {
    var ch = await this._req('POST', '/auth/v1/factors/' + factorId + '/challenge', {});
    var r = await this._req('POST', '/auth/v1/factors/' + factorId + '/verify', { challenge_id: ch.data.id, code: String(code) });
    return this._setSession(Object.assign({}, this.session, r.data));
  };
  P.mfaFactors = function () { return this.user().then(function (u) { return (u.factors || []).filter(function (f) { return f.status === 'verified'; }); }); };
  P.mfaAll = function () { return this.user().then(function (u) { return u.factors || []; }); };
  P.mfaDelete = function (factorId) { return this._req('DELETE', '/auth/v1/factors/' + factorId); };
  // a server function called as the signed-in person (the function checks who it is)
  P.fnAuth = function (name, body) { return this._req('POST', '/functions/v1/' + name, body).then(function (r) { return r.data; }); };
  ICGNet.phoneEmail = function (phone) { return 'p' + String(phone).replace(/[^0-9]/g, '').slice(-10) + '@res.icg'; };
  ICGNet.loginEmail = function (login) { return String(login).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') + '@staff.icg'; };

  /* ---------------- rest ---------------- */
  P.select = async function (table, o) {
    o = o || {}; var page = o.page || 1000, out = [], from = 0;
    var q = '/rest/v1/' + encodeURIComponent(table) + '?select=' + (o.columns || 'id,data,version') + (o.filter ? '&' + o.filter : '') + '&order=' + (o.order || 'id');
    for (;;) {
      var r = await this._req('GET', q, null, { headers: { Range: from + '-' + (from + page - 1), 'Range-Unit': 'items' } });
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < page) break;
      from += page;
    }
    return out;
  };
  // o.minimal: don't ask for the row back (needed when the writer may not read it, e.g. a notification addressed to the guards)
  P.insert = function (table, row, o) { var min = o && o.minimal; return this._req('POST', '/rest/v1/' + encodeURIComponent(table), row, { headers: { Prefer: min ? 'return=minimal' : 'return=representation' } }).then(function (r) { return min ? null : r.data && r.data[0]; }); };
  P.update = function (table, id, patch) { return this._req('PATCH', '/rest/v1/' + encodeURIComponent(table) + '?id=eq.' + encodeURIComponent(id), patch, { headers: { Prefer: 'return=representation' } }).then(function (r) { return r.data && r.data[0]; }); };
  // a shared document (settings, the full strength of each shift, …): one row per key and site
  P.updateDoc = function (key, site, data) { return this._req('PATCH', '/rest/v1/docs?key=eq.' + encodeURIComponent(key) + '&site=eq.' + encodeURIComponent(site || 'all'), { data: data }, { headers: { Prefer: 'return=representation' } }).then(function (r) { return r.data && r.data[0]; }); };
  P.insertDoc = function (key, site, data) { return this._req('POST', '/rest/v1/docs', { key: key, site: site || 'all', data: data }, { headers: { Prefer: 'return=minimal' } }).then(function () { return true; }); };
  P.remove = function (table, id) { return this._req('DELETE', '/rest/v1/' + encodeURIComponent(table) + '?id=eq.' + encodeURIComponent(id), null, { headers: { Prefer: 'return=representation' } }).then(function (r) { return r.data && r.data[0]; }); };
  P.rpc = function (fn, args) { return this._req('POST', '/rest/v1/rpc/' + fn, args || {}).then(function (r) { return r.data; }); };
  // public server functions (e.g. the resident sign-up) run without a session: the public key only
  P.fn = function (name, body) { return this._req('POST', '/functions/v1/' + name, body, { noAuth: true }).then(function (r) { return r.data; }); };

  /* ---------------- storage (private buckets: row level security on the server) ---------------- */
  P.upload = async function (bucket, path, blob) {
    if (this.session && this._expiring()) await this.refresh().catch(function () {});
    var h = { apikey: this.key, 'Content-Type': (blob && blob.type) || 'image/jpeg' };
    if (this.session) h.Authorization = 'Bearer ' + this.session.access_token;
    var r = await this.fetch(this.url + '/storage/v1/object/' + bucket + '/' + path, { method: 'POST', headers: h, body: blob });
    var txt = await r.text(), data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!r.ok) throw NetError(r.status, data);
    return path;
  };
  // a link to one private file that works for an hour (the server checks that I may see it)
  P.signedUrl = function (bucket, path, secs) {
    var self = this;
    return this._req('POST', '/storage/v1/object/sign/' + bucket + '/' + path, { expiresIn: secs || 3600 }).then(function (r) {
      var u = r.data && (r.data.signedURL || r.data.signedUrl); if (!u) return null;
      return /^https?:/.test(u) ? u : self.url + '/storage/v1' + (u.charAt(0) === '/' ? u : '/' + u);
    });
  };

  /* ---------------- realtime ---------------- */
  // subscribe(topics, onSignal) → { close }   One WebSocket; each topic is a private broadcast channel the server checks
  // when the phone joins (u:<me>, <role>:<site>, <role>:*). A signal says only what changed: onSignal({ t, id, op }) or, for
  // a shared document, { t: 'docs', key, site } — the app then fetches the rows itself (row level security applies).
  P.subscribe = function (topics, onSignal, onStatus) {
    if (this.live) this.live.close();
    this.live = new Live(this, topics, onSignal, onStatus || function () {});
    return this.live;
  };
  function Live(net, topics, onSignal, onStatus) {
    this.net = net; this.topics = topics; this.onSignal = onSignal; this.onStatus = onStatus;
    this.ref = 0; this.joins = {}; this.joined = {}; this.closed = false; this.tries = 0; this.open();
  }
  Live.prototype.send = function (event, payload, topic, joinRef) {
    if (!this.ws || this.ws.readyState !== 1) return;
    var ref = String(++this.ref);
    this.ws.send(JSON.stringify({ topic: topic, event: event, payload: payload || {}, ref: ref, join_ref: joinRef || null }));
    return ref;
  };
  Live.prototype.open = function () {
    var self = this, net = this.net;
    if (this.closed || !net.session) return;
    var u = net.url.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(net.key) + '&vsn=1.0.0';
    var ws = this.ws = new net.WS(u);
    self.joins = {}; self.joined = {};
    ws.onopen = function () {
      self.tries = 0;
      self.topics.forEach(function (t) {
        var jr = String(++self.ref); self.joins[jr] = t;
        ws.send(JSON.stringify({ topic: 'realtime:' + t, event: 'phx_join', ref: jr, join_ref: jr, payload: {
          config: { broadcast: { ack: false, self: false }, presence: { key: '', enabled: false }, postgres_changes: [], private: true },
          access_token: net.session && net.session.access_token } }));
      });
      self.hb = setInterval(function () { self.send('heartbeat', {}, 'phoenix'); }, 25000);
    };
    ws.onmessage = function (m) {
      var msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch (e) { return; }
      if (msg.event === 'phx_reply' && self.joins[msg.ref]) {
        var t = self.joins[msg.ref]; delete self.joins[msg.ref];
        if (msg.payload && msg.payload.status === 'ok') {
          self.joined[t] = msg.ref;
          if (Object.keys(self.joined).length === self.topics.length) self.onStatus('live');
        } else self.onStatus('error', Object.assign({ topic: t }, msg.payload || {}));
      } else if (msg.event === 'broadcast') {
        var p = msg.payload || {}, s = p.payload && typeof p.payload === 'object' ? p.payload : p;
        if (s && s.t) { try { self.onSignal(s, String(msg.topic || '').replace(/^realtime:/, '')); } catch (e) { if (root.console) console.error('[ICG live]', e); } }
      } else if (msg.event === 'system' && msg.payload && msg.payload.status === 'error') {
        self.onStatus('error', msg.payload);
      } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        self.onStatus('reconnecting'); try { ws.close(); } catch (e) {}
      }
    };
    ws.onclose = function () {
      clearInterval(self.hb); if (self.closed) return;
      self.onStatus('reconnecting');
      // many phones losing the server at once must not all come back in the same second
      var wait = Math.min(30000, 1000 * Math.pow(2, self.tries++)) * (0.5 + Math.random());
      setTimeout(function () { self.open(); }, wait);
    };
    ws.onerror = function () {};
  };
  Live.prototype.setToken = function (tok) {
    if (!tok) { this.close(); return; }
    var self = this;
    Object.keys(this.joined).forEach(function (t) { self.send('access_token', { access_token: tok }, 'realtime:' + t, self.joined[t]); });
  };
  Live.prototype.close = function () { this.closed = true; clearInterval(this.hb); try { this.ws && this.ws.close(); } catch (e) {} };

  ICGNet.NetError = NetError;
  if (typeof module !== 'undefined' && module.exports) module.exports = ICGNet; else root.ICGNet = ICGNet;
})(typeof globalThis !== 'undefined' ? globalThis : this);
