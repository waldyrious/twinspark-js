/* jshint -W030, -W084, esversion: 6 */

(function(window, document, tsname) {
  var location = window.location;
  var script = document.currentScript;

  /// Config

  function cget(name, def) { return script && script.dataset[name] || def; }
  function iget(name, def) { return parseInt(cget(name, def), 10); }

  var xhrTimeout    = iget('timeout', 3000);
  var historyLimit  = iget('history', 20);
  var attrsToSettle = cget('attrs-to-settle',
                           'class,style,width,height').split(',');
  var settleDelay   = iget('settle-delay', 20);
  var insertClass   = cget('insert-class', 'ts-insert');
  var removeClass   = cget('remove-class', 'ts-remove');

  /// Internal variables

  // Indicates if `init` has happened
  var READY = false;

  /** @typedef {{selector: string, handler: (function(!Element): void)}} */
  var Directive;

  /** @type {Array<Directive>} */
  var DIRECTIVES = [];

  /** @const {!Object<string, Function>} */
  var FUNCS = {
    stop:        function(o) { if (o.event) o.event.stopPropagation(); },
    prevent:     function(o) { if (o.event) o.event.preventDefault(); },
    delay:       delay,

    not: function(funcname) {
      var args = [].slice.call(arguments, 1, arguments.length - 1);
      var o = merge({}, arguments[arguments.length - 1]);
      o.src = o.src.slice(o.command.length + 1);

      var rv = executeCommand(funcname, args, o);

      // this means previous command does not return truthy/falsy value, we
      // ignore that
      if (rv === null || rv === undefined) {
        return rv;
      }
      return !rv;
    },

    target: function(sel, o) {
      var el = findTarget(o.el, sel);
      if (!el) return false; // stop executing actions pipeline
      o.el = el;
    },

    remove: arity({
      1: function(o) { o.el.remove(); },
      2: function(sel, o) { findTarget(o.el, sel).remove(); }
    }),

    wait: function(eventname, o) {
      return new Promise(function(resolve) {
        o.el.addEventListener(eventname, resolve, {once: true});
      });
    },

    class:       function(cls, o) { o.el.classList.add(cls); },
    "class+":    function(cls, o) { o.el.classList.add(cls); },
    "class-":    function(cls, o) { o.el.classList.remove(cls); },
    "class^":    function(cls, o) { o.el.classList.toggle(cls); },
    classtoggle: function(cls, o) { o.el.classList.toggle(cls); },

    text: arity({
      1: function(o) {
        o.el.innerText = o.input;
        return o.input;
      },
      2: function(value, o) {
        o.el.innerText = value;
        return value;
      }
    }),

    html: arity({
      1: function(o) {
        o.el.innerHTML = o.input;
        return o.input;
      },
      2: function(value, o) {
        o.el.innerHTML = value;
        return value;
      }
    }),

    attr: arity({
      2: function(name, o) { return o.el[name]; },
      3: function(name, value, o) {
        o.el[name] = value;
        return value;
      }
    }),

    log: function() {
      var args = parseArgs(arguments);
      if (args.o.input) {
        args.rest.push(args.o.input);
      }
      console.log.apply(console, args.rest);
    }
  };


  /// Utils

  var ERR = console.error ?
      console.error.bind(console, 'TwinSpark error:') :
      console.log.bind(console, 'TwinSpark error:');

  /** @type{function(Object): Function} */
  function arity(funcs) {
    return function() {
      var len = arguments.length;
      var func = funcs[len];
      if (!func) {
        throw extraerr("No function supplied accepting " + len + " arguments", {
          "functions": funcs,
          "arguments": Array.from(arguments)
        });
      }
      return func.apply(this, arguments);
    }
  }

  /** @type{function(!Object, (Object|null|undefined)): !Object} */
  var merge = Object.assign || function(tgt, src) {
    if (!src) {
      return tgt;
    }

    for (var k in src) {
      if (src.hasOwnProperty(k)) {
        tgt[k] = src[k];
      }
    }
    return tgt;
  };

  function groupBy(arr, keyfn) {
    return arr.reduce(function (acc, v) {
      var key = keyfn(v);
      (acc[key] || (acc[key] = [])).push(v);
      return acc;
    }, {});
  }

  function toObj(entries) {
    var x, r = {};
    while (x = entries.next().value) {
      r[x[0]] = x[1];
    }
    return r;
  }

  /** @type {function(Array, Function): Array} */
  function mapcat(arr, cb) {
    var res = [];
    for (var i = 0; i < arr.length; i++) {
      res.push.apply(res, cb(arr[i], i));
    }
    return res;
  }

  function zip(arr1, arr2) {
    return arr1.map((val, i) => [val, arr2[i]]);
  }

  /** @type {function(Array): Array} */
  function distinct(arr) {
    var seen = new Set(),
        res = [],
        val;
    for (var i = 0; i < arr.length; i++) {
      val = arr[i];
      if (!seen.has(val)) {
        seen.add(val);
        res.push(val);
      }
    }
    return res;
  }

  function el2str(el) {
    return el.outerHTML.match(/<.+?>/)[0];
  }

  function extraerr(msg, data) {
    var err = Error(msg);
    err.extra = data;
    return err;
  }

  function memoize(orig) {
    var cache = null;
    return function() {
      return cache || (cache = orig());
    };
  }

  /** @type {function(string): (number|undefined)} */
  function parseTime(s) {
    s = s && s.trim();
    if (!s)
      return;
    if (s.match(/\d+s/))
      return parseFloat(s) * 1000;
    return parseFloat(s);
  }

  function delay(s) {
    return new Promise(function(resolve) {
      setTimeout(resolve, parseTime(s), true);
    });
  }

  /** @type {function(Arguments): {rest: Array<*>, o: {el: Element, e: Event}}} */
  function parseArgs(args) {
    var i = args.length;
    return {rest: [].slice.call(args, 0, i - 1),
            o:    args[i - 1]};
  }


  /// Events
  /** @type {function(Function): void} */
  function onload(fn) {
    if (document.readyState == 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  var onidle = window.requestIdleCallback || function(x) { setTimeout(x, 100); };

  /** @type {function((Element|Node|Window), string, Object=, Object=): !Event} */
  function sendEvent(el, type, detail, opts) {
    // true if not supplied
    var bubbles = opts && opts.hasOwnProperty('bubbles') ? opts.bubbles : true;
    var event = new CustomEvent(type, {bubbles: bubbles,
                                       cancelable: true,
                                       detail: detail});
    console.debug('🛎️ EVENT', type, {el: el, detail: detail});
    el.dispatchEvent(event);
    return event;
  }
  function sendError(el, type, detail) {
    sendEvent(el, type, merge({error: type}, detail));
  }


  /// Attribute handling
  /** @type {function(!Element, !string): boolean} */
  function hasattr(el, attr) {
    return el.hasAttribute(attr);
  }

  /** @type {function(!Element, !string): string} */
  function getattr(el, attr) {
    return el.getAttribute(attr);
  }

  /** @type {function(!Element, !string, string): void} */
  function setattr(el, attr, value) {
    return el.setAttribute(attr, value);
  }

  /** @type {function(!Element, !string): void} */
  function delattr(el, attr) {
    return el.removeAttribute(attr);
  }


  /// DOM querying
  /** @type {function(!Node, !string): Element} */
  function qsf(el, selector) { // querySelectorFirst
    if (el.nodeType == 1 && el.matches(selector))
      return /** @type {!Element} */ (el);
    return el.querySelector ? el.querySelector(selector) : null;
  }

  /** @type {function(!Node, !string): !Array<!Element>} */
  function qse(el, selector) { // querySelectorEvery
    if (!el.querySelectorAll)
      return [];
    var els = Array.from(el.querySelectorAll(selector));
    if (el.nodeType == 1 && el.matches(selector))
      els.unshift(el);
    return els;
  }

  function elid(el) {
    if (el.id)
      return el.id;
    var tag = el.tagName.toLowerCase();
    if (el.className)
      return tag + '.' + el.className.replace(' ', '.');
    return tag;
  }

  /**
   * Collects all non-empty attribute values from element and its parents.
   * @type {function(!Element, string): Array<string>} */
  function elcrumbs(el, attr) {
    var result = [];
    var value;
    var _el = el; // this is to make Closure Compiler typing happy :(

    do {
      value = getattr(_el, attr);
      if (value) {
        result.push(value);
      }
    } while (_el = _el.parentElement);

    return result;
  }


  /// Core

  /**
   * @type {function(!Element, !Directive): void}
   * @suppress {checkTypes}
   */
  function attach(el, directive) {
    qse(el, directive.selector).forEach(directive.handler);
  }

  /**
   * Registers new directive.
   * @param  {string} selector Directive selector.
   * @param  {function(!Element): void} handler Directive callback.
   * @return void
   */
  function register(selector, handler) {
    var directive = {selector: selector, handler: handler};
    DIRECTIVES.push(directive);
    if (READY) {
      attach(document.body, directive);
    }
  }

  /** @type {function(!Element): void} */
  function activate(el) {
    DIRECTIVES.forEach(d => attach(el, d));
    sendEvent(el, 'ts-ready');
  }

  /** @type {function(!Element): void} */
  function autofocus(el) {
    var toFocus = qsf(el, '[autofocus]');
    if (toFocus) {
      toFocus.focus();
    }
  }


  /// Ajax

  /** @typedef {{
   *    ok: boolean,
   *    status: number,
   *    url: string,
   *    error: string
   * }}
   */
  var ResponseTimeout;

  /** @typedef {{
   *    ok: boolean,
   *    status: number,
   *    url: string,
   *    reqUrl: string,
   *    xhr: XMLHttpRequest,
   *    opts: RequestInit,
   *    headers: Object,
   *    content: string,
   * }}
   */
  var Response;

  /** @typedef {{response: Response, tasks: Array<Function>}} */
  var SwapData;

  /** @type {function(string, RequestInit): {promise: Promise<Response|ResponseTimeout>, xhr: XMLHttpRequest} } */
  function xhr(url, opts) {
    var xhr = new XMLHttpRequest();
    return {
      promise: new Promise(function(resolve, reject) {
        opts || (opts = {});

        xhr.open(opts.method || 'GET', url, true);
        for (var k in opts.headers) {
          xhr.setRequestHeader(k, opts.headers[k]);
        }

        xhr.onreadystatechange = function() {
          if (xhr.readyState != 4) return;
          if (xhr.status == 0) return; // timeout

          var headers = {'ts-title':     xhr.getResponseHeader('ts-title'),
                         'ts-history':   xhr.getResponseHeader('ts-history'),
                         'ts-swap':      xhr.getResponseHeader('ts-swap'),
                         'ts-swap-push': xhr.getResponseHeader('ts-swap-push')};

        return resolve({ok:      xhr.status >= 200 && xhr.status <= 299,
                        status:  xhr.status,
                        url:     xhr.responseURL,
                        reqUrl:  url,
                        xhr:     xhr,
                        opts:    opts,
                        headers: headers,
                        content: xhr.responseText});

        };

        xhr.timeout = xhrTimeout;
        xhr.ontimeout = function() {
          return reject({ok:     false,
                         status: 0,
                         url:    url,
                         error:  "timeout"});
        };

        var body = /** @type {(ArrayBuffer|ArrayBufferView|Blob|Document|FormData|null|string|undefined)} */ (opts.body);
        xhr.send(body);
      }),
      xhr: xhr
    };
  }


  /// Data collection

  /**
   * Merge two sets of parameters into one
   * @param {FormData|URLSearchParams} p1 Collection of parameters to be updated.
   * @param {FormData|URLSearchParams|Iterable} p2 Collection of parameters to be merged in.
   * @param {boolean=} removeEmpty Indicate if empty ('' or null) parameters from p2 should be removed.
   * @return FormData|URLSearchParams
   */
  function mergeParams(p1, p2, removeEmpty) {
    if (!p2) return p1;

    // iterator loop here since p2 could be either an array or an
    // FormData instance
    for (var [k, v] of p2) {
      if (!k) continue;

      if (removeEmpty && ((v === null) || (v === ''))) {
        p1.delete(k);
      } else {
        p1.append(k, v);
      }
    }
    return p1;
  }

  /**
   * Parse either query string or JSON object.
   * @param {string} v String to be parsed.
   * @return FormData|Array<Array<string,*>>|null
   */
  function parseData(v) {
    if (v == "") return null;

    if (v[0] == '{') {
      var data = JSON.parse(v);
      if (typeof data === 'object' && data !== null) {
        var arr = [];
        for (var k in data) {
          arr.push([k, data[k]]);
        }
        return arr;
      }
    } else {
      return mergeParams(new FormData(), new URLSearchParams(v));
    }
  }

  /**
   * @type {function(!Element, string): FormData}
   * @suppress {reportUnknownTypes}
   */
  function eldata(el, attr) {
    // reduceRight because deepest element is the first one
    return elcrumbs(el, attr).reduceRight(
      (acc, v) => mergeParams(acc, parseData(v), true),
      new FormData());
  }

  /** @type {function(Element): string?} */
  function formElementValue(el) {
    if (!el.name)
      return null;

    // only clicked submit buttons should be handled. In ideal world we would
    // look at e.submitter, but no support from Safari
    if (el.type == 'submit' && !hasattr(el, 'ts-clicked'))
      return null;

    if (((el.type == 'radio') || (el.type == 'checkbox')) &&
        !el.checked) {
      return null;
    }

    return el.value;
  }

  /** @type {function(!Element, Event): !FormData} */
  function collectData(el, e) {
    var data = eldata(el, 'ts-data');
    var tag = el.tagName;
    var res;

    if (tag == 'FORM') {
      data = mergeParams(data, new FormData(el));

      var focused = document.activeElement;
      if (focused.type == 'submit' && focused.name && focused.value && !data.has(focused.name)) {
        data.append(focused.name, focused.value);
      } else if (e?.type == 'submit') {
        var submit = qsf(el, '[type=submit]');
        if (submit.name && submit.value && !data.has(submit.name)) {
          data.append(submit.name, submit.value);
        }
      }
    } else if ((tag == 'INPUT') || (tag == 'SELECT') || (tag == 'TEXTAREA')) {
      if (res = formElementValue(el))
        data.append(el.name, /** @type {string} */ (res));
    }

    return data;
  }

  /// IndexedDB

  var IDB = window.indexedDB ||
      window.mozIndexedDB ||
      window.webkitIndexedDB ||
      window.msIndexedDB;
  var _idb;

  function reqpromise(req) {
    return new Promise(function(resolve, reject) {
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  }

  function idb() {
    if (_idb)
      return _idb;

    var dbname = 'twinspark';
    var req = IDB.open(dbname, 1);
    req.onupgradeneeded = function() {
      var db = req.result;
      var store = db.createObjectStore(dbname, {keyPath: 'url'});
      store.createIndex('time', 'time');
    };

    _idb = reqpromise(req);
    return _idb;
  }

  /** @type {function(Object, Object=): Object} */
  function idbStore(db, opts) {
    var rw = opts && opts.write;
    return db.transaction(db.name, rw && 'readwrite' || 'readonly')
      .objectStore(db.name);
  }

  /// History

  function deleteOverLimit(db) {
    reqpromise(idbStore(db).count()).then(function(count) {
      console.debug('STORED', count);
      var toremove = count - historyLimit;
      if (toremove > 0) {
        var req = idbStore(db, {write: true})
            .index('time')
            .openCursor();
        // This API is like an abyss looking at me. `onsuccess` will be called
        // every time you call `cursor.continue()`.
        req.onsuccess = function(_) {
          var cursor = req.result;
          if (cursor) {
            cursor.delete();
            if (--toremove > 0) {
              cursor.continue();
            }
          }
        };
      }
    });
  }

  function storeCurrentState() {
    var data = {url:  location.pathname + location.search,
                html: document.body.innerHTML,
                time: +new Date()};
    idb().then(function(db) {
      reqpromise(idbStore(db, {write: true})
                 .put(data))
        .then(function() {
          deleteOverLimit(db);
        });
    });
  }

  function pushState(url, title) {
    // Store HTML before "changing page", `swap` is going to change HTML after
    // that
    storeCurrentState();
    history.pushState("history", title, url);
    sendEvent(window, 'ts-pushstate', {url: url});
  }

  function replaceState(url) {
    history.replaceState(null, '', url);
    sendEvent(window, 'ts-replacestate', {detail: url});
  }

  function onpopstate(e) {
    // hashchange triggers onpopstate and there is nothing we can do about it
    // https://stackoverflow.com/questions/25634422/stop-firing-popstate-on-hashchange
    if (!e.state)
      return;

    var url = location.pathname + location.search;
    idb().then(function(db) {
      return reqpromise(
        db.transaction(db.name, 'readonly')
          .objectStore(db.name)
          .get(url));
    }).then(function(data) {
      console.debug('onpopstate restore', data.url, data.html.length, data.time);
      if (data && data.html) {
        document.body.innerHTML = data.html;

        // If user came back from a real page change, we indicate this with an
        // `initial` property. There is a race between IndexedDB loading HTML
        // and DOMContentLoaded, so in case when first happened and second did
        // not, `READY` is false and thus `activate` will be run later on inside
        // `init`. Skip this not to activate everything twice.
        if (e.state == "initial" && !READY) {
          return;
        }

        activate(document.body);
      }
    });
  }


  /// Fragments

  /** @type {function(Element, string, boolean): (Element|undefined)} */
  function _findSingleTarget(el, sel, childrenOnly) {
    if (!sel || !el) {
      return el;
    }

    if (sel == 'target') {
      return el;
    }

    if (sel == 'inherit') {
      var parent = el.parentElement.closest('[ts-target]');
      return findTarget(parent);
    }

    if (sel.slice(0, 7) == 'parent ') {
      return el.closest(sel.slice(7));
    }

    if (sel.slice(0, 6) == 'child ') {
      return el.querySelector(sel.slice(6));
    }

    if (sel.slice(0, 8) == 'sibling ') {
      return el.parentElement.querySelector(sel.slice(8));
    }

    if (childrenOnly) {
      return el.querySelector(sel);
    }

    return document.querySelector(sel);
  }

  /** @type {function(!Element, !string, !boolean): !Element} */
  function findSingleTarget(el, sel, childrenOnly) {
    var res = _findSingleTarget(el, sel, childrenOnly);
    if (res)
      return res;

    var elstr = el2str(el);
    throw extraerr(`Could not find element with selector ${sel} for element ${elstr}` +
                   (childrenOnly ? ' among children' : ''), {
      element: elstr,
      selector: sel
    });
  }

  /** @type {function(Element, string=): Element} */
  function findTarget(el, sel) {
    if (!el) return el;

    if (sel == null) {
      sel = getattr(el, 'ts-target');
    }
    if (!sel) { // undefined, ""
      return el;
    }

    var bits = sel.split('|').map(s => s.trim());
    // when selector is not the first we are not going to escape to global
    // search from document root, it's always one of modifiers (see
    // `_findSingleTarget`), in the least it will look for a child
    return bits.reduce((el, sel, idx) => findSingleTarget(el, sel, idx > 0), el);
  }

  /** @type {function(!Element, !Element, !Element): (Element|DocumentFragment)} */
  function findReply(target, origin, reply) {
    var sel = getattr(origin, 'ts-req-selector');

    if (!sel) {
      if ((reply.tagName == 'BODY') && (target.tagName != 'BODY')) {
        return reply.children[0];
      }
      return reply;
    }

    if (sel.slice(0, 9) == 'children ') {
      var el = qsf(reply, sel.slice(9));
      var frag = new DocumentFragment();
      if (el && el.children) {
        frag.append.apply(frag, el.children);
      }
      return frag;
    }

    return qsf(reply, sel);
  }


  /** @type {function(!Element, !Element): void} */
  function cloneAttrs(from, to) {
    for (var i = 0; i < attrsToSettle.length; i++) {
      var attr = attrsToSettle[i];
      if (hasattr(from, attr) && (getattr(from, attr) != getattr(to, attr))) {
        to.setAttribute(attr, from.getAttribute(attr));
      } else {
        to.removeAttribute(attr);
      }
    }
  }

  /** @type {function(!Element): void} */
  function elementInserted(el) {
    el.classList.add(insertClass);
    setTimeout(() => el.classList.remove(insertClass));
  }

  // if there is a node with same id in an old code and in a new code,
  // temporarily set it attrs to what old code had (and then restore to new
  // values)
  function transitionAttrs(el, origin, ctx) {
    if (!el.id) return;

    var oldEl = origin.querySelector(el.tagName + "[id='" + el.id + "']");

    if (!oldEl) {
      return elementInserted(el);
    }

    var newAttrs = el.cloneNode();
    cloneAttrs(oldEl, el);
    ctx.tasks.push(function() {
      cloneAttrs(newAttrs, oldEl);
    });
    return ctx;
  }


  /// MORPH, thanks to idiomorph and nanomorph
  /// Core algorithm from https://github.com/bigskysoftware/idiomorph
  var morph = (function() {
    /** @type {function(!Node, !Object): void} */
    function cleanRemove(el, ctx) {
      // callback before anything else to have a chance to do something
      ctx.cb('node-remove', el);

      if (el.nodeType != 1) {
        el.remove();
        return;
      }
      el.classList.add(removeClass);

      // another approach would be to use `transitionrun`/`transitionend`
      // events, but basic performance testing did not show a noticeable
      // difference
      var animations = el.getAnimations()
          .filter(a => a instanceof window.CSSTransition);
      if (!animations.length) {
        return el.remove();
      }

      Promise.all(animations.map(a => a.finished))
        .then(() => {
          el.remove();
        });
    }

    /** @type {function(!Node, !Object): void} */
    function cleanInsert(el, ctx) {
      // callback before anything so that there is a hook to change something
      ctx.cb('node-insert', el);
      if (el instanceof HTMLElement) {
        activate(el);
        elementInserted(el);
      }
    }

    function syncattr(from, to, attr) {
      var value = getattr(to, attr);
      if (value != getattr(from, attr)) {
        value ? setattr(from, attr, value) : delattr(from, attr);
      }
    }

    /** @type {function(!Node, !Node): void} */
    function syncAttrs(from, to) {
      if (from.nodeType != 1) {
        // text, comments
        from.nodeValue = to.nodeValue;
        return;
      }

      for (var attr of /** @type Element */ (to).attributes) {
        syncattr(from, to, attr.name);
      }
      for (var attr of /** @type Element */ (from).attributes) {
        syncattr(from, to, attr.name);
      }

      // sync inputs
      if (from.tagName == 'INPUT' && from.type != 'file') {
        // https://github.com/choojs/nanomorph/blob/master/lib/morph.js#L113
        // The "value" attribute is special for the <input> element since it sets
        // the initial value. Changing the "value" attribute without changing the
        // "value" property will have no effect since it is only used to the set
        // the initial value. Similar for the "checked" attribute, and "disabled".
        from.value = to.value || '';
        syncattr(from, to, 'value');
        syncattr(from, to, 'checked');
        syncattr(from, to, 'disabled');
      } else if (from.tagName == 'OPTION') {
        syncattr(from, to, 'selected');
      } else if (from.tagName == 'TEXTAREA') {
        syncattr(from, to, 'value');
        // NOTE what is this stuff, is it necessary? Can't find a test case, but
        // nanomorph is doing that.
        if (from.firstChild && from.firstChild.nodeValue != to.value) {
          from.firstChild.nodeValue = to.value;
        }
      }
    }

    function intersection(setA, setB) {
      const _intersection = new Set();
      for (const elem of setB) {
        if (setA.has(elem)) {
          _intersection.add(elem);
        }
      }
      return _intersection;
    }

    function idIntersection(el1, el2) {
      var ids1 = new Set(qse(el1, '[id]').map(el => el.id));
      var ids2 = new Set(qse(el2, '[id]').map(el => el.id));
      return intersection(ids1, ids2);
    }

    function isSimilar(node1, node2) {
      return (node1 &&
              node2 &&
              node1.nodeType == node2.nodeType &&
              node1.tagName == node2.tagName);
    }

    /** @type {function(!Node, !Node): Element} */
    function findIdsMatch(target, reply) {
      if (reply.nodeType != 1)
        return null;

      var el = /** @type {!Element} */ (reply);
      var replyIds = qse(el, '[id]').map(el => '#' + el.id).join(',');
      if (!replyIds)
        return null;

      el = /** @type {!Element} */ (target);
      do {
        // check if any element having id like those coming in `reply`
        if (qsf(el, replyIds)) {
          return el;
        }
      } while (el = el.nextElementSibling);
      return null;
    }

    /** @type {function(!Node, !Node, Set<string>): Node} */
    function findSoftMatch(target, reply, incomingIds) {
      var el = target;
      var nextReply = reply.nextSibling;
      var potentialMatches = 0;

      do {
        var ids = qse(el, '[id]').map(el => el.id);
        // there are potential id matches, bail out of soft matching
        if (ids.length && intersection(incomingIds, ids).size) {
          return null;
        }

        // check similarities only if there is no ids inside of compared
        // elements, in other case we want a clean removal to start animations
        if (!ids.length && !qse(reply, '[id]').length && isSimilar(el, reply)) {
          return el;
        }

        if (isSimilar(el, nextReply)) {
          potentialMatches++;
          nextReply = nextReply.nextSibling;

          // If there are two future soft matches, bail to allow the siblings to
          // soft match so that we don't consume future soft matches for the sake
          // of the current node
          if (potentialMatches >= 2) {
            return null;
          }
        }
      } while (el = el.nextSibling);
      return null;
    }

    function removeNodesBetween(start, end, ctx) {
      while (start !== end) {
        var todelete = start;
        start = start.nextSibling;
        cleanRemove(todelete, ctx);
      }
      return end;
    }

    /** @type {function(!Node, Node, !Object): Node} */
    function morphNode(from, to, ctx) {
      if (ctx.ignoreActive &&
          from == document.activeElement &&
          (from.tagName == 'INPUT' || from.tagName == 'TEXTAREA')) {
        // skip focused element, if it's input
        return from;
      } else if (!to) {
        cleanRemove(from, ctx);
        return null;
      } else if (!isSimilar(from, to)) {
        if (!from.parentElement) {
          from.replaceWith(to);
        } else {
          from.parentElement.insertBefore(to, from.nextSibling);
          cleanRemove(from, ctx);
          cleanInsert(to, ctx);
        }
        return to;
      } else {
        syncAttrs(from, to);
        if (from.nodeType == 1 && to.nodeType == 1) {
          morphChildren(
            /** @type !Element */ (from),
            /** @type !Element */ (to),
            ctx);
        }
        return from;
      }
    }

    /** @type {function(!Element, !Element, !Object): void} */
    function morphChildren(from, to, ctx) {
      var target = from.firstChild;
      var nextReply = to.firstChild;

      var incomingIds = new Set(qse(to, '[id]').map(el => el.id));

      while (nextReply) {
        var reply = nextReply;
        nextReply = reply.nextSibling;

        if (!target) {
          from.appendChild(reply);
          cleanInsert(reply, ctx);
          continue;
        }

        var idsMatch = findIdsMatch(target, reply);
        if (idsMatch) {
          target = removeNodesBetween(target, idsMatch, ctx).nextSibling;
          morphNode(idsMatch, reply, ctx);
          continue;
        }

        var softMatch = findSoftMatch(target, reply, incomingIds);
        if (softMatch) {
          target = removeNodesBetween(target, softMatch, ctx).nextSibling;
          morphNode(softMatch, reply, ctx);
          continue;
        }

        // can't morph, just insert it
        from.insertBefore(reply, target);
        cleanInsert(reply, ctx);
      }

      // remove leftovers
      if (target) {
        target = removeNodesBetween(target, from.lastChild, ctx);
        cleanRemove(target, ctx);
      }
    }

    /** @typedef {{cb: (undefined|function(!string, !Node): void)}} */
    var MorphContext;

    /** @type {function(!Node, Node, MorphContext): Node} */
    function morph(target, reply, ctx={}) {
      ctx.cb || (ctx.cb = function () {});
      if (target && target.nodeType == Node.DOCUMENT_NODE)
        target = target.documentElement;
      if (reply && reply.nodeType == Node.DOCUMENT_NODE)
        reply = reply.documentElement;
      return morphNode(target, reply, ctx);
    }

    morph.syncAttrs = syncAttrs;
    return morph;
  })();


  /** @type {function(string, !Element, !(Element|DocumentFragment), !SwapData): !(Element|DocumentFragment)} */
  function executeSwap(strategy, target, reply, ctx) {
    strategy || (strategy = 'replace');

    if (strategy != 'morph') {
      qse(reply, '[id]').forEach(function(el) {
        transitionAttrs(el, target, ctx);
      });
    }

    var mctx = {ignoreActive: strategy == 'morph'}
    switch (strategy) {
    case 'morph-all':
    case 'morph':       morph(target, reply, mctx);                    break;
    case 'replace':     target.replaceWith(reply);                     break;
    case 'inner':       target.replaceChildren(reply);                 break;
    case 'prepend':     target.prepend(reply);                         break;
    case 'append':      target.append(reply);                          break;
    case 'beforebegin': target.parentNode.insertBefore(reply, target); break;
    case 'afterend':    target.parentNode.insertBefore(reply, target.nextSibling); break;
    case 'skip':        break;
    default:            throw Error('Unknown swap strategy ' + strategy);
    }
    return reply;
  }

  /** @type {function(!Element, !Element, !SwapData): (Element|DocumentFragment)} */
  function elementSwap(origin, replyParent, ctx) {
    var target = findTarget(origin);
    if (!target) {
      throw extraerr(`Target element not found for origin ${el2str(origin)}`,
                     {origin, replyParent});
    }

    var reply = findReply(target, origin, replyParent);
    if (!reply) {
      var sel = getattr(origin, 'ts-req-selector');
      throw extraerr(`Cannot find specified html in response, ` +
                     `maybe nothing to select as ${sel}`,
                     {sel, replyParent, origin});
    }

    var strategy = getattr(origin, 'ts-swap');
    if (origin) {
      var detail = {response: ctx.response};
      var e = sendEvent(origin, 'ts-req-after', detail);
      doActions(origin, e, getattr(origin, 'ts-req-after'), detail);
    }

    return executeSwap(strategy, target, reply, ctx);
  }

  /** @type {function(!Element, !SwapData): (Element|DocumentFragment)} */
  function pushedSwap(reply, ctx) {
    var sel = getattr(reply, 'ts-swap-push');
    if (!sel && reply.id) {
      sel = '#' + reply.id;
    }
    var target = qsf(document.body, sel);
    if (!target) {
      throw extraerr('cannot find target for server-pushed swap', {reply});
    }
    var strategy = getattr(reply, 'ts-swap');
    return executeSwap(strategy, target, reply, ctx);
  }

  /** @type {function(!string, !Element, !SwapData): (Element|DocumentFragment)} */
  function headerSwap(header, replyParent, ctx) {
    // `replace: css selector <= css selector`
    var m = header.match(/(\w+):(.+)<=(.+)/);
    if (!m) {
        throw extraerr('Cannot parse ts-swap-push header value', {header});
    }

    var strategy = m[1];
    var target = qsf(document.body, m[2]);
    if (!target)
        throw extraerr('cannot find target for header swap', {sel: m[2]});
    var reply = qsf(replyParent, m[3]);
    if (!reply)
        throw extraerr('cannot find target for header swap', {reply, sel: m[3]});

    return executeSwap(strategy, target, reply, ctx);
  }

  function runScript(el) {
    var parent = el.parentNode;
    var newel = document.createElement(el.nodeName);

    for (var j = 0; j < el.attributes.length; j++) {
      var attr = el.attributes[j].name;
      setattr(newel, attr, getattr(el, attr));
    }

    newel.appendChild(document.createTextNode(el.innerHTML));
    parent.replaceChild(newel, el);
  }

  function processScripts(el) {
    var scripts = el.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var script = scripts[i];
      if ((!script.type || script.type == 'text/javascript') &&
         !script.dataset.tsNoload) {
        runScript(script);
      }
    }
  }

  /** @type {function(Array<Element>, !Element, !Response): Array<Element>} */
  function swap(origins, replyParent, res) {
    var ctx = {response: res, tasks: []};

    var swapped, viapush, viaheader;

    if (res.headers['ts-swap'] != 'skip') {
      if (origins.length == 1) {
        swapped = [elementSwap(/** @type {!Element} */ (origins[0]), replyParent, ctx)];
      } else {
        // batching, we need to collect references to parents before using them
        swapped = zip(origins, replyParent.children).map(([origin, thisParent]) => {
          return elementSwap(origin, thisParent, ctx);
        });
      }
    }

    viapush = qse(replyParent, '[ts-swap-push]').map(reply => {
      try {
        return pushedSwap(reply, ctx);
      } catch(e) {
        console.error(e); // do not interrupt main line
      }
    });

    if (res.headers['ts-swap-push']) {
      // swap any header requests
      viaheader = res.headers['ts-swap-push'].split(',').map(header => {
        try {
          return headerSwap(header, replyParent, ctx)
        } catch(e) {
          console.error(e); // do not interrupt main line
        }
      });
    }

    swapped = swapped.concat(viapush).concat(viaheader).filter(x => x);
    swapped = distinct(swapped);
    swapped.forEach(function(el) {
      processScripts(el);
      activate(el);
      autofocus(el);
    });
    setTimeout(function() {
      ctx.tasks.forEach(function(func) { func(); });
    }, settleDelay);

    return swapped;
  }

  // Terminology:
  // `origin` - an element where request started from, a link or a button
  // `target` - where the incoming HTML will end up
  // `reply` - incoming HTML to end up in target
  /** @type {function(string, Array<!Element>, string, Response): Array<!Element>} */
  function swapResponse(url, origins, content, res) {
    var html = new DOMParser().parseFromString(content, 'text/html');

    // when swapping, browsers treat <style> element inside of <noscript> as
    // something worth looking at. We don't want them to be used, and to be sure
    // let's delete all <noscript> elements.
    html.body.querySelectorAll('noscript').forEach(x => x.remove());

    var title = res.headers['ts-title'] || html.title;
    var replyParent = html.body;

    if (replyParent.children.length < origins.length) {
      throw (`This request needs at least ${origins.length} elements, ` +
             `but ${replyParent.children.length} were returned`);
    }

    // either ts-history contains new URL or ts-req-history attr is present,
    // then take request URL as new URL
    var pushurl = res.headers['ts-history'] || hasattr(origins[0], 'ts-req-history') && url;
    if (pushurl) {
      if (getattr(origins[0], 'ts-req-history') == 'replace') {
        replaceState(pushurl);
      } else {
        pushState(pushurl, title);
      }
    }

    return swap(origins, replyParent, res);
  }


  /// Making request for fragments

  function mergeHeaders(h1, h2) {
    for (var k in h2) {
      if (!h1[k]) {
        h1[k] = h2[k];
      } else if (h1[k] != h2[k]) {
        h1[k] += ', ' + h2[k];
      }
    }
    return h1;
  }

  function makeOpts(req) {
    var data = collectData(req.el, req.event.detail?.event ?? req.event);
    return {
      method:  req.method,
      data:    data,
      headers: {
        'Accept':       'text/html+partial',
        'TS-URL':       location.pathname + location.search,
        'TS-Origin':    elid(req.el),
        'TS-Target':    elid(findTarget(req.el))
      }
    };
  }

  function setReqBody(opts, body) {
    if (!body) {
      return opts;
    }

    var issimple = (Array.from(body.entries)
                    .every((x) => typeof x === "string"));
    if (!issimple) {
      opts.body = body;
      return opts;
    }

    // convert FormData to string so we can evade multipart form
    var simplebody = new URLSearchParams(body);
    opts.body = simplebody.toString();
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return opts;
  }

  function _doReqBatch(batch) {
    if (!batch.length) return;

    var url = batch[0].url;
    var method = batch[0].method;
    var data = batch.reduce(function(acc, req) {
      return mergeParams(acc, req.opts.data);
    }, new FormData());

    var qs = method == 'GET' ? new URLSearchParams(data).toString() : null;
    var body = method != 'GET' ? data : null;

    var opts = {
      method:  method,
      headers: batch.reduce(function(h, req) {
        return mergeHeaders(h, req.opts.headers);
      }, {})
    };

    opts = setReqBody(opts, body);

    var fullurl = url;
    if (qs) {
      fullurl += url.indexOf('?') == -1 ? '?' : '&';
      fullurl += qs;
    }

    var origins = batch.map(function(req) { return req.el; });

    var query = xhr(fullurl, opts);

    origins.forEach(function (el) {
      el.setAttribute('aria-busy', 'true');
      el.classList.add('ts-active');
      el['ts-active-xhr'] = query.xhr;
    });

    return query.promise
      .then(function(res) {

        onidle(() => origins.forEach(el => {
          el.removeAttribute('aria-busy');
          el.classList.remove('ts-active');
          delete el['ts-active-xhr'];
        }));

        if (query.xhr.isAborted) {
          return false;
        }

        // res.url == "" with mock-xhr
        if (res.ok && res.url && (res.url != new URL(fullurl, location.href).href)) {
          res.headers['ts-history'] = res.url;
          return swapResponse(res.url, [document.body], res.content,
                              /** @type {Response} */ (res));
        }

        if (res.ok) {
          // cannot use res.url here since fetchMock will not set it to right
          // value
          return swapResponse(fullurl, origins, res.content,
                              /** @type {Response} */ (res));
        }

        ERR('Something wrong with response', res.content);
        origins.forEach(function(el) {
          sendError(el, 'ts-req-error', {response: res,
                                         url: fullurl,
                                         opts: opts});
        });
      })
      .catch(function(res) {
        onidle(() => origins.forEach(el => {
          el.removeAttribute('aria-busy');
          el.classList.remove('ts-active');
          delete el['ts-active-xhr'];
        }));

        ERR('Error retrieving backend response', fullurl, res.error || res);
        origins.forEach(function(el) {
          sendError(el, 'ts-req-error', {response: res,
                                         url: fullurl,
                                         opts: opts});
        });
      });
  }

  function doReqBatch(batch) {
    return Promise
      .all(batch.map(function(req) {
        req.opts = makeOpts(req);

        var detail = {req: req};
        var e = sendEvent(req.el, 'ts-req-before', detail);
        if (e.defaultPrevented)
          return null;

        var result = req;
        var action = doActions(req.el, e, getattr(req.el, 'ts-req-before'), detail);
        if (action) {
          result = action.then(function(res) {
            // skip making request if event was prevented
            return e.defaultPrevented ? null : req;
          });
        }

        var strategy = getattr(req.el, 'ts-req-strategy') || 'queue';
        var activeXHR = req.el['ts-active-xhr'];
        if (strategy === 'first' && activeXHR) {
          // prevent duplicate request
          return null;
        }

        if (strategy === 'last' && activeXHR) {
          // abort active request to trigger a new one
          activeXHR.abort();
          delete req.el['ts-active-xhr'];
        }

        // default behavior is to `ts-req-strategy='queue'` all XHR requests
        return result;
      }))
      .then(function(res) {
        return res.filter(function(req) { return !!req; });
      })
      .then(_doReqBatch);
  }

  // Batch Request Queue
  /** @typedef {{el: !Element, url: string, method: string, batch: boolean}} */
  var Req;
  /** @type {{reqs: Array<Req>, request: ?number}} */
  var queue = {
    reqs: [],
    request: null
  };

  function executeRequests() {
    var batches = groupBy(queue.reqs, req => req.method + req.url);
    queue = {reqs: [], request: null};

    for (var k in batches) {
      doReqBatch(batches[k]);
    }
  }

  function queueRequest(req) {
    queue.reqs.push(req);
    if (!queue.request) {
      queue.request = setTimeout(executeRequests, 16);
    }
  }

  /** @type {function(!Element, Event, boolean): {el: !Element, event: Event, url: string, method: string, batch: boolean} } */
  function makeReq(el, e, batch) {
    var url = ((batch ? getattr(el, 'ts-req-batch') : getattr(el, 'ts-req')) ||
               (el.tagName == 'FORM' ? getattr(el, 'action') : getattr(el, 'href')));
    var method = (getattr(el, 'ts-req-method') ||
                  (el.tagName == 'FORM' ?
                   (getattr(el, 'method') || 'POST') :
                   'GET')).toUpperCase();

    return {el:     el,
            opts:   {},
            event:  e,
            url:    url,
            method: method,
            batch:  batch};
  }
  // End Batch Request Queue

  function markSubmitter(el) {
    el.addEventListener('click', function(e) {
      // focus here since macos won't focus submit buttons
      e.target.focus();
      // NOTE: DEPRECATED
      setattr(el, 'ts-clicked', '1');
      // form data should be handled synchronously
      onidle(function() { delattr(el, 'ts-clicked'); });
    });
  }

  function onNative(el, func) {
    var tag = el.tagName;
    var event = 'click';
    if (tag == 'FORM')
      event = 'submit';
    else if ((tag == 'INPUT') || (tag == 'SELECT') || (tag == 'TEXTAREA'))
      event = 'change';

    if (tag == 'FORM' && event == 'submit') {
      qse(el, 'button, input[type="submit"]').forEach(markSubmitter);
    }

    return el.addEventListener(event, function(/** @type {!Event} */ e) {
      if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || (e.button || 0) != 0)
        return;

      e.preventDefault();
      e.stopPropagation();
      func(e);
    });
  }

  register('[ts-req]', function(el) {
    function handler(e) {
      doReqBatch([makeReq(el, e, false)]);
    }

    if (hasattr(el, 'ts-trigger')) {
      el.addEventListener('ts-trigger', handler);
    } else {
      onNative(el, handler);
    }
  });


  register('[ts-req-batch]', function(el) {
    function handler(e) {
      queueRequest(makeReq(el, e, true));
    }

    if (hasattr(el, 'ts-trigger')) {
      el.addEventListener('ts-trigger', handler);
    } else {
      onNative(el, handler);
    }
  });


  /// Actions

  /** @typedef {{
   *   src: string,
   *   name: string,
   *   args: Array<string>
   * }}
   */
  var CommandDef;

  /** @typedef {{
   *   src: string,
   *   commands: Array<CommandDef>
   * }}
   */
  var ActionDef;

  /**
   * Either call it with object of name to function, or with a name and a
   * function.
   * @type {function((Object|string), Function=): Object} */
  function registerCommands(cmdsOrName, maybeFunc) {
    if (typeof cmdsOrName == 'object') {
      return merge(FUNCS, cmdsOrName);
    } else if (maybeFunc) {
      FUNCS[cmdsOrName] = maybeFunc;
    }
    return FUNCS;
  }

  function executeCommand(command, args, payload) {
    var cmd = /** @type {Function|undefined|null} */ (
      (window._ts_func && window._ts_func[command]) ||
        FUNCS[command] ||
        window[command]);

    if (!cmd) {
      throw Error('Unknown action command: ' + payload.src);
    }

    return cmd.apply(payload.el, args.concat([payload]));
  }

  /** @type {function(string): Array<ActionDef>}
   *
   *  Parses strings of the form:
   *
   *      cmd1 arg1, cmd2 arg2 'some, \'stuff'; cmd3 arg3
   *
   *  To an array of objects:
   *
   *      [{src: "cmd1 arg1, cmd2 arg",
   *        commands: [{src: "cmd1 arg1", name: "cmd1", args: ["arg1"]},
   *                   {src: "cmd2 arg2 'some, stuff'", name: "cmd2",
   *                    args: ["arg2", "some, 'stuff"]}]},
   *       {src: "cmd3 arg3",
   *        commands: [{src: "cmd3 arg3", name: "cmd3", args: ["arg3"]}]}]
   *
   *  Understands quoting of strings and escaping quotes
   */
  function parseActionSpec(s) {
    var actions = [];
    var action = [];
    var command = [];
    var current = '';
    var command_start = 0, action_start = 0, i = 0;
    var quote = null;

    function parseValue(s) {
      var c = s[0];
      if (c == '"' || c == "'") {
        return s.slice(1, s.length - 1);
      }
      return s;
    }

    function consume() {
      var token = current.trim();
      if (token.length) {
        command.push(parseValue(token));
      }
      current = '';
    }

    function consumeCommand() {
      if (!command.length)
        return;

      action.push({src:   s.slice(command_start, i).trim(),
                   name:  command[0],
                   args:  command.slice(1)});
      command = [];
      command_start = i + 1;
    }

    function consumeAction() {
      if (!action.length)
        return;

      actions.push({src: s.slice(action_start, i).trim(),
                    commands: action});
      action = [];
      action_start = i + 1;
    }

    for (i = 0; i < s.length; i++) {
      var c = s[i];

      if (quote) {
        if (c == '\\') {
          i++;
          current += s[i];
        } else if (c == quote) {
          current += c;
          quote = null;
        } else {
          current += c;
        }
      } else {
        if ((c == "'") || (c == '"')) {
          quote = c;
        } else if (c == " ") {
          consume();
          continue;
        } else if (c == ",") {
          consume();
          consumeCommand();
          continue;
        } else if (c == ";") {
          consume();
          consumeCommand();
          consumeAction();
          continue;
        }

        current += c;
      }
    }

    consume();
    consumeCommand();
    consumeAction();
    return actions;
  }


  /** @type {function(ActionDef, {el: Element, e: Event}): !Promise} */
  function _doAction(action, payload) {
    console.debug('ACTION', action.src, payload);

    // make a copy, since we allow modification of payload in commands
    var opts = merge({line: action.src}, payload);

    return action.commands.reduce(function(p, command) {
      return p.then(function(rv) {
        console.debug(rv !== false ? '🔵' : '🚫', 'COMMAND',
                      command.src, {input: rv, src: action.src});
        // `false` indicates that action should stop
        if (rv === false)
          return rv;
        if (rv !== undefined)
          opts.input = rv;

        opts.command = command.name;
        opts.src = command.src;

        return executeCommand(command.name, command.args, opts);
      }).catch(function(err) {
        throw merge(err, {extra: {
          command: command.src,
          action: action.src,
          element: el2str(opts.el)
        }});
      });
    }, Promise.resolve(null));
  }

  /** @type {function((Element|undefined), Event, string=, Object=): (Promise|undefined)} */
  function doActions(target, e, spec, payload) {
    if (!spec) return;

    console.debug('ACTIONS', {spec: spec, event: e, payload: payload});
    var actions = parseActionSpec(spec);
    // parens indicate type cast rather than type declaration
    var mypayload = /** @type {{el: Element, e: Event}} */ (merge({el: target, event: e}, payload));

    var result;
    for (var i = 0; i < actions.length; i++) {
      var action = actions[i];
      if (action.commands.length) {
        result = _doAction(action, mypayload);
      }
    }

    // Last result is returned
    return result;
  }

  register('[ts-action]', function(el) {
    var handler = function(/** @type {!Event} */ e) {
      if (e.detail && e.detail.event) {
        // real event to trigger this action
        e = e.detail.event;
      }
      doActions(findTarget(el), e, getattr(el, 'ts-action'), null);
    };

    if (hasattr(el, 'ts-trigger')) {
      el.addEventListener('ts-trigger', handler);
    } else if (el.tagName == 'A' || el.tagName == 'BUTTON') {
      onNative(el, handler);
    } else {
      ERR('No trigger for action on element', el);
    }
  });


  /// Triggers

  /** @type {function({on: string, off: string, rootMargin: string, threshold: number}): IntersectionObserver} */
  function makeObserver(opts) {
    var on = opts.on;
    var off = opts.off;
    var threshold = opts.threshold;

    return new IntersectionObserver(function(entries, obs) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];

        // isIntersecting is often `true` in FF even when it shouldn't be
        if (entry.intersectionRatio > threshold) {
          sendEvent(entry.target, on, {entry: entry});
        } else if (entry.intersectionRatio < threshold) {
          sendEvent(entry.target, off, {entry: entry});
        }
      }
    }, opts);
  }

  var visibleObs = memoize(function() {
    return makeObserver({on: 'visible',
                         off: 'invisible',
                         rootMargin: '0px',
                         threshold: 0.01});
  });

  var closebyObs = memoize(function() {
    // triggers style recalculation:
    // https://gist.github.com/paulirish/5d52fb081b3570c81e3a
    var margin = (window.innerHeight / 2 | 0) + 'px';
    return makeObserver({on: 'closeby',
                         off: 'away',
                         rootMargin: margin,
                         threshold: 0.01});
  });

  var removedObs = memoize(function() {
    return new MutationObserver(function(recs) {
      for (var i = 0; i < recs.length; i++) {
        var rec = recs[i];
        for (var j = 0; j < rec.removedNodes.length; j++) {
          var node = rec.removedNodes[j];
          sendEvent(node, 'remove', {record: rec});
        }
      }
    });
  });

  var childrenObs = memoize(function() {
    return new MutationObserver(function(recs) {
      for (var i = 0; i < recs.length; i++) {
        var rec = recs[i];
        if (rec.type == 'childList') {
          var emptyEvent = rec.target.childNodes.count ? 'notempty' : 'empty';
          sendEvent(rec.target, emptyEvent, {record: rec});
          sendEvent(rec.target, 'childrenChange', {record: rec});
        }
      }
    });
  });

  /** @type {function(!(Node|Window)): {once: (boolean|undefined), delay: (number|undefined)}} */
  function internalData(el) {
    var prop = 'twinspark-internal';
    return el[prop] || (el[prop] = {});
  }

  /** @type {function(CommandDef): (function(!Element, (Event|{type: string})): undefined)}*/
  function makeTriggerListener(t) {
    var delay = t.args.indexOf('delay');
    /** @type {{changed: boolean, once: boolean, delay: (number|null|undefined)}} */
    var spec = {changed: t.args.indexOf('changed') != -1,
                once:    t.args.indexOf('once') != -1,
                delay:   delay != -1 ? parseTime(t.args[delay + 1]) : null};
    return function(el, e) {
      var data = internalData(el);

      function executeTrigger() {
        // trigger should not bubble, it should be local to a node
        sendEvent(el, 'ts-trigger', {event: e}, {bubbles: false});
      }

      if (spec.once) {
        // removeMe(); // how do we do this in common case?
        if (data.once) {
          // NOTE: this just skips execution, no real listener removal happens
          return;
        }
        // this ideally triggers removal of event listener in
        // `addRemovableListener`
        data.once = true;
      }

      if (spec.changed) {
        if (data.value == formElementValue(el)) {
          return;
        }
        data.value = formElementValue(el);
      }

      if (spec.delay) {
        if (data.delay) {
          clearTimeout(data.delay);
        }
        data.delay = setTimeout(executeTrigger, spec.delay);
      } else {
        executeTrigger();
      }
    };
  }

  /** @type {function(!(Node|Window), !string, !Function, !AddEventListenerOptions=): void} */
  function addRemovableListener(el, type, handler, opts) {
    function inner(e) {
      handler(e);

      var data = internalData(el);
      // see makeTriggerListener for details
      if (data.once) {
        el.removeEventListener(type, inner, opts);
      }
    }
    el.addEventListener(type, inner, opts);
  }

  /** @type {function(!Element, CommandDef): undefined} */
  function registerTrigger(el, t) {
    var type = t.name;
    var tsTrigger = makeTriggerListener(t);

    switch (type) {
    case 'load':         onidle(function() { tsTrigger(el, {type: 'load'}); });
      break;
    case 'windowScroll': addRemovableListener(window, 'scroll', function(e) { tsTrigger(el, e); }, {passive: true});
      break;
    case 'scroll':       addRemovableListener(el, 'scroll', function(e) { tsTrigger(el, e); }, {passive: true});
      break;
    case 'outside':      addRemovableListener(document, 'click', function(e) {
      if (!el.contains(e.target)) {
        tsTrigger(el, e);
      }
    }, {capture: true});
      break;

    case 'remove':
      removedObs().observe(el.parentElement, {childList: true});
      el.addEventListener(type, function(e) { tsTrigger(el, e); });
      break;

    case 'empty':
    case 'notempty':
    case 'childrenChange':
      childrenObs().observe(el, {childList: true});
      el.addEventListener(type, function(e) { tsTrigger(el, e); });
      break;

    case 'visible':
    case 'invisible':
      visibleObs().observe(el);
      el.addEventListener(type, function(e) { tsTrigger(el, e); });
      break;

    case 'closeby':
    case 'away':
      closebyObs().observe(el);
      el.addEventListener(type, function(e) { tsTrigger(el, e); });
      break;

    default:             addRemovableListener(el, type, function(e) { tsTrigger(el, e); });
    }
  }

  register('[ts-trigger]', function(el) {
    var spec = getattr(el, 'ts-trigger');
    if (!spec) return;

    var triggers = parseActionSpec(spec)[0];

    triggers.commands.forEach(function(t) {
      registerTrigger(el, t);
    });
  });


  /// Start up

  /** @type {function(Event=): void} */
  function init(_e) {
    window.addEventListener('popstate', onpopstate);
    // Store HTML before going to other page
    window.addEventListener('beforeunload', storeCurrentState);
    activate(document.body);
    READY = true;
    console.debug('init done', _e);
  }

  onload(init);

  // this is done outside of `init` since that way we can restore HTML before
  // `DOMContentLoaded` has happened and browser will set correct scroll
  // location automatically
  if (window.performance && window.performance.navigation &&
      window.performance.navigation.type == window.performance.navigation.TYPE_BACK_FORWARD) {
    // Restore HTML when user came back to page from non-pushstate destination
    onpopstate({state: "initial"});
  }

  /// Public interface

  var twinspark = {
    onload:      onload,
    register:    register,
    activate:    activate,
    func:        registerCommands,
    elcrumbs:    elcrumbs,
    arity:       arity,
    data:        collectData,
    merge:       mergeParams,
    target:      findTarget, // DEPRECATED
    query:       findTarget,
    trigger:     sendEvent,
    parseAction: parseActionSpec,
    action:      doActions,
    exec:        executeCommand,
    makeReq:     makeReq,
    executeReqs: doReqBatch,
    morph:       morph,
    setERR:      (errhandler) => ERR = errhandler,
    _internal:   {DIRECTIVES: DIRECTIVES,
                  FUNCS: FUNCS,
                  init: init}
  };

  window[tsname] = twinspark;
})(window,document,'twinspark');
