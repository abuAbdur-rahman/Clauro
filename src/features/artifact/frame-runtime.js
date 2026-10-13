/*
 * The artifact frame's runtime. Emitted as source text into the published
 * artifact document (D123), where there is no module system, no bundler, and
 * no import of anything - including the Tauri API, which must stay unreachable
 * from inside the frame (D6). Every line here runs inside the sandbox.
 *
 * It provides, in order:
 *   - h() / Fragment: build DOM nodes directly. No React, no runtime library,
 *     because the only thing JSX needs from us is "make me this element" (D110).
 *   - __clauroRun(moduleExports, root): render a compiled artifact's default
 *     export. Compiled code is emitted as a real <script> tag carrying the
 *     nonce, so nothing here needs eval - and the frame's CSP does not need
 *     unsafe-eval either, which is the whole point of the nonce.
 *   - the navigation guard (D102), installed before any artifact code runs.
 *   - the handshake responder: claim the transferred port, say hello, and
 *     buffer reports made before the port arrives.
 */
(function () {
  "use strict";

  var FRAME_TO_HOST = {
    hello: "artifact.hello",
    log: "artifact.log",
    error: "artifact.error",
    nav: "artifact.nav_blocked",
  };

  var port = null;
  var pending = [];

  /* ---- outbound ------------------------------------------------------- */

  function report(message) {
    if (port) {
      port.postMessage(message);
      return;
    }
    // The artifact can run before the handshake completes. Buffer, then flush;
    // dropping a log line is better than losing the first error report.
    pending.push(message);
  }

  window.__clauroReport = function (message) {
    report({ type: FRAME_TO_HOST.error, text: String(message) });
  };

  function post(type, fields) {
    var message = fields || {};
    message.type = type;
    report(message);
  }

  /* ---- h() ------------------------------------------------------------ */

  var FRAGMENT = "#fragment";

  function Fragment(children) {
    return { fragment: FRAGMENT, children: flatten([children]) };
  }

  function flatten(items, out) {
    var acc = out || [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item === null || item === undefined || item === false) continue;
      if (Array.isArray(item)) {
        flatten(item, acc);
      } else {
        acc.push(item);
      }
    }
    return acc;
  }

  var SAFE_URL_SCHEMES = ["http:", "https:", "mailto:", "#"];
  var MEDIA_URL_SCHEMES = ["data:", "blob:"];

  /**
   * Attributes that carry a URL. 0 = strict http(s)/mailto/fragment/relative;
   * 1 = a data: or blob: URI is also allowed, because those slots load media
   * the CSP already governs to data:/blob: (D3). Navigation and fetch slots
   * (href, action, formaction, ping, object data) never take one.
   */
  var URL_ATTRS = {
    href: 0,
    src: 1,
    action: 0,
    formaction: 0,
    ping: 0,
    poster: 1,
    data: 0,
    srcset: 1,
    "xlink:href": 0,
  };

  function isSafeUrl(value, allowDataUri) {
    // The URL standard strips tab/LF/CR before it parses a scheme, so this
    // test has to strip them too: "jav\tascript:" would otherwise read as a
    // relative path — safe-looking, navigation-shaped (audit 14).
    var text = String(value)
      .replace(/[\t\n\r]/g, "")
      .trim()
      .toLowerCase();
    var schemes = allowDataUri ? SAFE_URL_SCHEMES.concat(MEDIA_URL_SCHEMES) : SAFE_URL_SCHEMES;
    for (var i = 0; i < schemes.length; i += 1) {
      if (text.indexOf(schemes[i]) === 0) return true;
    }
    // Relative paths and fragments resolve against this document; anything
    // carrying a scheme we do not know (javascript:, data:, vbscript:) does not.
    return !/^[a-z][a-z0-9+.-]*:/.test(text) || text.indexOf("#") === 0;
  }

  function applyProps(node, props) {
    if (!props) return;
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      // Prototype keys are never legitimate attributes; dropping them keeps a
      // JSON-shaped props object from taking the object-path route anywhere.
      if (key === "__proto__" || key === "constructor" || key === "prototype") return;
      if (key === "class" || key === "className") {
        node.setAttribute("class", String(value));
        return;
      }
      if (key === "style") {
        if (typeof value === "string") {
          node.setAttribute("style", value);
        } else {
          Object.keys(value).forEach(function (prop) {
            node.style.setProperty(prop, String(value[prop]));
          });
        }
        return;
      }
      if (key.indexOf("on") === 0 && key.length > 2) {
        if (typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        }
        // A string where a handler belongs is an inline handler: dropped,
        // never set as an attribute (audit 14).
        return;
      }
      var urlSlot = URL_ATTRS[key.toLowerCase()];
      if (urlSlot !== undefined && !isSafeUrl(value, urlSlot === 1)) {
        // Dropped, not rewritten: a javascript: href that survives as text is
        // a way back in.
        return;
      }
      // `dangerouslySetInnerHTML` is deliberately not supported: an artifact
      // that wants markup writes a node, and there is no back door for one
      // string to become markup behind the guard's back.
      if (key === "dangerouslySetInnerHTML") return;
      node.setAttribute(key, value === true ? "" : String(value));
    });
  }

  function toNode(child) {
    if (child === null || child === undefined || child === false) {
      return document.createComment("empty");
    }
    if (typeof child === "string" || typeof child === "number") {
      // A string child is text. There is no path in this runtime that turns a
      // string into markup, which is the whole reason for D110.
      return document.createTextNode(String(child));
    }
    if (typeof child === "object" && child.fragment === FRAGMENT) {
      var wrapper = document.createDocumentFragment();
      child.children.forEach(function (item) {
        wrapper.appendChild(toNode(item));
      });
      return wrapper;
    }
    if (child instanceof Node) return child;
    return document.createTextNode(String(child));
  }

  function h(tag, props) {
    var node = document.createElement(tag);
    applyProps(node, props);
    for (var i = 2; i < arguments.length; i += 1) {
      flatten([arguments[i]]).forEach(function (child) {
        node.appendChild(toNode(child));
      });
    }
    return node;
  }

  // Compiled artifact code calls `h` and `Fragment` as free variables (Sucrase
  // emits them as the JSX pragma), so they have to be globals in this
  // document. They are the frame's own globals — the artifact cannot see the
  // host's, and `h` builds DOM nodes the artifact could already build itself.
  window.h = h;
  window.Fragment = Fragment;
  window.__clauroArtifact = { h: h, Fragment: Fragment };

  /* ---- rendering a compiled artifact ---------------------------------- */

  window.__clauroRun = function (moduleExports, root) {
    try {
      var tree = moduleExports && moduleExports.default;
      if (typeof tree === "function") tree = tree();
      if (tree === null || tree === undefined) return;
      var target = root || document.getElementById("root");
      if (!target) return;
      var nodes = flatten([tree]).map(toNode);
      if (typeof target.replaceChildren === "function") {
        target.replaceChildren.apply(target, nodes);
      } else {
        target.innerHTML = "";
        nodes.forEach(function (node) {
          target.appendChild(node);
        });
      }
    } catch (error) {
      window.__clauroReport("artifact threw: " + (error && error.message));
    }
  };

  /* ---- navigation guard (D102) ---------------------------------------- */

  var ESCAPING_TARGETS = ["_top", "_parent", "_blank"];

  function blockedNavigationNote(anchor) {
    var target = anchor.getAttribute("target");
    if (target && ESCAPING_TARGETS.indexOf(target.toLowerCase()) >= 0) {
      return "blocked: target " + target;
    }
    // Stripped before the scheme test, exactly as the URL parser would
    // (audit 14): "jav&#x09;ascript:" must read as javascript:, not as a path.
    var href = (anchor.getAttribute("href") || "").replace(/[\t\n\r]/g, "").trim();
    if (href === "" || href.charAt(0) === "#") return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf("//") === 0) {
      return "blocked: " + href.slice(0, 80) + " leaves the artifact frame (D102)";
    }
    return null;
  }

  document.addEventListener(
    "click",
    function (event) {
      // "a,area": an image map's <area> navigates exactly like an anchor and
      // was outside the anchor-only guard (audit 14).
      var anchor = event.target && event.target.closest && event.target.closest("a,area");
      if (!anchor) return;
      var note = blockedNavigationNote(anchor);
      if (!note) return;
      event.preventDefault();
      post(FRAME_TO_HOST.nav, { text: note });
    },
    // Capture: an artifact's own listener must never get to navigate first.
    { capture: true },
  );

  document.addEventListener(
    "submit",
    function (event) {
      var action = (event.target && event.target.getAttribute("action")) || "";
      if (action.trim() === "") return;
      event.preventDefault();
      post(FRAME_TO_HOST.log, {
        level: "warn",
        text: "blocked: form submission to " + action.slice(0, 80) + " (D102)",
      });
    },
    { capture: true },
  );

  /* ---- self-navigation (audit 14, D102) ------------------------------- */

  /**
   * A meta refresh tag (`http-equiv` carrying `refresh`) navigates the frame
   * away from the document this host built. `prepare.ts` strips it from the
   * source; this is the same sweep one layer in, for whatever reaches the
   * document whole.
   */
  function stripMetaRefresh() {
    var metas = document.querySelectorAll("meta");
    for (var i = 0; i < metas.length; i += 1) {
      var meta = metas[i];
      var equiv = (meta.getAttribute("http-equiv") || "").toLowerCase();
      if (equiv === "refresh") {
        post(FRAME_TO_HOST.log, { level: "warn", text: "blocked: meta refresh removed (D102)" });
        if (meta.parentNode) meta.parentNode.removeChild(meta);
      }
    }
  }
  document.addEventListener("DOMContentLoaded", stripMetaRefresh);
  if (document.readyState !== "loading") stripMetaRefresh();

  // Popups are already refused by the sandbox flags; this turns the refusal
  // into a report instead of an engine-side silence (audit 14).
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: function () {
      post(FRAME_TO_HOST.log, {
        level: "warn",
        text: "blocked: window.open is not available inside the artifact frame (D102)",
      });
      return null;
    },
  });

  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigate", function (event) {
      var destination = event && event.destination;
      // Same-document navigation — fragments, history entries, pushState —
      // stays allowed; everything else would replace the document wholesale
      // with one this host never published (audit 14).
      if (destination && destination.sameDocument) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      post(FRAME_TO_HOST.nav, {
        text: "blocked: cross-document navigation refused inside the artifact frame (D102)",
      });
    });
  }

  /* ---- handshake (D6) -------------------------------------------------- */

  window.addEventListener("message", function (event) {
    var data = event.data;
    // The host's window, and only the host's window. Anything else speaking
    // this frame gets no port.
    if (event.source !== window.parent) return;
    // The origin half of the same check (D6): the shell is always a real
    // origin — "null" is an opaque document and "" is nobody, and neither can
    // be produced by the parent that hosts this frame.
    if (event.origin === "null" || event.origin === "") return;
    if (!data || data.type !== "artifact.boot") return;
    if (!event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = function (msg) {
      var inbound = msg.data;
      // The host sends exactly one other thing, and the frame acts on nothing.
      if (inbound && inbound.type === "artifact.dispose") {
        post(FRAME_TO_HOST.log, { level: "info", text: "artifact disposed" });
      }
    };
    port.start();
    pending.forEach(function (message) {
      port.postMessage(message);
    });
    pending = [];
    post(FRAME_TO_HOST.hello, {});
  });

  // The first contact is the frame's, and it goes to the shell: the host has
  // no reason to speak until asked, and this frame has no port until it asks.
  // "*" is the only value available — an opaque origin cannot name anyone,
  // which is the same reason the host's boot reply uses it (D122). The render
  // nonce the envelope wrote before this script ran rides along, and channel.ts
  // checks it against the document it published (D6): a page this frame
  // navigates to can say hello, but it cannot name that nonce.
  var hello = { type: FRAME_TO_HOST.hello };
  if (typeof window.__clauroHandshakeNonce === "string") {
    hello.nonce = window.__clauroHandshakeNonce;
  }
  window.parent.postMessage(hello, "*");

  window.onerror = function (message) {
    post(FRAME_TO_HOST.error, { text: String(message) });
  };
})();