/* ICG template renderer — the shipped app's own way of drawing its screens (written for this project; React and ReactDOM,
   MIT, do the drawing). It reads the page's template (<script type="text/x-icg-tpl"> … </script>, as make_site.py writes it,
   or <x-dc> … </x-dc>) and the app's logic (<script type="text/x-dc">:
   class Component extends DCLogic { renderVals() { … } }) and, on every change, turns the template into React elements
   with the values renderVals() returns.

   Template language (everything the ICG templates use):
     {{a.b.c}}                 a value by path (also true / false / null / numbers); inside text → <span class="sc-interp">
     attr="… {{x}} …"          an attribute built from text and values; a lone {{x}} keeps its type (functions, numbers…)
     onClick="{{f}}" …         events (React names); class → className; style="…" applied as the element's cssText
     <sc-if value="{{x}}">     its content only when x is truthy
     <sc-for list="{{xs}}" as="x">  its content once per item (x in scope; $index too)
     <helmet> … </helmet>      moved into <head> once (fonts, styles)
   Logic: DCLogic gives this.props, this.state, setState(patch | fn, cb) (the state is updated at once, then the screen is
   drawn), forceUpdate(), componentDidMount / componentDidUpdate / componentWillUnmount, renderVals(). */
(function () {
  'use strict';
  var R = window.React, RD = window.ReactDOM;
  if (!R || !RD) { console.error('[icg-render] React is not loaded'); return; }
  var h = R.createElement, Frag = R.Fragment;

  /* ---------------- reading the template (case kept as written: onClick, viewBox, linearGradient) ---------------- */
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var RAW = { script: 1, style: 1 };
  var decoder = null;
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    if (!decoder) decoder = document.createElement('textarea');
    decoder.innerHTML = s; return decoder.value;
  }
  function parse(src) {
    var root = { tag: '#root', attrs: [], kids: [] }, stack = [root], i = 0, n = src.length, top = function () { return stack[stack.length - 1]; };
    var ATTR = /\s*([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) lt = n;
      if (lt > i) top().kids.push({ text: decode(src.slice(i, lt)) });
      if (lt >= n) break;
      i = lt;
      if (src.startsWith('<!--', i)) { var ce = src.indexOf('-->', i + 4); i = ce < 0 ? n : ce + 3; continue; }
      if (src[i + 1] === '/') {                                            // a closing tag
        var gt = src.indexOf('>', i), name = src.slice(i + 2, gt).trim().toLowerCase();
        for (var k = stack.length - 1; k > 0; k--) if (stack[k].tag.toLowerCase() === name) { stack.length = k; break; }
        i = gt + 1; continue;
      }
      if (src[i + 1] === '!' || src[i + 1] === '?') { i = src.indexOf('>', i) + 1 || n; continue; }   // <!doctype …>
      var m = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(src.slice(i, i + 64));
      if (!m) { top().kids.push({ text: '<' }); i++; continue; }
      var el = { tag: m[1], attrs: [], kids: [] }; i += m[0].length;
      for (;;) {
        ATTR.lastIndex = i; var a = ATTR.exec(src);
        if (!a || a.index !== i) break;
        el.attrs.push([a[1], decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : '')]); i = ATTR.lastIndex;
      }
      while (i < n && /\s/.test(src[i])) i++;
      var selfClose = src[i] === '/'; if (selfClose) i++;
      if (src[i] === '>') i++;
      top().kids.push(el);
      var lower = el.tag.toLowerCase();
      if (RAW[lower]) { var endRaw = src.toLowerCase().indexOf('</' + lower, i); if (endRaw < 0) endRaw = n; el.kids.push({ text: src.slice(i, endRaw) }); i = src.indexOf('>', endRaw) + 1 || n; continue; }
      if (!selfClose && !VOID[lower]) stack.push(el);
    }
    return root;
  }

  /* ---------------- values ---------------- */
  var NUM = /^-?\d+(\.\d+)?$/, IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  function compileExpr(e) {
    e = String(e).trim();
    if (e === 'true') return function () { return true; };
    if (e === 'false') return function () { return false; };
    if (e === 'null') return function () { return null; };
    if (e === 'undefined' || !e) return function () { return undefined; };
    if (NUM.test(e)) { var num = Number(e); return function () { return num; }; }
    if (e.length >= 2 && (e[0] === '"' || e[0] === "'") && e[e.length - 1] === e[0]) { var lit = e.slice(1, -1); return function () { return lit; }; }
    if (e[0] === '!') { var inner = compileExpr(e.slice(1)); return function (sc) { return !inner(sc); }; }
    var eq = /^(.+?)\s*(===|!==|==|!=)\s*(.+)$/.exec(e);
    if (eq) { var l = compileExpr(eq[1]), r = compileExpr(eq[3]), op = eq[2];
      return function (sc) { var a = l(sc), b = r(sc); return op === '===' ? a === b : op === '!==' ? a !== b : op === '==' ? a == b : a != b; }; }  // eslint-disable-line eqeqeq
    var path = e.split('.');
    if (!path.every(function (p) { return IDENT.test(p) || /^\d+$/.test(p); })) return function () { return undefined; };
    return function (sc) { var o = sc; for (var j = 0; j < path.length; j++) { if (o == null) return undefined; o = o[path[j]]; } return o; };
  }
  var MUSTACHE = /\{\{([\s\S]+?)\}\}/g;
  function compileValue(text) {                                     // an attribute: a lone {{x}} keeps the value's type
    var whole = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(text);
    if (whole) return compileExpr(whole[1]);
    if (text.indexOf('{{') < 0) return function () { return text; };
    var parts = text.split(MUSTACHE).map(function (p, k) { return k & 1 ? compileExpr(p) : p; });
    return function (sc) { var out = ''; for (var k = 0; k < parts.length; k++) { if (k & 1) { var v = parts[k](sc); out += v == null ? '' : v; } else out += parts[k]; } return out; };
  }

  /* ---------------- inline styles: the element's cssText (kept exactly as written; no !important) ---------------- */
  var styleRefs = new Map();
  function styleRef(css) {
    var f = styleRefs.get(css); if (f) return f;
    f = function (el) {
      if (!el || el.__icgCss === css) return; el.__icgCss = css;
      if (css === null && !el.hasAttribute('style')) return;   // no style at all (an unset value): no style="" on a new element
      var st = el.style; st.cssText = css || '';
      for (var j = st.length; j-- > 0;) { var p = st[j]; if (st.getPropertyPriority(p)) { var v = st.getPropertyValue(p); st.removeProperty(p); st.setProperty(p, v); } }
    };
    if (styleRefs.size > 4000) styleRefs.clear();
    styleRefs.set(css, f); return f;
  }

  /* ---------------- template → render functions ---------------- */
  var EVENTS = { onclick: 'onClick', onchange: 'onChange', oninput: 'onInput', onsubmit: 'onSubmit', onkeydown: 'onKeyDown', onkeyup: 'onKeyUp', onkeypress: 'onKeyPress',
    onmousedown: 'onMouseDown', onmouseup: 'onMouseUp', onmouseenter: 'onMouseEnter', onmouseleave: 'onMouseLeave', onfocus: 'onFocus', onblur: 'onBlur', ondoubleclick: 'onDoubleClick', oncontextmenu: 'onContextMenu' };
  var BOOL = { allowfullscreen: 1, async: 1, autofocus: 1, autoplay: 1, checked: 1, controls: 1, default: 1, defer: 1, disabled: 1, hidden: 1, loop: 1, multiple: 1, muted: 1, novalidate: 1, open: 1, playsinline: 1, readonly: 1, required: 1, reversed: 1, selected: 1 };
  var uid = 0;
  function compileKids(node) { return node.kids.map(compileNode).filter(Boolean); }
  function compileNode(node) {
    if (node.text != null) {
      var txt = node.text;
      if (txt.indexOf('{{') < 0) { if (!txt.trim() && txt.indexOf(' ') < 0) return null; return function () { return txt; }; }
      var parts = txt.split(MUSTACHE).map(function (p, k) { return k & 1 ? compileExpr(p) : p; }), id = 't' + (uid++);
      return function (sc) {
        var out = [];
        for (var k = 0; k < parts.length; k++) {
          if (!(k & 1)) { if (parts[k]) out.push(parts[k]); continue; }
          var v = parts[k](sc);
          if (v == null || typeof v === 'boolean') continue;
          if (R.isValidElement(v) || Array.isArray(v)) { out.push(h(Frag, { key: k }, v)); continue; }
          out.push(h('span', { key: k, className: 'sc-interp' }, String(v)));
        }
        return h(Frag, { key: id }, out);
      };
    }
    var tag = node.tag, low = tag.toLowerCase(), key = 'e' + (uid++), attr = {};
    node.attrs.forEach(function (a) { attr[a[0]] = a[1]; });
    if (low === 'sc-if') {
      var cond = compileValue(attr.value || ''), kidsIf = compileKids(node);
      return function (sc) { return cond(sc) ? h(Frag, { key: key }, kidsIf.map(function (f) { return f(sc); })) : null; };
    }
    if (low === 'sc-for') {
      var list = compileValue(attr.list || ''), as = attr.as || 'item', kidsFor = compileKids(node);
      return function (sc) {
        var xs = list(sc); if (!Array.isArray(xs)) xs = [];
        return h(Frag, { key: key }, xs.map(function (x, ix) { var s2 = Object.create(sc); s2[as] = x; s2.$index = ix; return h(Frag, { key: ix }, kidsFor.map(function (f) { return f(s2); })); }));
      };
    }
    if (low === 'helmet') return null;                                // moved into <head> at start-up
    var props = [], css = null, hasValue = false, hasChecked = false;
    node.attrs.forEach(function (a) {
      var name = a[0], val = a[1], ln = name.toLowerCase();
      if (/^hint-/.test(ln) || ln === 'sc-name') return;
      if (ln === 'style') { css = compileValue(val); return; }
      if (ln === 'class') name = 'className';
      else if (ln === 'for') name = 'htmlFor';
      else if (ln.indexOf('on') === 0 && ln.length > 2) name = EVENTS[ln] || name;
      else if (ln === 'checked' && low === 'input' && val.indexOf('{{') < 0) { props.push(['defaultChecked', function () { return true; }]); return; }
      else if (val === '' && BOOL[ln]) { props.push([name, function () { return true; }]); return; }
      if (name === 'value') hasValue = true; if (name === 'checked') hasChecked = true;
      props.push([name, compileValue(val)]);
    });
    var kids = compileKids(node);
    return function (sc) {
      var p = { key: key };
      for (var k = 0; k < props.length; k++) p[props[k][0]] = props[k][1](sc);
      if (hasValue && p.value === undefined) p.value = '';
      if (hasChecked && p.checked === undefined) p.checked = false;
      if (css) { var cv = css(sc); p.ref = styleRef(cv == null ? null : String(cv)); }
      return kids.length ? h.apply(null, [tag, p].concat(kids.map(function (f) { return f(sc); }))) : h(tag, p);
    };
  }

  /* ---------------- the app's logic ---------------- */
  function DCLogic(props) { this.props = props || {}; this.state = {}; this.__host = null; }
  DCLogic.prototype.setState = function (u, cb) { if (this.__host) this.__host.__setLogicState(u, cb); else { var v = typeof u === 'function' ? u(this.state) : u; this.state = Object.assign({}, this.state, v); } };
  DCLogic.prototype.forceUpdate = function () { if (this.__host) this.__host.forceUpdate(); };
  DCLogic.prototype.componentDidMount = function () {};
  DCLogic.prototype.componentDidUpdate = function () {};
  DCLogic.prototype.componentWillUnmount = function () {};
  DCLogic.prototype.renderVals = function () { return {}; };

  function start() {
    // the template as written: <script type="text/x-icg-tpl"> (raw text, never parsed by the browser); <x-dc> as a fallback
    var tEl = document.querySelector('script[type="text/x-icg-tpl"]'), x = tEl || document.querySelector('x-dc'), sEl = document.querySelector('script[data-dc-script]');
    if (!x || !sEl) { console.error('[icg-render] no template or logic on the page'); return; }
    var src = tEl ? tEl.textContent : x.innerHTML, js = sEl.textContent || '', props = {};
    try { var dp = JSON.parse(sEl.getAttribute('data-props') || '{}'); Object.keys(dp || {}).forEach(function (k) { if (k[0] !== '$') props[k] = dp[k]; }); } catch (e) {}
    var tree = parse(src);
    (function lift(node) {                                             // <helmet>: fonts and styles go to <head> once
      node.kids.forEach(function (k) {
        if (k.tag && k.tag.toLowerCase() === 'helmet') k.kids.forEach(function (c) {
          if (!c.tag) return; var el = document.createElement(c.tag);
          c.attrs.forEach(function (a) { el.setAttribute(a[0], a[1]); });
          if (c.kids[0] && c.kids[0].text != null) el.textContent = c.kids[0].text;
          document.head.appendChild(el);
        });
        else if (k.kids) lift(k);
      });
    })(tree);
    var tpl = compileKids(tree);
    var rootEl = document.getElementById('dc-root');
    if (!rootEl) {                                         // where the template stood; a template read in <head> → top of <body>
      rootEl = document.createElement('div'); rootEl.id = 'dc-root';
      if (document.body && document.body.contains(x)) x.parentNode.insertBefore(rootEl, x);
      else (document.body || document.documentElement.appendChild(document.createElement('body'))).prepend(rootEl);
    }
    x.remove(); sEl.remove();
    var base = document.createElement('style'); base.textContent = '.sc-host.sc-has-error{position:relative}@media print{#dc-root,#dc-root>.sc-host{height:auto}}'; document.head.prepend(base);
    var Logic = new Function('DCLogic', 'StreamableLogic', 'React', js + '\n;return (typeof Component!=="undefined"&&Component)||undefined;')(DCLogic, DCLogic, R) || DCLogic;
    var name = 'Root';                                    // the page's own (top-level) component, as the old runtime named it

    function Host(p) {
      R.Component.call(this, p);
      this.state = { v: 0, err: null };
      this.logic = new Logic(props); this.logic.__host = this;
    }
    Host.prototype = Object.create(R.Component.prototype); Host.prototype.constructor = Host;
    Host.prototype.__setLogicState = function (u, cb) {
      var cur = this.logic.state, v = typeof u === 'function' ? u(cur) : u;
      this.logic.state = Object.assign({}, cur, v);
      this.setState(function (s) { return { v: s.v + 1 }; }, cb);
    };
    Host.prototype.componentDidMount = function () { try { this.logic.componentDidMount(); } catch (e) { console.error(e); } };
    Host.prototype.componentDidUpdate = function (prev) { try { this.logic.componentDidUpdate(prev); } catch (e) { console.error(e); } };
    Host.prototype.componentWillUnmount = function () { try { this.logic.componentWillUnmount(); } catch (e) { console.error(e); } };
    Host.prototype.render = function () {
      var vals, err = null;
      try { vals = Object.assign({}, props, this.logic.renderVals() || {}); } catch (e) { console.error(e); err = String(e && e.message || e); vals = props; }
      return h('div', { className: 'sc-host' + (err ? ' sc-has-error' : ''), 'data-sc-name': name },
        err ? h('div', { className: 'sc-logic-error', role: 'alert', style: { padding: '12px', color: '#B42318', font: '13px system-ui' } }, name + ': ' + err) : null,
        tpl.map(function (f) { return f(vals); }));
    };
    RD.createRoot(rootEl).render(h(Host));
  }
  window.ICG_RENDER = { parse: parse, compileValue: compileValue, version: '1' };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
